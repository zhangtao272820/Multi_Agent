import { z } from 'zod'
import { safeJsonParse, parseFirstBalancedJsonObject } from '../shared/llmJson'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'
import type { ManagerInteractionMode } from '../../../utils/platform/managerInteractionMode'
import {
  clarifyThreshold,
  isProActionPlaneInferEnabled,
  isProAmbiguityPolicyEnabled,
  isProDataPlaneInferEnabled,
  isProTaskShapeEnabled,
  isProUnderstandEnabled
} from '../../../utils/platform/managerInteractionMode'
import type { LlmInvokeTier } from '../shared/modelTier'
import { routingDecisionLlmTier } from '../shared/modelTier'
import { resolveManagerEnvBool } from '../../../utils/platform/managerEnvModes'
import { isLlmFirstRouteEnabled } from '../../orchestrate/unifiedRouting'
import type { DataPlaneRoutingHint } from '../routing/dataPlaneRoutingHint'
import { shouldSuppressClarifyFromHint } from '../plan/clarifySuppress'

import {
  PreservedConstraintsSchema,
  InferredDataSourceSchema,
  StepDispatchDraftSchema,
  TaskShapeSchema,
  DataPlaneSchema,
  ActionPlaneSchema,
  AmbiguitySchema,
  ProPuStackUnifiedSchema,
  type PreservedConstraints,
  type InferredDataSource,
  type StepDispatchDraft
} from './schemas'

const TASK_SHAPE_VALUES = ['single_agent', 'linear_pipeline', 'multi_source_parallel', 'action_only'] as const
const TASK_INTENT_VALUES = ['structured_query', 'document_retrieval', 'hybrid', 'action', 'unknown'] as const
const PRIMARY_PLANE_VALUES = ['db', 'rag', 'crawler', 'admin', 'gui', 'none'] as const
const CLARIFY_RISK_VALUES = ['none', 'low', 'medium', 'high'] as const
const DISPATCH_AGENT_VALUES = new Set(['db', 'rag', 'crawler', 'admin', 'gui', 'clean', 'code', 'visualize', 'report'])

function asObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
}

function appendRationale(o: Record<string, unknown>, note: string): void {
  const prev = String(o.rationale || '').trim()
  o.rationale = [prev, note].filter(Boolean).join(' ').slice(0, 400)
}

function coerceBool(raw: unknown, fallback = false): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return fallback
  if (['true', '1', 'yes', '是'].includes(s)) return true
  if (['false', '0', 'no', '否'].includes(s)) return false
  return fallback
}

function normalizeDispatchAgentLiteral(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase()
  if (DISPATCH_AGENT_VALUES.has(s)) return s
  for (const agent of DISPATCH_AGENT_VALUES) {
    if (s.startsWith(`${agent}_`) || s.startsWith(`${agent}-`)) return agent
  }
  return null
}

/** 从 stepDispatchDraft / 布尔字段结构修复 LLM 写进枚举位的非法值（不用用户原话正则） */
function repairPuStackEnumsFromStructure(o: Record<string, unknown>): void {
  const draft = Array.isArray(o.stepDispatchDraft) ? o.stepDispatchDraft : []
  const agents = draft
    .map((d) => normalizeDispatchAgentLiteral((d as { agent?: string })?.agent))
    .filter(Boolean) as string[]
  const dataPlanes = agents.filter((a) => DATA_PLANE_AGENTS.has(a))
  const hasAdmin = agents.includes('admin')

  if (!TASK_SHAPE_VALUES.includes(String(o.taskShape) as (typeof TASK_SHAPE_VALUES)[number])) {
    if (dataPlanes.length >= 2) o.taskShape = 'multi_source_parallel'
    else if (agents.length === 1 && agents[0] === 'admin') o.taskShape = 'action_only'
    else if (agents.length <= 1) o.taskShape = 'single_agent'
    else o.taskShape = 'linear_pipeline'
  }

  if (!TASK_INTENT_VALUES.includes(String(o.taskIntent) as (typeof TASK_INTENT_VALUES)[number])) {
    if (dataPlanes.includes('db') && dataPlanes.includes('rag')) o.taskIntent = 'hybrid'
    else if (hasAdmin && dataPlanes.length >= 1) o.taskIntent = 'hybrid'
    else if (hasAdmin && !dataPlanes.length) o.taskIntent = 'action'
    else if (dataPlanes.includes('rag')) o.taskIntent = 'document_retrieval'
    else if (dataPlanes.includes('db')) o.taskIntent = 'structured_query'
    else o.taskIntent = 'unknown'
  }

  const primary = String(o.primaryPlane ?? '').trim()
  if (!PRIMARY_PLANE_VALUES.includes(primary as (typeof PRIMARY_PLANE_VALUES)[number]) || primary === 'hybrid') {
    if (primary === 'hybrid') o.taskIntent = o.taskIntent ?? 'hybrid'
    if (agents.includes('db') && agents.includes('rag')) o.primaryPlane = 'db'
    else if (agents.includes('rag')) o.primaryPlane = 'rag'
    else if (agents.includes('db')) o.primaryPlane = 'db'
    else if (agents.includes('admin')) o.primaryPlane = 'admin'
    else if (agents.includes('crawler')) o.primaryPlane = 'crawler'
    else o.primaryPlane = 'none'
  }

  if (!CLARIFY_RISK_VALUES.includes(String(o.clarifyRisk) as (typeof CLARIFY_RISK_VALUES)[number])) {
    const conf = Number(o.confidence ?? 0.65)
    if (agents.length >= 2) o.clarifyRisk = 'none'
    else if (agents.length === 0 && conf < 0.5) o.clarifyRisk = 'high'
    else if (coerceBool(o.hasExplicitSubject, false)) o.clarifyRisk = 'none'
    else o.clarifyRisk = 'low'
  }

  if (String(o.taskShape) === 'multi_source_parallel') {
    o.requiresAgentPipeline = coerceBool(o.requiresAgentPipeline, true)
  }
  if (coerceBool(o.wantsVisualize, false)) o.wantsVisualize = true
  if (coerceBool(o.wantsAdmin, false) || hasAdmin) o.wantsAdmin = true
}

/** LLM 常把任务描述写进枚举字段；结构修复为 schema 字面量 */
export function normalizeProPuStackUnifiedRaw(raw: unknown): Record<string, unknown> {
  const o = asObj(raw)

  for (const k of ['requiresAgentPipeline', 'wantsVisualize', 'wantsReport', 'wantsAdmin', 'hasExplicitSubject'] as const) {
    if (o[k] !== undefined) o[k] = coerceBool(o[k], k === 'requiresAgentPipeline')
  }

  if (Array.isArray(o.inferredDataSources)) {
    o.inferredDataSources = o.inferredDataSources
      .filter((x) => x && typeof x === 'object')
      .map((x) => {
        const row = { ...(x as Record<string, unknown>) }
        const plane = normalizeDispatchAgentLiteral(row.plane)
        row.plane = plane && PRIMARY_PLANE_VALUES.includes(plane) ? plane : 'rag'
        const conf = Number(row.confidence ?? 0.72)
        row.confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.72
        row.inferReason = String(row.inferReason || row.plane || 'inferred').slice(0, 240)
        return row
      })
      .slice(0, 6)
  }

  if (Array.isArray(o.stepDispatchDraft)) {
    o.stepDispatchDraft = o.stepDispatchDraft
      .filter((x) => x && typeof x === 'object')
      .map((x, i) => {
        const row = { ...(x as Record<string, unknown>) }
        const agent = normalizeDispatchAgentLiteral(row.agent)
        if (!agent) return null
        row.agent = agent
        row.scopedUserLanguage = String(row.scopedUserLanguage || row.query || row.text || '').trim().slice(0, 480)
        if (String(row.scopedUserLanguage).length < 2) {
          row.scopedUserLanguage = String(row.inferReason || row.agent || `子任务${i + 1}`).slice(0, 480)
        }
        return row
      })
      .filter(Boolean)
      .slice(0, 12)
  }

  repairPuStackEnumsFromStructure(o)

  for (const field of ['taskShape', 'taskIntent', 'primaryPlane', 'clarifyRisk'] as const) {
    const val = String(o[field] ?? '')
    const allowed =
      field === 'taskShape'
        ? (TASK_SHAPE_VALUES as readonly string[])
        : field === 'taskIntent'
          ? (TASK_INTENT_VALUES as readonly string[])
          : field === 'primaryPlane'
            ? (PRIMARY_PLANE_VALUES as readonly string[])
            : (CLARIFY_RISK_VALUES as readonly string[])
    if (!allowed.includes(val)) {
      appendRationale(o, `${field} repaired`)
    }
  }

  return o
}

function unifiedToProPuStackResult(data: z.infer<typeof ProPuStackUnifiedSchema>): ProPuStackResult {
  return {
    taskShape: {
      taskShape: data.taskShape,
      planShortcut: 'none',
      requiresAgentPipeline: data.requiresAgentPipeline,
      wantsVisualize: data.wantsVisualize,
      wantsReport: data.wantsReport,
      wantsAdmin: data.wantsAdmin,
      confidence: data.confidence,
      rationale: data.rationale
    },
    dataPlane: {
      inferredDataSources: data.inferredDataSources,
      preservedConstraints: data.preservedConstraints,
      taskIntent: data.taskIntent,
      primaryPlane: data.primaryPlane,
      hasExplicitSubject: data.hasExplicitSubject,
      clarifyRisk: data.clarifyRisk,
      confidence: data.confidence,
      rationale: data.rationale
    },
    actionPlane: {
      actionClauses: data.stepDispatchDraft
        .filter((d) => String(d.agent) === 'admin')
        .map((d) => ({
          kind: 'admin' as const,
          scopedText: d.scopedUserLanguage,
          confidence: data.confidence
        })),
      stepDispatchDraft: data.stepDispatchDraft,
      confidence: data.confidence
    },
    hintBlock: ''
  }
}

export type ProPuStackResult = {
  taskShape?: z.infer<typeof TaskShapeSchema>
  dataPlane?: z.infer<typeof DataPlaneSchema>
  actionPlane?: z.infer<typeof ActionPlaneSchema>
  ambiguity?: z.infer<typeof AmbiguitySchema>
  hintBlock: string
}

export function formatProPuStackHint(result: ProPuStackResult): string {
  const parts: string[] = ['【PU-Stack 读题】']
  if (result.taskShape) parts.push(`形态=${result.taskShape.taskShape}`)
  if (result.dataPlane?.taskIntent) parts.push(`数据面=${result.dataPlane.taskIntent}`)
  const draft = result.actionPlane?.stepDispatchDraft ?? []
  if (draft.length) parts.push(`draft=${draft.map((d) => d.agent).join('+')}`)
  return parts.join(' ')
}

export async function inferProPuStackUnified(input: {
  lastUser: string
  routingContext?: string
  probeHint?: string
  llmInvoke: LlmInvokeFn
  state: unknown
  onParseFail?: (detail: string) => void
}): Promise<ProPuStackResult | null> {
  const q = String(input.lastUser || '').trim()
  if (q.length < 4) return null
  const probe = String(input.probeHint || '').trim()
  const ctxBlock =
    isLlmFirstRouteEnabled() ? '' : input.routingContext ? `上下文（弱参考）：${input.routingContext.slice(0, 400)}` : ''
  let data = await invokeProJson(
    ProPuStackUnifiedSchema,
    [
      '你是专业工作台唯一读题路由（Plan-and-Execute 第一层）。只输出一个 JSON 对象，禁止 markdown。',
      '【枚举硬约束】以下字段只能是固定英文字面量，禁止自创标签或中文长句；详细说明只写 rationale：',
      '- taskShape: single_agent | linear_pipeline | multi_source_parallel | action_only',
      '- taskIntent: structured_query | document_retrieval | hybrid | action | unknown',
      '- primaryPlane: db | rag | crawler | admin | gui | none（hybrid 只能写在 taskIntent）',
      '- clarifyRisk: none | low | medium | high',
      '【数据面】structured_query→db；document_retrieval→rag；hybrid→db+rag 并列；出行/路线/地铁/多久→admin（未清晰要网页时）。',
      '【stepDispatchDraft】每个数据面/动作面一条，scopedUserLanguage 仅该 agent 子任务；仅用户末轮，勿继承上下文中未提及的人名/查库。',
      '【示例·RAG+联网】「对照知识库标准，网上查最新官方通知，汇总对比」→ taskShape=multi_source_parallel, inferred rag+crawler, 无 db/admin, draft 两条。',
      '【示例·RAG+DB+Admin】仅当用户末轮同时提到知识库、数据库记录、出行时长时才含 db/admin；禁止套用历史轮次任务。'
    ].join('\n'),
    [
      ctxBlock,
      probe ? `Probe（弱参考，勿扩大 cap）：${probe.slice(0, 320)}` : '',
      `【用户末轮·唯一权威】\n${q}`
    ]
      .filter(Boolean)
      .join('\n\n'),
    input.llmInvoke,
    input.state,
    input.onParseFail,
    normalizeProPuStackUnifiedRaw
  )
  if (!data) {
    data = await invokeProJson(
      ProPuStackUnifiedSchema,
      [
        '你是专业工作台读题路由。重试：只输出合法 JSON，枚举字段必须是固定英文字面量。',
        'taskShape 四选一；taskIntent 五选一；primaryPlane 六选一（禁止写 hybrid）；clarifyRisk 四选一。',
        '任务描述、步骤说明只能写在 rationale 或 stepDispatchDraft.scopedUserLanguage。'
      ].join('\n'),
      [
        ctxBlock,
        probe ? `Probe（弱参考）：${probe.slice(0, 320)}` : '',
        `【用户末轮·唯一权威】\n${q}`,
        '上次输出把中文长句写进了 taskShape/taskIntent/primaryPlane/clarifyRisk，请修正。'
      ]
        .filter(Boolean)
        .join('\n\n'),
      input.llmInvoke,
      input.state,
      input.onParseFail,
      normalizeProPuStackUnifiedRaw
    )
  }
  if (!data) return null
  const result = unifiedToProPuStackResult(data)
  result.hintBlock = formatProPuStackHint(result)
  return result
}

/** 专业读题：与编排 LLM 同档（plus/max），禁止 flash */
export function proPuStackLlmTier(state?: unknown, env: NodeJS.ProcessEnv = process.env): LlmInvokeTier {
  return routingDecisionLlmTier(state, env)
}

export async function invokeProJson<T extends z.ZodTypeAny>(
  schema: T,
  system: string,
  human: string,
  llmInvoke: LlmInvokeFn,
  state: unknown,
  onParseFail?: (detail: string) => void,
  normalize?: (raw: Record<string, unknown>) => Record<string, unknown>
): Promise<z.infer<T> | null> {
  try {
    const r = await llmInvoke(
      'route',
      state,
      [
        { role: 'system', content: system },
        { role: 'user', content: human }
      ],
      { tier: proPuStackLlmTier(state) }
    )
    const raw = String(r?.text || '').trim()
    if (!raw) {
      onParseFail?.('LLM 返回空文本')
      return null
    }
    let parsed = safeJsonParse(raw) ?? parseFirstBalancedJsonObject(raw)
    if (!parsed || typeof parsed !== 'object') {
      onParseFail?.(`JSON 解析失败（${raw.slice(0, 80)}…）`)
      return null
    }
    if (normalize) {
      parsed = normalize(parsed as Record<string, unknown>)
    }
    let result = schema.safeParse(parsed)
    if (!result.success && normalize) {
      parsed = normalize(parsed as Record<string, unknown>)
      result = schema.safeParse(parsed)
    }
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join('; ')
      onParseFail?.(`schema 校验失败: ${issues}`)
      return null
    }
    return result.data
  } catch (e) {
    onParseFail?.(`invoke 异常: ${String((e as Error)?.message || e)}`)
    return null
  }
}

export async function inferProTaskShape(input: {
  lastUser: string
  routingContext?: string
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<z.infer<typeof TaskShapeSchema> | null> {
  if (!isProTaskShapeEnabled()) return null
  const q = String(input.lastUser || '').trim()
  if (q.length < 4) return null
  return invokeProJson(
    TaskShapeSchema,
    [
      '你是专业工作台 TaskShape 推断器。判断任务形态，只输出 JSON。',
      'taskShape: single_agent | linear_pipeline | multi_source_parallel | action_only',
      'requiresAgentPipeline: 单源简单查数/检索且无图表报告 → false；多源/对比/图表/报告 → true',
      'wantsVisualize: 用户要图表/可视化/出图 → true',
      'wantsReport: 用户要写报告 → true',
      'wantsAdmin: 并列办公/出行/天气/日程/路线时长等 → true',
      '示例：「知识库查配比，数据库查记录，对比出图」→ multi_source_parallel, wantsVisualize=true',
      '示例：「…对比出图；并告诉我从A到B多久」→ wantsAdmin=true',
      'schema: {"taskShape":"...","planShortcut":"...","requiresAgentPipeline":bool,"wantsVisualize":bool,"wantsReport":bool,"wantsAdmin":bool,"confidence":0~1,"rationale":"..."}'
    ].join('\n'),
    `${input.routingContext || ''}\n\n用户：${q}`,
    input.llmInvoke,
    input.state
  )
}

export async function inferProDataPlane(input: {
  lastUser: string
  routingContext?: string
  probeHint?: string
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<z.infer<typeof DataPlaneSchema> | null> {
  if (!isProDataPlaneInferEnabled()) return null
  const q = String(input.lastUser || '').trim()
  if (q.length < 4) return null
  const probe = String(input.probeHint || '').trim()
  return invokeProJson(
    DataPlaneSchema,
    [
      '你是专业工作台 DataPlane 推断器。领域无关：按任务形态推断 db/rag/crawler/admin。',
      '- structured_query+db：库表行/聚合（统计/列表/记录/档案）；须对照库存表能否覆盖',
      '- document_retrieval+rag：文档/手册/报告原文；须对照库存文档能否覆盖；听起来像个人情况≠默认 db',
      '- hybrid：并列库表+文档；inferredDataSources 含 db 与 rag',
      '- hybrid+action：并列取数+出行/天气/订会 → 含 admin；天气预报是 admin.get_weather，不是 crawler',
      '- 网页政策/公告/新闻 → crawler；城市天气预报 → admin',
      '- 两地通行时长/从A到B → admin，不是 db/rag',
      'hasExplicitSubject：有具体姓名/编号时为 true',
      'clarifyRisk=high 仅当缺关键范围；单源明确取数应为 none/low',
      'outputFormat: chart/report 等写入 preservedConstraints',
      'schema: {"inferredDataSources":[],"taskIntent":"...","primaryPlane":"...","hasExplicitSubject":bool,"clarifyRisk":"...","preservedConstraints":{},"confidence":0~1,"rationale":"..."}'
    ].join('\n'),
    [probe ? `Probe（弱参考）：${probe.slice(0, 400)}` : '', `用户：${q}`].filter(Boolean).join('\n\n'),
    input.llmInvoke,
    input.state
  )
}

export async function inferProActionPlane(input: {
  lastUser: string
  clausesHint?: string
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<z.infer<typeof ActionPlaneSchema> | null> {
  if (!isProActionPlaneInferEnabled()) return null
  const q = String(input.lastUser || '').trim()
  if (q.length < 4) return null
  return invokeProJson(
    ActionPlaneSchema,
    [
      '你是 ActionPlane 推断器。分离 Admin/GUI 与取数子句。',
      'admin：地铁/公交/路线/多久/从A到B/天气/气温/预报/订会/日程（get_weather，不是 crawler）',
      'stepDispatchDraft: 每 agent 独立 scopedUserLanguage，禁止整段用户原话',
      '复合任务须 rag/db/admin 各一条；对比/出图由 code/visualize 处理',
      '只输出 JSON。'
    ].join('\n'),
    `${input.clausesHint || ''}\n\n用户：${q}`.trim(),
    input.llmInvoke,
    input.state
  )
}

export function formatPuContextForActionPlane(
  dataPlane: z.infer<typeof DataPlaneSchema> | null | undefined,
  taskShape: z.infer<typeof TaskShapeSchema> | null | undefined
): string {
  const parts: string[] = []
  if (taskShape) {
    parts.push(
      `TaskShape: ${taskShape.taskShape} pipeline=${taskShape.requiresAgentPipeline} viz=${taskShape.wantsVisualize} admin=${taskShape.wantsAdmin}`
    )
  }
  if (dataPlane) {
    parts.push(`DataPlane: ${dataPlane.taskIntent} primary=${dataPlane.primaryPlane}`)
    if (dataPlane.inferredDataSources?.length) {
      parts.push(
        `inferred: ${dataPlane.inferredDataSources.map((d) => `${d.plane}@${d.confidence.toFixed(2)}`).join(', ')}`
      )
    }
  }
  return parts.join('\n')
}

export const DATA_PLANE_AGENTS = new Set(['db', 'rag', 'crawler'])
export const DISPATCH_AGENTS = new Set(['db', 'rag', 'crawler', 'admin'])

export const PLANE_DISPATCH_HINT: Record<string, string> = {
  db: '查询业务库结构化记录与统计',
  rag: '检索知识库文档与政策标准',
  crawler: '检索公网网页信息',
  admin: '办公出行、天气预报与地图路线类事务'
}

export function mergeStepDispatchDraft(pu: ProPuStackResult): StepDispatchDraft[] {
  const draft = [...(pu.actionPlane?.stepDispatchDraft ?? [])]
  for (const ac of pu.actionPlane?.actionClauses ?? []) {
    if (ac.kind === 'admin' && String(ac.scopedText || '').trim().length >= 4) {
      if (!draft.some((d) => String(d.agent) === 'admin')) {
        draft.push({
          agent: 'admin',
          scopedUserLanguage: String(ac.scopedText).trim().slice(0, 480),
          clauseIds: [`c${draft.length + 1}`]
        })
      }
    }
  }
  return draft
}
