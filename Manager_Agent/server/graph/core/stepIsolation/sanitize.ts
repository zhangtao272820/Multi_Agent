/** 步骤 query 结构化净化与 LLM 裁剪。SSOT：skills/step_sanitize/skill.md */
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { adminStepQueryPreamble } from '#agent-shared/adminCapabilities'
import { safeJsonParse } from '../shared'
import { appendSerpContextToQuery } from '../../../utils/search/managerWebSearch'
import { stripAdminManagerGuards } from '../../../utils/route/managerSubAgentHelpers'
import { rematerializeWeatherCrawlerPlanSteps } from '../../orchestrate/weatherAdminBoundary'
import { rematerializeMapCrawlerPlanSteps } from '../../orchestrate/mapAdminBoundary'
import type { Step } from '../../../utils/shared/taskPlan'
import { isAdminReadOnlyOrchestrationStep } from '../db/writeGate'
import { getStepSanitizeLlmSystem } from '../evolution/playbookPrompts'

const STEP_SANITIZE_LLM_FALLBACK =
  '你是任务步骤 query 裁剪器。每个 step 的 query 只能描述该 agent 自己的职责。只输出 JSON：{"steps":[{"id":"...","query":"..."}]}'

export const DATA_SOURCE_AGENTS = new Set<Step['agent']>(['rag', 'db', 'crawler'])
/** 执行类 Agent：不应继承数据检索步骤的 missing/澄清 */
export const ACTION_EXEC_AGENTS = new Set<Step['agent']>(['admin', 'music', 'video', 'multimodal'])

const ADMIN_TERMS = [
  '日程',
  '邮件',
  '会议',
  '待办',
  '提醒',
  '预约',
  '安排',
  '创建',
  '设置',
  '添加',
  '跟进',
  '天气',
  '气温',
  '预报',
  '穿衣'
]
/** 高德/出行相关表述（词表兜底；主路由由 LLM + admin_capabilities playbook） */
const ADMIN_MAP_TERMS = [
  '路线',
  '多久',
  '多久到',
  '导航',
  '附近',
  '周边',
  '地图',
  '地址',
  '坐标',
  '怎么走',
  '通勤',
  '地铁',
  '公交',
  '驾车',
  '步行',
  '骑行',
  '到站',
  '车程',
  '多远',
  '出行',
  '定位',
]
const EXECUTION_HINTS = ['只处理', '仅处理', '勿执行', '不要执行', '不要追问', '直接创建', '直接安排']

/** 数据源步骤应剥离的「下游/事务」噪声词 */
const DATA_PLANE_NOISE = [
  '画图',
  '图表',
  '可视化',
  'echarts',
  '报告',
  '分析报告',
  '总结报告',
  '写报告',
  '日程',
  '邮件',
  '会议',
  '待办',
  '提醒',
  '预约',
  '安排会议',
  '创建会议'
]

/** code 步骤应剥离的事务类表述 */
const CODE_ADMIN_NOISE = ['邮件', '日程', '会议', '待办', '提醒', '预约', '跟进']

/** visualize/report 应剥离的取数表述（保留分析/呈现诉求） */
const VIZ_REPORT_DATA_NOISE = ['从知识库', '从数据库', '知识库检索', '数据库查询', 'sql查询', '抓取网页', '爬虫']

type StepSanitizeStrategy = {
  noiseTerms: string[]
  maxLen?: number
  llmWhenLongerThan?: number
  llmWhenNoiseRemains?: boolean
  transform?: (query: string, step: Step) => string
}

const STEP_SANITIZE_STRATEGIES: Partial<Record<Step['agent'], StepSanitizeStrategy>> = {
  admin: {
    noiseTerms: [],
    llmWhenLongerThan: 200,
    /** 计划内只存 lean 子句；preamble 仅在 buildAdminExecMessage 出站注入 */
    transform: (q) => extractAdminSubtaskText(q)
  },
  rag: {
    noiseTerms: DATA_PLANE_NOISE,
    maxLen: 520,
    llmWhenLongerThan: 280,
    llmWhenNoiseRemains: true
  },
  db: {
    noiseTerms: DATA_PLANE_NOISE,
    maxLen: 520,
    llmWhenLongerThan: 280,
    llmWhenNoiseRemains: true
  },
  crawler: {
    noiseTerms: DATA_PLANE_NOISE,
    maxLen: 520,
    llmWhenLongerThan: 280,
    llmWhenNoiseRemains: true
  },
  code: {
    noiseTerms: CODE_ADMIN_NOISE,
    maxLen: 640,
    llmWhenLongerThan: 360,
    llmWhenNoiseRemains: true,
    transform: (q) =>
      q
        .replace(/邮件/g, '任务')
        .replace(/日程/g, '任务')
  },
  visualize: {
    noiseTerms: VIZ_REPORT_DATA_NOISE,
    maxLen: 480,
    llmWhenNoiseRemains: true
  },
  report: {
    noiseTerms: VIZ_REPORT_DATA_NOISE,
    maxLen: 560,
    llmWhenNoiseRemains: true
  },
  clean: {
    noiseTerms: ['画图', '图表', 'echarts', '邮件', '日程', '会议', '提醒', '待办', '添加', '预约'],
    maxLen: 480
  },
  multimodal: {
    noiseTerms: [...DATA_PLANE_NOISE, '写代码', 'sql'],
    maxLen: 520
  },
  music: {
    noiseTerms: [...DATA_PLANE_NOISE, '画图', '图表', 'echarts', '写报告'],
    maxLen: 420
  },
  video: {
    noiseTerms: [...DATA_PLANE_NOISE, '画图', '图表', '邮件', '日程'],
    maxLen: 480
  }
}

export const MEDIA_EXEC_AGENTS = new Set<Step['agent']>(['multimodal', 'music', 'video'])

export const MEDIA_EXEC_GUARDS: Record<'multimodal' | 'music' | 'video', string> = {
  multimodal:
    '【总管约束】只描述附件/图片中可见的内容（人物外观、场景、文字 OCR 等）；禁止根据会话历史、数据库人名或知识库给人物起名；用户未问「是谁/姓名」时不得写「名为…/叫做…」；勿扩展为数据库检索、知识库查询或日程/邮件事务。',
  music: '【总管约束】只生成音乐/BGM/旋律；勿混入数据查询、图表或报告撰写。',
  video: '【总管约束】只根据描述生成短视频；勿混入数据库/知识库检索或其它 agent 职责。'
}

export function isStepSanitizeLlmEnabled() {
  return String(process.env.MANAGER_STEP_SANITIZE_LLM ?? '0').trim() !== '0'
}

function normalizeText(text: string): string {
  const chars = String(text || '').trim().toLowerCase()
  let out = ''
  let lastWasSpace = false
  for (const ch of chars) {
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u3000'
    if (isSpace) {
      if (!lastWasSpace) out += ' '
      lastWasSpace = true
      continue
    }
    out += ch
    lastWasSpace = false
  }
  return out
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t.toLowerCase()))
}

function splitIntoChunks(text: string): string[] {
  const raw = String(text || '').trim()
  if (!raw) return []
  // 中文复合问句几乎无空格：先按标点切分，再按空格兜底
  const clauseParts: string[] = []
  let cur = ''
  for (const ch of raw) {
    if (ch === '，' || ch === '。' || ch === '；' || ch === ';' || ch === '、' || ch === '\n') {
      if (cur.trim()) clauseParts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) clauseParts.push(cur.trim())
  const base = clauseParts.length > 1 ? clauseParts : [raw]
  const out: string[] = []
  for (const part of base) {
    const segments = part.split(/\s+/).filter(Boolean)
    if (segments.length <= 1) {
      out.push(part)
      continue
    }
    let current = ''
    for (const seg of segments) {
      const next = current ? `${current} ${seg}` : seg
      if (next.length > 40) {
        if (current) out.push(current)
        current = seg
      } else {
        current = next
      }
    }
    if (current) out.push(current)
  }
  return out.length ? out : [raw]
}

function isDataPlaneOnlySegment(text: string): boolean {
  const s = normalizeText(text)
  if (!s) return false
  const dataOnly = ['知识库', '检索', '数据库', '图表', '对比图', '画图', '清洗', '计算数据', '撰写报告', '提炼要点']
  const hasData = includesAny(s, dataOnly)
  const hasAdmin =
    includesAny(s, ADMIN_TERMS) || includesAny(s, ADMIN_MAP_TERMS) || includesAny(s, EXECUTION_HINTS)
  return hasData && !hasAdmin
}

function isNoiseSegment(text: string, noiseTerms: string[]): boolean {
  const s = normalizeText(text)
  if (!s) return false
  return includesAny(s, noiseTerms.map((t) => t.toLowerCase()))
}

/** 按块剔除含噪声词的片段（不用正则） */
export function stripNoiseFromQuery(text: string, noiseTerms: string[]): string {
  const raw = String(text || '').trim()
  if (!raw || !noiseTerms.length) return raw
  const chunks = splitIntoChunks(raw)
  const kept = chunks.filter((c) => !isNoiseSegment(c, noiseTerms))
  if (kept.length >= 1 && kept.length < chunks.length) {
    return kept.join('，').trim()
  }
  return raw
}

function truncateQuery(text: string, maxLen: number): string {
  const s = String(text || '').trim()
  if (!maxLen || s.length <= maxLen) return s
  return `${s.slice(0, maxLen - 1)}…`
}

function stepNeedsLlmTrim(step: Step, structuredQuery: string, strategy: StepSanitizeStrategy): boolean {
  if (!isStepSanitizeLlmEnabled()) return false
  const q = String(structuredQuery || '').trim()
  if (!q) return false
  if (strategy.llmWhenLongerThan && q.length > strategy.llmWhenLongerThan) return true
  if (strategy.llmWhenNoiseRemains && strategy.noiseTerms.length && includesAny(normalizeText(q), strategy.noiseTerms)) {
    return true
  }
  return false
}

function isAdminPreambleChunk(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (t.startsWith('仅处理下列个人助理能力')) return true
  if (t.startsWith('勿混入')) return true
  if (t.startsWith('会议与日程须')) return true
  if (t.startsWith('路线/地图')) return true
  if (t.startsWith('用户说「从这')) return true
  if (t.startsWith('若已给出会议')) return true
  if (t.startsWith('· ')) return true
  if (t.startsWith('【总管')) return true
  if (t.startsWith('（强制）')) return true
  if (t.startsWith('已知信息（来自上游')) return true
  return false
}

function isAdminSegment(text: string): boolean {
  const s = normalizeText(text)
  if (!s) return false
  if (isAdminPreambleChunk(text)) return false
  if (isDataPlaneOnlySegment(text)) return false
  return (
    includesAny(s, ADMIN_TERMS) ||
    includesAny(s, ADMIN_MAP_TERMS) ||
    includesAny(s, EXECUTION_HINTS)
  )
}

/** 会议标题碎片（本身不含 ADMIN_TERMS，须与相邻会议段一并保留） */
function isMeetingTitleSegment(text: string): boolean {
  const t = String(text || '').trim()
  if (!t || isAdminPreambleChunk(t) || isDataPlaneOnlySegment(t)) return false
  if (t.includes('标题为') || t.includes('标题：') || t.includes('标题:')) return true
  if ((t.includes('「') && t.includes('」')) || (t.includes('『') && t.includes('』'))) return true
  return false
}

/**
 * 尽量让模型在上游规划阶段就把 admin 子任务拆干净；这里仅做最小的结构化兜底，不用正则。
 * 先剥总管 preamble/guard，再按块保留会议/提醒段及相邻标题块。
 */
export function extractAdminSubtaskText(text: string): string {
  const stripped = stripAdminManagerGuards(text)
  const raw = (stripped || String(text || '').trim()).trim()
  if (!raw) return raw
  // 纯 preamble 不得当作可执行子句
  if (isAdminPreambleChunk(raw) && !includesAny(normalizeText(raw), ['创建', '安排', '添加', '设置', '会议', '提醒', '待办', '天气', '路线'])) {
    return ''
  }
  const chunks = splitIntoChunks(raw)
  const keepIdx = new Set<number>()
  chunks.forEach((c, i) => {
    if (isAdminSegment(c)) keepIdx.add(i)
  })
  // 与会议段相邻的「标题为「…」」一并保留
  chunks.forEach((c, i) => {
    if (!isMeetingTitleSegment(c)) return
    if (keepIdx.has(i - 1) || keepIdx.has(i + 1) || keepIdx.size === 0) keepIdx.add(i)
  })
  if (keepIdx.size >= 1 && keepIdx.size < chunks.length) {
    return chunks.filter((_, i) => keepIdx.has(i)).join('，')
  }
  // 单块复合句：剔除纯取数/出图片段后重试
  if (chunks.length === 1 && raw.length > 36) {
    const refined = chunks.filter((c) => !isDataPlaneOnlySegment(c) && (isAdminSegment(c) || isMeetingTitleSegment(c)))
    if (refined.length) return refined.join('，')
  }
  // 已剥 guard 的纯任务句直接返回
  if (stripped && !isAdminPreambleChunk(stripped)) return stripped
  return raw
}

/** 是否主要为地图/出行诉求（供短路规划参考；主判定仍由路由 LLM） */
export function adminStepIsMapQuery(query: string): boolean {
  const q = normalizeText(query)
  if (!q) return false
  return includesAny(q, ADMIN_MAP_TERMS)
}

/** admin 是否必须等 rag/db/crawler 结果（例如「根据检索结果安排会议」） */
export function adminStepNeedsUpstreamData(query: string): boolean {
  const q = normalizeText(query)
  if (!q) return false
  const adminAction = includesAny(q, ADMIN_TERMS) || includesAny(q, EXECUTION_HINTS)
  const upstreamHint = ['根据', '基于', '结合', '依据', '参考', '结果', '报告', '分析', '知识库', '数据库', '抓取', '文档']
  return adminAction && includesAny(q, upstreamHint)
}

/** code / visualize / report 是否应挂上游数据/清洗步骤 */
const PROCESSING_UPSTREAM_HINTS = [
  '根据',
  '结合',
  '对比',
  '计算',
  '汇总',
  '生成',
  '分析',
  '整理',
  '报告',
  '基于',
  '依据'
]

export function processingStepNeedsUpstreamDeps(query: string): boolean {
  const q = normalizeText(query)
  if (!q) return false
  return includesAny(q, PROCESSING_UPSTREAM_HINTS)
}

/** admin 是否应等待 code/report/visualize/clean 的加工结果 */
const ADMIN_DERIVED_HINTS = ['结果', '分析', '结论', '汇总', '计算', '口径', '报告', '图表']

export function adminStepNeedsDerivedProcessing(query: string): boolean {
  const q = normalizeText(query)
  if (!q) return false
  return includesAny(q, ADMIN_DERIVED_HINTS)
}

/** 执行类 Agent 上游 preview 中的澄清/追问噪声 */
const CLARIFY_PREVIEW_TERMS = [
  '需要补充',
  '需要确认',
  '请提供',
  '请选择',
  '请指定',
  '澄清',
  '参会人',
  '会议平台',
  '请补充',
  '待确认'
]

export function isUpstreamClarifyNoise(preview: string): boolean {
  const q = normalizeText(preview)
  if (!q) return false
  return includesAny(q, CLARIFY_PREVIEW_TERMS)
}

function agentStepIds(
  agents: Step['agent'][],
  firstIdByAgent: Partial<Record<Step['agent'], string>>
): string[] {
  return agents.map((a) => firstIdByAgent[a]).filter((x): x is string => Boolean(x))
}

/** 保留 API；依赖拓扑由 Planner LLM 全权决定 */
export function inferStepDependsOn(
  _step: Step,
  _firstIdByAgent: Partial<Record<Step['agent'], string>>
): string[] | undefined {
  return undefined
}

/**
 * 出站包装：lean 子任务 + 能力 preamble（仅 WS/exec 使用；禁止写入 plan step.query）。
 */
export function buildAdminStepQuery(fullText: string, _sourceAgents: string[] = []): string {
  const adminTask = extractAdminSubtaskText(fullText)
  if (!adminTask) return adminStepQueryPreamble()
  return [adminStepQueryPreamble(), adminTask].join('\n')
}

/** 策略表结构化净化（同步、确定性） */
export function sanitizeStepQueryStructured(step: Step, agent: Step['agent'] = step.agent): string {
  const currentQuery = String(step.query || '').trim()
  if (!currentQuery) return currentQuery

  const strategy = STEP_SANITIZE_STRATEGIES[agent]
  if (!strategy) return currentQuery

  let out = stripNoiseFromQuery(currentQuery, strategy.noiseTerms)
  if (strategy.transform) out = strategy.transform(out, step).trim()
  if (strategy.maxLen) out = truncateQuery(out, strategy.maxLen)
  return out.trim() || currentQuery
}

export function sanitizeStepQueryForAgent(step: Step, agent: Step['agent'] = step.agent): Step {
  const currentQuery = String(step.query || '').trim()
  if (!currentQuery) return step
  const cleaned = sanitizeStepQueryStructured(step, agent)
  if (!cleaned || cleaned === currentQuery) return step
  return { ...step, query: cleaned }
}

export function sanitizePlanForAgent(plan: Step[], agent: Step['agent']): Step[] {
  return plan.map((step) => sanitizeStepQueryForAgent(step, agent))
}

export type SanitizePlanOpts = {
  llmInvoke?: (
    stage: 'route' | 'plan' | 'synth' | 'critic',
    state: any,
    messages: any[],
    options?: { tier?: 'light' | 'standard' }
  ) => Promise<{ text: string; resources?: any; meta?: any }>
  state?: any
  userTask?: string
  lowCostMode?: boolean
}

/** 对需 LLM 裁剪的步骤批量回填 query（结构化规则为兜底） */
export async function llmRefineStepQueries(
  plan: Step[],
  opts: SanitizePlanOpts
): Promise<Step[]> {
  const { llmInvoke, state, userTask, lowCostMode } = opts
  if (!llmInvoke || !state || lowCostMode || !isStepSanitizeLlmEnabled()) return plan

  const candidates: Array<{ id: string; agent: Step['agent']; query: string }> = []
  for (const step of plan) {
    const agent = step.agent
    const strategy = STEP_SANITIZE_STRATEGIES[agent]
    if (!strategy) continue
    const structured = sanitizeStepQueryStructured(step, agent)
    if (!stepNeedsLlmTrim(step, structured, strategy)) continue
    candidates.push({
      id: String(step.id || `${agent}_${candidates.length}`),
      agent,
      query: structured
    })
  }
  if (!candidates.length) return plan

  const prompt = [
    new SystemMessage(getStepSanitizeLlmSystem(STEP_SANITIZE_LLM_FALLBACK)),
    new HumanMessage(
      [
        `用户总任务：${String(userTask || '').slice(0, 600)}`,
        `待裁剪步骤：${JSON.stringify(candidates)}`,
        '输出 JSON：'
      ].join('\n')
    )
  ]

  try {
    const r = await llmInvoke('plan', state, prompt, { tier: 'light' })
    const parsed = safeJsonParse(String(r.text ?? '').trim()) as { steps?: Array<{ id?: string; query?: string }> } | null
    const refined = Array.isArray(parsed?.steps) ? parsed!.steps! : []
    if (!refined.length) return plan

    const byId = new Map<string, string>()
    for (const row of refined) {
      const id = String(row.id || '').trim()
      const q = String(row.query || '').trim()
      if (id && q.length >= 4) byId.set(id, q)
    }
    if (!byId.size) return plan

    return plan.map((step) => {
      const id = String(step.id || '').trim()
      const q = id ? byId.get(id) : undefined
      if (!q) return step
      const fallback = sanitizeStepQueryStructured({ ...step, query: q }, step.agent)
      return { ...step, query: fallback || q }
    })
  } catch {
    return plan
  }
}

/** 结构化净化 + 可选 LLM 回填（Planner 统一出口） */
export async function sanitizePlanSteps(plan: Step[], opts?: SanitizePlanOpts): Promise<Step[]> {
  // 计划出口硬闸：crawler 步若仍是天气/地图语义 → admin（堵住 web-align/Planner 回填）
  const weatherFixed = rematerializeWeatherCrawlerPlanSteps(plan)
  const mapFixed = rematerializeMapCrawlerPlanSteps(weatherFixed)
  const structured = mapFixed.map((step) => sanitizeStepQueryForAgent(step, step.agent))
  if (!opts?.llmInvoke || !opts.state) return structured
  return llmRefineStepQueries(structured, opts)
}
