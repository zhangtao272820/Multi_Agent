/**
 * D1/D2：用户态回复载荷 — 主列只给人看中文模块结论，专才原文留给开发视图。
 * 确定性组装；禁止把 agent id / (ok) / agent_result 等开发者腔塞进 summary。
 */
import { parseCleanPayload } from '#agent-shared/cleanPayload'
import {
  isRenderableChartOption,
  readChartTitle,
  readEchartsOptionJsonFromVisualizeText
} from '#agent-shared/chartOption'
import {
  looksLikeExecAuditDump,
  looksLikeStepDumpSummary,
  looksLikeTruncatedSummary,
  stripPhaseStepLabels,
  stripStructuredExecReport,
  stripSynthPromptLeakage,
  isReportTierSummaryTooThin
} from '#agent-shared/synthOutputSanitize'

import type { SpecialistHandoff } from '../../../utils/agents/types'
import { buildActionCardsFromHumanConfirm } from './actionCard'
import { buildMemoryCaptureAckText } from '../routing/orchestrationThickness'
import type { MemoryMetaIntentParsed } from '../memory/memoryMetaIntent'

export { looksLikeStepDumpSummary, looksLikeTruncatedSummary, stripPhaseStepLabels }
export { looksLikeExecAuditDump, stripStructuredExecReport }

/** 与 synthShapePolicy / dbPipeline 对齐：≥2 个数据面专才有输出即多源 */
function isMultiSourceDataPipeline(results?: Record<string, unknown> | null): boolean {
  if (!results || typeof results !== 'object') return false
  const hits = ['db', 'rag', 'crawler', 'code'].filter((k) => String(results[k] ?? '').trim().length > 0)
  return hits.length >= 2
}

export type UserFacingOutcome = 'completed' | 'failed' | 'needs_human'

export type UserFacingMetric = { label: string; value: string }

export type UserFacingActionCard = {
  id: string
  kind: 'admin_write' | 'admin_read_result' | 'gui_automate'
  title: string
  summary: string
  risk: 'low' | 'mid' | 'high'
  status: 'proposed' | 'awaiting_confirm' | 'dry_run' | 'running' | 'done' | 'failed' | 'cancelled'
  preview?: {
    screenshotUrl?: string
    pageUrl?: string
    fields?: Array<{ label: string; value: string }>
  }
  failureReasonZh?: string
}

/** 与正文 [n] 角标对齐的统一来源卡 */
export type UserFacingSource = {
  index: number
  title: string
  url?: string
  excerpt?: string
  kind?: 'web' | 'rag' | 'db' | 'doc'
}

import {
  applyPresentationToSlots,
  isPresentationPlanActive,
  presentationPlanFromMeta,
  resolveEffectiveReplyTier,
  shouldIncludeReportAppendix,
  shouldShowHeadline,
  shouldShowSources,
  type PresentationPlan,
  type PresentationReplyTier
} from '#agent-shared/presentationPlan'
import { buildReplyArtifactSlots } from '#agent-shared/presentationSurfaces'
import {
  tableFromDbEvidence,
  scrubProsePreservingTableData,
  collectDbSchemaIdentifiers,
  structuredTableHasValues
} from './dbExpertDataBlock'
import { tableDataBlockHasValues } from '#agent-shared/auxBlocks'

/** 用户态回复文体档位（Presentation Plan LLM 优先，结构信号兜底） */
export type ReplyTier = PresentationReplyTier

export type UserFacingPayload = {
  summary: string
  /** 顶栏一行结论（确定性截取，非二次 LLM） */
  headline?: string
  metrics?: UserFacingMetric[]
  chart?: { title: string; option: object }
  table?: { headers: string[]; rows: string[][] }
  actions?: UserFacingActionCard[]
  appendix?: string
  sources?: UserFacingSource[]
  outcome?: UserFacingOutcome
  outcomeLabel?: string
  /** U3：无证据拒答徽章 */
  badge?: 'evidence_rejected' | 'needs_clarify'
  badgeLabel?: string
  /** 本轮用户态回复档位（可选，供前端/观测） */
  replyTier?: ReplyTier
  /** Cursor 式 follow-up chips（来自 Presentation Plan LLM） */
  suggestions?: string[]
  /** Cursor 式展示编排 SSOT（供前端按模块渲染） */
  presentationPlan?: PresentationPlan
  /** Cursor Artifact 面板 slot 描述（chart/table/report + surface） */
  artifacts?: Array<{
    id: string
    kind: 'chart' | 'table' | 'report'
    title: string
    surface: 'inline' | 'artifact_panel'
    collapsed?: boolean
  }>
  /** Canvas 中用户已编辑并应用报告 */
  reportEdited?: boolean
  reportEditedAt?: string
  /** 气泡内短注（与 appendix 分离，幂等） */
  reportRevisionNote?: string
}

const DEVELOPER_JARGON_RE =
  /\b(agent_result|needs_clarify|error_code|rawRef|evidenceRefs|structuredRunReport)\b/i
const OK_MARK_RE = /\(ok\)|\(OK\)|\bok\b/gi
const AGENT_ID_LINE_RE =
  /^(?:from\s*=\s*)?(db|rag|crawler|code|clean|visualize|report|admin|gui|multimodal|music|video|multi)\s*[：:]\s*/i
const CTX_MARK_RE = /\[CTX:[^\]]*\]/gi

/** 常见技术字段 → 中文（结构化结果映射，非用户原话意图识别） */
const FIELD_LABEL_ZH: Record<string, string> = {
  male: '男性',
  female: '女性',
  total: '合计',
  count: '数量',
  new_source_count: '新增来源数',
  source_count: '来源数',
  row_count: '行数',
  person_count: '人数',
  avg: '平均值',
  sum: '总和',
  ratio: '占比'
}

/** 剥离开发者腔（确定性，非意图识别） */
export function stripDeveloperJargon(text: string): string {
  let s = stripSynthPromptLeakage(String(text || ''))
  s = s.replace(CTX_MARK_RE, '')
  s = s.replace(OK_MARK_RE, '')
  s = s
    .split('\n')
    .map((line) => {
      let t = line.replace(AGENT_ID_LINE_RE, '')
      if (DEVELOPER_JARGON_RE.test(t) && t.trim().length < 80) return ''
      t = t.replace(/\bagent_result\b/gi, '结果')
      return t
    })
    .filter((line) => line.trim().length > 0)
    .join('\n')
  return stripSynthPromptLeakage(s.replace(/\n{3,}/g, '\n\n').trim())
}

function looksLikeDeveloperDump(text: string): boolean {
  const s = String(text || '')
  if (!s.trim()) return true
  if (DEVELOPER_JARGON_RE.test(s)) return true
  if (/\(ok\)/i.test(s) && s.length < 200) return true
  if (/^\{[\s\S]*"ok"\s*:/.test(s.trim())) return true
  if (/仅处理下列个人助理能力/.test(s)) return true
  if (/#{1,3}\s*执行摘要/.test(s)) return true
  if (/关于数据来源的说明/.test(s) && /置信度|不可信/.test(s)) return true
  if (/```\s*agent_result\b/i.test(s)) return true
  // 管线 dump 主导：多条 agent: 回显且几乎无用户叙述
  const pipelineLines = (s.match(
    /^(?:[-*•]\s*)?(?:✓|×|−|○|✔|✖)?\s*(db|rag|crawler|code|clean|visualize|report|admin|gui)\s*[：:]/gim
  ) || []).length
  if (pipelineLines >= 3 && s.length < 800) return true
  return false
}

/** 库表审计 / ORM 系统列（返回体结构清洗，非用户意图识别） */
const SYSTEM_AUDIT_COLUMN_RE =
  /^(创建人|创建时间|修改人|修改时间|逻辑删除|逻辑删除标志|删除标志|del[_]?flag|is[_]?deleted|create[_]?by|update[_]?by|create[_]?time|update[_]?time|tenant[_]?id|created[_]?at|updated[_]?at|deleted[_]?at|gmt[_]?create|gmt[_]?modified)$/i

/** 标题含子串也视为系统列（如「逻辑删除标志」「是否删除」） */
const SYSTEM_AUDIT_COLUMN_SUBSTR_RE =
  /(逻辑删除|删除标志|del[_]?flag|is[_]?deleted|create[_]?by|update[_]?by|create[_]?time|update[_]?time|tenant[_]?id|created[_]?at|updated[_]?at|deleted[_]?at|gmt[_]?create|gmt[_]?modified)/i

export function isSystemAuditColumn(header: string): boolean {
  const h = String(header || '')
    .trim()
    .replace(/\s+/g, '')
  if (!h) return false
  if (SYSTEM_AUDIT_COLUMN_RE.test(h)) return true
  return SYSTEM_AUDIT_COLUMN_SUBSTR_RE.test(h)
}

/** 从表中剥离系统列，保留业务列；若全被剥掉则返回 null */
export function dropSystemAuditColumns(table: {
  headers: string[]
  rows: string[][]
}): { headers: string[]; rows: string[][] } | null {
  const headers = Array.isArray(table.headers) ? table.headers : []
  const keepIdx: number[] = []
  for (let i = 0; i < headers.length; i++) {
    if (!isSystemAuditColumn(headers[i]!)) keepIdx.push(i)
  }
  if (!keepIdx.length) return null
  if (keepIdx.length === headers.length) return table
  return {
    headers: keepIdx.map((i) => headers[i]!),
    rows: (table.rows || []).map((row) => keepIdx.map((i) => String(row[i] ?? '')))
  }
}

function formatMarkdownTable(table: { headers: string[]; rows: string[][] }): string {
  const sep = table.headers.map(() => '---')
  const lines = [
    `| ${table.headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...table.rows.map((r) => `| ${r.join(' | ')} |`)
  ]
  return lines.join('\n')
}

/**
 * 正文内 Markdown 表：剥掉系统审计列（确定性结构清洗）。
 * 整表仅剩系统列时删除该表。
 */
export function stripSystemAuditColumnsFromMarkdown(text: string): string {
  const s = String(text || '')
  if (!s.includes('|')) return s
  const lines = s.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const t = line.trim()
    if (!t.includes('|') || /^[-*•]/.test(t)) {
      out.push(line)
      i++
      continue
    }
    // 收集连续表行
    const block: string[] = []
    let j = i
    while (j < lines.length && lines[j]!.trim().includes('|')) {
      block.push(lines[j]!)
      j++
    }
    const parsed = parseMarkdownTable(block.join('\n'))
    if (parsed && parsed.headers.length) {
      // parseMarkdownTable 已 drop 系统列；若原块含系统列则重写
      const hadSystem = block[0] && splitPipeCells(block[0]).some((c) => isSystemAuditColumn(c))
      if (hadSystem) {
        out.push(formatMarkdownTable(parsed))
      } else {
        out.push(...block)
      }
      i = j
      continue
    }
    // 解析失败：若表头全是系统列则丢弃整块
    const headCells = splitPipeCells(block[0] || '')
    if (headCells.length && headCells.every((c) => isSystemAuditColumn(c) || /^:?-{3,}:?$/.test(c))) {
      i = j
      continue
    }
    out.push(...block)
    i = j
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function splitPipeCells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** 专才 stub / JSON / 机械合并串：不得进用户主列 */
function looksLikeHandoffStubOrBlob(text: string): boolean {
  const s = String(text || '').trim()
  if (!s) return true
  if (/^(db|rag|crawler|code|clean|visualize|report|admin|gui)\s*已完成$/i.test(s)) return true
  if (/已完成$/.test(s) && s.length <= 24) return true
  if (/^\{[\s\S]*\}$/.test(s) && /"(answer|ok|sources|facts)"\s*:/.test(s)) return true
  if (/已机械合并/.test(s) && s.length < 200) return true
  if (/^deferred_to_synth$/i.test(s)) return true
  return false
}

/** 多源 / 含报告加工步：禁止把专才 dump 拼成主回复 */
export function isHeavyUserFacingTask(input: {
  intent?: string
  results?: Record<string, unknown>
  planSteps?: Array<{ agent?: string }>
  meta?: Record<string, unknown>
}): boolean {
  if (isMultiSourceDataPipeline(input.results)) return true
  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const agents = steps.map((s) => String(s?.agent || '').trim()).filter(Boolean)
  if (agents.some((a) => ['report', 'clean', 'visualize'].includes(a))) return true
  const m = input.meta && typeof input.meta === 'object' ? input.meta : {}
  if (Boolean((m as { wantsReportHint?: boolean }).wantsReportHint)) return true
  if (Boolean((m as { requiresAgentPipelineHint?: boolean }).requiresAgentPipelineHint)) return true
  const intent = String(input.intent || '').trim()
  if (intent === 'multi' || intent === 'report') {
    const dataHits = ['db', 'rag', 'crawler', 'code'].filter(
      (a) => String(input.results?.[a] ?? '').trim().length > 0 || agents.includes(a)
    )
    if (dataHits.length >= 2) return true
  }
  return false
}

/**
 * 用户态回复档位：lite 短确认 / standard DeepSeek 分段 / report 对照分析。
 * 读 plan·results·meta 结构，禁止用户原话关键词分支。
 */
export function resolveReplyTier(input: {
  intent?: string
  results?: Record<string, unknown>
  planSteps?: Array<{ agent?: string }>
  meta?: Record<string, unknown>
  multiSourceSynth?: boolean
  canShowAuxOutputs?: boolean
  adminSynthContext?: boolean
  chatWebReply?: boolean
  hasGuiResult?: boolean
  hasDbResult?: boolean
  presentationPlan?: PresentationPlan | null
}): ReplyTier {
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}
  const plan =
    input.presentationPlan ??
    presentationPlanFromMeta(meta)
  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const agents = steps.map((s) => String(s?.agent || '').trim()).filter(Boolean)
  const bag = input.results && typeof input.results === 'object' ? input.results : {}
  const hasAdmin =
    Boolean(input.adminSynthContext) ||
    agents.includes('admin') ||
    Boolean(String(bag.admin ?? '').trim())
  const hasHeavyAux =
    Boolean(input.canShowAuxOutputs) ||
    agents.some((a) => ['report', 'clean', 'visualize'].includes(a)) ||
    Boolean(String(bag.report ?? '').trim()) ||
    Boolean(String(bag.clean ?? '').trim()) ||
    Boolean(String(bag.visualize ?? '').trim())
  const multi =
    Boolean(input.multiSourceSynth) ||
    isHeavyUserFacingTask({
      intent: input.intent,
      results: bag,
      planSteps: steps,
      meta
    })

  const adminOnly =
    hasAdmin &&
    !multi &&
    !hasHeavyAux &&
    agents.every((a) => !a || a === 'admin') &&
    !['db', 'rag', 'crawler', 'code'].some((k) => String(bag[k] ?? '').trim())

  let structural: ReplyTier = 'standard'
  if (adminOnly) {
    structural = 'lite'
  } else {
    const guiOnly =
      Boolean(input.hasGuiResult) &&
      !Boolean(input.hasDbResult) &&
      !multi &&
      !hasHeavyAux &&
      agents.length > 0 &&
      agents.every((a) => a === 'gui')
    if (guiOnly) structural = 'lite'
    else if (multi || hasHeavyAux) structural = 'report'
  }

  return resolveEffectiveReplyTier(plan, structural)
}

const SYNTH_MISSING_HINT = '汇总未生成可用正文，请重试本轮任务。'
const LIGHT_MISSING_HINT = '暂无结论。可查看上方进展，或换个说法再试一次。'

/** 复杂任务已有图表/指标但 Synth 正文被拒：从 Code answer/facts 或已解析指标拼最小可读结论 */
function buildHeavyAuxSummaryFallback(input: {
  results?: Record<string, unknown>
  metrics?: UserFacingMetric[]
  chart?: { title?: string }
}): string {
  const parts: string[] = []
  const codeRaw = String(input.results?.code ?? '').trim()
  if (codeRaw.startsWith('{')) {
    try {
      const obj = JSON.parse(codeRaw) as {
        answer?: string
        facts?: Array<{ label?: string; key?: string; value?: unknown }>
      }
      const ans = stripPhaseStepLabels(stripDeveloperJargon(String(obj.answer ?? '').trim()))
      if (ans && !looksLikeDeveloperDump(ans) && !looksLikeHandoffStubOrBlob(ans)) {
        parts.push(ans)
      } else {
        const facts = Array.isArray(obj.facts) ? obj.facts : []
        const lines = facts
          .slice(0, 8)
          .map((f) => {
            const label = String(f.label ?? f.key ?? '').trim()
            const value = String(f.value ?? '').trim()
            if (!label || !value) return ''
            return `- **${humanizeFieldKey(label)}**：${value}`
          })
          .filter(Boolean)
        if (lines.length) parts.push(['### 关键数据', ...lines].join('\n'))
      }
    } catch {
      /* ignore */
    }
  }
  if (!parts.length && input.metrics?.length) {
    const lines = input.metrics
      .slice(0, 8)
      .map((m) => `- **${m.label}**：${m.value}`)
      .filter(Boolean)
    if (lines.length) parts.push(['### 关键指标', ...lines].join('\n'))
  }
  if (!parts.length && input.chart?.title) {
    parts.push(`已生成「${String(input.chart.title).slice(0, 60)}」，详见下方图表。`)
  }
  return parts.join('\n\n').trim()
}

/** 寒暄/记忆/确认类轻路径：禁止「暂无结论」占位，须给用户自然语言答复 */
function resolveConversationalFallback(meta?: Record<string, unknown>): string | null {
  const m = meta && typeof meta === 'object' ? meta : {}
  const proposal = m.memoryCaptureProposal as { kind?: string; title?: string } | undefined
  if (proposal?.kind && proposal.kind !== 'none') {
    return buildMemoryCaptureAckText({
      kind: proposal.kind as MemoryMetaIntentParsed['kind'],
      title: proposal.title,
      confidence: 1,
    })
  }
  const parsed = m.memoryMetaIntentParsed as MemoryMetaIntentParsed | undefined
  if (parsed?.kind && parsed.kind !== 'none') {
    return buildMemoryCaptureAckText(parsed)
  }
  if (
    m.memoryCaptureSynth === true ||
    m.chitchatSynth === true ||
    m.directChitchatSynth === true ||
    m.orchestrationThickness === 'memory_capture' ||
    m.metaIntentHotGate === true
  ) {
    return '好的，收到。还有什么我可以帮你的？'
  }
  return null
}

/** handoff 回退：去掉阶段标签后取可用短结论；仍像 dump 则空 */
function normalizeHandoffFallback(joined: string): string {
  const stripped = stripPhaseStepLabels(String(joined || '').trim())
  if (!stripped) return ''
  if (looksLikeDeveloperDump(stripped) || looksLikeHandoffStubOrBlob(stripped) || looksLikeStepDumpSummary(stripped)) {
    return ''
  }
  return stripped
}

function outcomeLabelZh(outcome: UserFacingOutcome): string {
  if (outcome === 'failed') return '未完成'
  if (outcome === 'needs_human') return '待你确认'
  return '已完成'
}

function handoffFromEvidence(ev: unknown): SpecialistHandoff | null {
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  const h = e.handoff
  if (h && typeof h === 'object' && String((h as SpecialistHandoff).summary || '').trim()) {
    return h as SpecialistHandoff
  }
  const ar = e.agentResult as { handoff?: SpecialistHandoff } | undefined
  if (ar?.handoff?.summary) return ar.handoff
  return null
}

function collectHandoffSummaries(input: {
  evidence?: unknown[]
  meta?: Record<string, unknown>
  results?: Record<string, unknown>
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string, _agent?: string) => {
    // 用户主列禁止「查数据库：」等阶段标签前缀；专才原文留给过程/开发视图
    const cleaned = stripPhaseStepLabels(stripDeveloperJargon(raw))
    if (!cleaned || looksLikeDeveloperDump(cleaned) || looksLikeHandoffStubOrBlob(cleaned)) return
    if (looksLikeStepDumpSummary(cleaned)) return
    const key = cleaned.slice(0, 120)
    if (seen.has(key)) return
    seen.add(key)
    out.push(cleaned)
  }

  for (const ev of Array.isArray(input.evidence) ? input.evidence : []) {
    const h = handoffFromEvidence(ev)
    const agent = String((ev as { kind?: string; agent?: string })?.kind || (ev as { agent?: string })?.agent || '')
    if (h?.summary) push(h.summary, agent)
  }

  const stepRecords = Array.isArray(input.meta?.lastStepRecords)
    ? (input.meta!.lastStepRecords as Array<{ agent?: string; summary?: string; handoff?: SpecialistHandoff; status?: string }>)
    : Array.isArray(input.meta?.stepRecords)
      ? (input.meta!.stepRecords as Array<{ agent?: string; summary?: string; handoff?: SpecialistHandoff }>)
      : []
  for (const sr of stepRecords) {
    if (sr?.handoff?.summary) push(sr.handoff.summary, sr.agent)
    else if (sr?.summary) push(String(sr.summary), sr.agent)
  }

  const bag = input.results && typeof input.results === 'object' ? input.results : {}
  for (const [agent, raw] of Object.entries(bag)) {
    if (['clean', 'visualize', 'report'].includes(agent)) continue
    const text = String(raw ?? '').trim()
    if (!text || looksLikeDeveloperDump(text) || looksLikeHandoffStubOrBlob(text)) continue
    // 禁止把库表全文/截断 dump 拼进用户主列（流式 synth 才是主叙述）
    if (looksLikeStepDumpSummary(text)) continue
    const brief = text.length > 400 ? `${text.slice(0, 400).trim()}…` : text
    if (looksLikeStepDumpSummary(brief) || looksLikeTruncatedSummary(brief)) continue
    if (out.length < 4) push(brief, agent)
  }

  return out.slice(0, 6)
}

function extractAppendix(synthOrFinal: string): { summary: string; appendix?: string } {
  const raw = stripStructuredExecReport(String(synthOrFinal || '').trim())
  if (!raw) return { summary: '' }
  const reportMarker = raw.search(/\n##\s*详细报告|\n##\s*详细说明|\n<!--\s*REPORT\s*-->/i)
  if (reportMarker >= 0) {
    return {
      summary: stripDeveloperJargon(raw.slice(0, reportMarker)),
      appendix: stripDeveloperJargon(
        stripStructuredExecReport(
          raw.slice(reportMarker).replace(/^[\s\S]*?(##\s*详细报告|##\s*详细说明|<!--\s*REPORT\s*-->)/i, '## 详细说明')
        )
      )
    }
  }
  return { summary: stripDeveloperJargon(raw) }
}

function resolveOutcome(meta?: Record<string, unknown>): UserFacingOutcome {
  if (meta?.evidenceGatePassed === false) return 'failed'
  if (Boolean(meta?.needsHumanConfirm) || Boolean(meta?.needsClarify)) return 'needs_human'
  const records = Array.isArray(meta?.lastStepRecords)
    ? (meta!.lastStepRecords as Array<{ status?: string }>)
    : []
  if (records.some((r) => ['error', 'failed'].includes(String(r.status || '')))) return 'failed'
  const v = meta?.verifierVerdict
  if (v && typeof v === 'object') {
    const verdict = String((v as { verdict?: string }).verdict || '')
    if (verdict === 'failed' || verdict === 'failed_steps') return 'failed'
    if (verdict === 'needs_human' || verdict === 'insufficient_evidence') return 'needs_human'
  }
  return 'completed'
}

function humanizeFieldKey(key: string): string {
  const k = String(key || '').trim()
  if (!k) return '指标'
  const lower = k.toLowerCase()
  if (FIELD_LABEL_ZH[lower]) return FIELD_LABEL_ZH[lower]
  if (/[\u4e00-\u9fff]/.test(k)) return k.slice(0, 40)
  return k
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .slice(0, 40) || '指标'
}

function extractTaggedBlock(raw: string, tag: string): string {
  const open = `<!--${tag}-->`
  const close = `<!--/${tag}-->`
  const s = String(raw || '')
  const start = s.indexOf(open)
  if (start < 0) return ''
  const bodyStart = start + open.length
  const end = s.indexOf(close, bodyStart)
  if (end < 0) return ''
  return s.slice(bodyStart, end).trim()
}

/** 解析 markdown 表（TABLE_DATA 或 clean.tables）；自动剥离系统审计列 */
export function parseMarkdownTable(md: string): { headers: string[]; rows: string[][] } | null {
  const lines = String(md || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const tableLines = lines.filter((l) => l.includes('|'))
  if (tableLines.length < 2) return null
  const splitRow = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const headers = splitRow(tableLines[0]!).map((h) => humanizeFieldKey(h))
  if (!headers.length) return null
  const rows: string[][] = []
  for (const line of tableLines.slice(1)) {
    if (/^\|?\s*:?-{3,}/.test(line)) continue
    const cells = splitRow(line).map((c) => String(c).slice(0, 120))
    if (cells.every((c) => !c)) continue
    while (cells.length < headers.length) cells.push('')
    rows.push(cells.slice(0, headers.length))
    if (rows.length >= 40) break
  }
  if (!rows.length) return null
  return dropSystemAuditColumns({ headers, rows })
}

function collectModuleSlots(input: {
  results?: Record<string, unknown>
  meta?: Record<string, unknown>
  synth?: string
  evidence?: unknown[]
}): {
  metrics?: UserFacingMetric[]
  chart?: { title: string; option: object }
  table?: { headers: string[]; rows: string[][] }
} {
  const bag = input.results && typeof input.results === 'object' ? input.results : {}
  const visualizeText = String(bag.visualize || '')
  const cleanRaw = String(bag.clean || '')
  const synth = String(input.synth || '')
  const out: {
    metrics?: UserFacingMetric[]
    chart?: { title: string; option: object }
    table?: { headers: string[]; rows: string[][] }
  } = {}

  const chartSources = [visualizeText, synth]
  for (const src of chartSources) {
    const opt = readEchartsOptionJsonFromVisualizeText(src)
    if (opt && isRenderableChartOption(opt) && typeof opt === 'object') {
      const title = readChartTitle(opt) || '数据图表'
      out.chart = { title: String(title).slice(0, 80), option: opt as object }
      break
    }
  }

  const clean = cleanRaw ? parseCleanPayload(cleanRaw) : null
  const metrics: UserFacingMetric[] = []
  if (clean?.facts?.length) {
    for (const f of clean.facts.slice(0, 8)) {
      const label = String(f.label || '').trim() || humanizeFieldKey(String(f.key || ''))
      const value = String(f.value ?? '').trim()
      if (!label || !value) continue
      if (isSystemAuditColumn(label) || isSystemAuditColumn(String(f.key || ''))) continue
      if (DEVELOPER_JARGON_RE.test(label) || DEVELOPER_JARGON_RE.test(value)) continue
      metrics.push({ label: label.slice(0, 40), value: value.slice(0, 80) })
    }
  }
  if (!metrics.length && out.chart) {
    const o = out.chart.option as {
      xAxis?: { data?: unknown[] } | Array<{ data?: unknown[] }>
      series?: Array<{ name?: string; data?: unknown[] }> | { name?: string; data?: unknown[] }
    }
    const xAxis = Array.isArray(o.xAxis) ? o.xAxis[0] : o.xAxis
    const cats = Array.isArray(xAxis?.data) ? xAxis.data.map((x) => String(x)) : []
    const series = Array.isArray(o.series) ? o.series : o.series ? [o.series] : []
    const first = series[0]
    const data = Array.isArray(first?.data) ? first.data : []
    for (let i = 0; i < Math.min(cats.length, data.length, 8); i++) {
      const label = humanizeFieldKey(cats[i] || `项${i + 1}`)
      const cell = data[i]
      const value =
        cell && typeof cell === 'object' && !Array.isArray(cell)
          ? String((cell as { value?: unknown }).value ?? '')
          : String(cell ?? '')
      if (label && value) metrics.push({ label, value: value.slice(0, 80) })
    }
  }
  if (metrics.length) out.metrics = metrics

  const tableMd =
    extractTaggedBlock(visualizeText, 'TABLE_DATA') ||
    extractTaggedBlock(synth, 'TABLE_DATA') ||
    extractTaggedBlock(String(bag.report || ''), 'TABLE_DATA')
  let table = tableMd ? parseMarkdownTable(tableMd) : null
  // 无有效单元格视为空壳，回退 evidence（对齐 Vanna meta.rows）
  if (!structuredTableHasValues(table)) {
    const fromEv = tableFromDbEvidence(input.evidence)
    if (structuredTableHasValues(fromEv)) {
      table = dropSystemAuditColumns(fromEv!)
    } else {
      table = null
    }
  }
  if (!structuredTableHasValues(table) && clean?.tables?.length) {
    const t0 = clean.tables[0]!
    const headers = (t0.columns || []).map((c) => humanizeFieldKey(String(c)))
    const rows = (t0.rows || [])
      .slice(0, 40)
      .map((row) =>
        headers.map((_, i) => {
          const col = t0.columns?.[i]
          const v = col && row && typeof row === 'object' ? (row as Record<string, unknown>)[col] : ''
          return String(v ?? '').slice(0, 120)
        })
      )
      .filter((row) => row.some((c) => String(c || '').trim()))
    if (headers.length && rows.length) table = dropSystemAuditColumns({ headers, rows })
  }
  // 单行 ORM 实体宽表：多源对照任务过滤；只要有 DB 结果就必须展示查询表
  if (structuredTableHasValues(table) && table) {
    const headers = table.headers
    const hasDbResult = Boolean(String(input.results?.db ?? '').trim())
    const singleSourceDb =
      String(input.meta?.orchestrationThickness || '') === 'single_source' && hasDbResult
    const looksLikeEntityDump =
      table.rows.length <= 2 &&
      headers.length >= 3 &&
      !headers.some((h) => /指标|测值|测量|参考|状态|标准|结论/.test(String(h)))
    if (!looksLikeEntityDump || singleSourceDb || hasDbResult) out.table = table
  }

  return out
}

function resolveActions(input: {
  meta?: Record<string, unknown>
  actions?: UserFacingActionCard[]
}): UserFacingActionCard[] | undefined {
  if (Array.isArray(input.actions) && input.actions.length) return input.actions
  const meta = input.meta || {}
  if (!Boolean(meta.needsHumanConfirm)) return undefined
  const agent = String(meta.humanConfirmAgent || meta.confirmAgent || 'admin').toLowerCase()
  const ops = Array.isArray(meta.adminPendingOps) ? meta.adminPendingOps : []
  const cards = buildActionCardsFromHumanConfirm({
    agent,
    title: String(meta.humanConfirmTitle || '').trim() || undefined,
    message: String(meta.humanConfirmMessage || meta.pauseMessage || '').trim(),
    confirmId: String(meta.humanConfirmId || meta.confirmId || '').trim() || undefined,
    screenshotDataUrl: meta.guiScreenshot ? String(meta.guiScreenshot) : undefined,
    pageUrl: meta.guiPageUrl ? String(meta.guiPageUrl) : undefined,
    failureType: meta.guiFailureType ? String(meta.guiFailureType) : undefined,
    adminPendingOps: ops
  })
  return cards.length ? cards : undefined
}

function sourceDedupeKey(title: string, url?: string): string {
  const u = String(url || '')
    .trim()
    .toLowerCase()
  if (u) return `u:${u}`
  return `t:${String(title || '')
    .trim()
    .toLowerCase()
    .slice(0, 80)}`
}

/** 合并 crawler / SERP / RAG 等为统一编号来源（供 userFacing 与 Synth 引用表） */
export function collectUnifiedSources(input: {
  evidence?: unknown[]
  meta?: Record<string, unknown>
  max?: number
}): UserFacingSource[] {
  const max = Math.max(1, Math.min(Number(input.max) || 12, 20))
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}
  const raw: Array<{ title: string; url?: string; excerpt?: string; kind: UserFacingSource['kind'] }> =
    []
  const seen = new Set<string>()
  const push = (title: string, opts?: { url?: string; excerpt?: string; kind?: UserFacingSource['kind'] }) => {
    const t = String(title || '').trim()
    if (!t) return
    const url = opts?.url ? String(opts.url).trim() : undefined
    const key = sourceDedupeKey(t, url)
    if (seen.has(key)) return
    seen.add(key)
    raw.push({
      title: t.slice(0, 120),
      url: url || undefined,
      excerpt: opts?.excerpt ? String(opts.excerpt).trim().slice(0, 240) : undefined,
      kind: opts?.kind || 'doc'
    })
  }

  if (Array.isArray(meta.crawlerSources)) {
    for (const s of meta.crawlerSources as Array<{
      title?: string
      url?: string
      name?: string
      excerpt?: string
      snippet?: string
    }>) {
      push(String(s?.title || s?.name || s?.url || ''), {
        url: s?.url ? String(s.url) : undefined,
        excerpt: String(s?.excerpt || s?.snippet || '').trim() || undefined,
        kind: 'web'
      })
    }
  }

  if (Array.isArray(meta.searchHits)) {
    for (const h of meta.searchHits as Array<{
      title?: string
      url?: string
      snippet?: string
      excerpt?: string
    }>) {
      push(String(h?.title || h?.url || ''), {
        url: h?.url ? String(h.url) : undefined,
        excerpt: String(h?.excerpt || h?.snippet || '').trim() || undefined,
        kind: 'web'
      })
    }
  }

  for (const ev of Array.isArray(input.evidence) ? input.evidence : []) {
    const e = ev as Record<string, unknown>
    const kindHint = String(e?.kind || e?.agent || '').toLowerCase()
    const sourceKind: UserFacingSource['kind'] =
      kindHint === 'rag' ? 'rag' : kindHint === 'db' ? 'db' : kindHint === 'crawler' ? 'web' : 'doc'

    const ar = e?.agentResult as
      | {
          sources?: Array<{ type?: string; ref?: string; title?: string; url?: string; excerpt?: string }>
        }
      | undefined
    for (const s of ar?.sources || []) {
      push(String(s?.title || s?.ref || ''), {
        url: s?.url ? String(s.url) : undefined,
        excerpt: s?.excerpt ? String(s.excerpt) : undefined,
        kind: sourceKind
      })
    }

    const citations = e?.citations as
      | Array<{ source?: string; title?: string; url?: string; excerpt?: string; snippet?: string }>
      | undefined
    if (Array.isArray(citations)) {
      for (const c of citations.slice(0, 8)) {
        push(String(c?.title || c?.source || ''), {
          url: c?.url ? String(c.url) : undefined,
          excerpt: String(c?.excerpt || c?.snippet || '').trim() || undefined,
          kind: sourceKind
        })
      }
    }
  }

  return raw.slice(0, max).map((s, i) => ({
    index: i + 1,
    title: s.title,
    url: s.url,
    excerpt: s.excerpt,
    kind: s.kind
  }))
}

/** 供 Synth HumanMessage：可引用编号清单 */
export function formatCitationInventoryForSynth(sources: UserFacingSource[]): string {
  if (!sources.length) return ''
  const lines = sources.map((s) => {
    const bits = [`[${s.index}] ${s.title}`]
    if (s.excerpt) bits.push(`摘录：${s.excerpt.slice(0, 160)}`)
    if (s.url) bits.push(`链接：${s.url.slice(0, 120)}`)
    return `- ${bits.join(' | ')}`
  })
  return [
    '可引用来源（正文用 [1][2] 角标对应下列编号；禁止贴裸 URL 墙；系统会在下方展示可点来源卡）：',
    ...lines
  ].join('\n')
}

/** summary 与 appendix 是否高度重复（确定性结构消重） */
export function appendixOverlapsSummary(summary: string, appendix: string): boolean {
  const norm = (t: string) =>
    String(t || '')
      .replace(/#{1,4}\s*/g, '')
      .replace(/\s+/g, '')
      .slice(0, 500)
  const a = norm(summary)
  const b = norm(appendix)
  if (!a || !b) return false
  // 短文：正文前缀已出现在附录
  const probeLen = Math.min(80, Math.max(16, Math.floor(a.length * 0.5)))
  if (probeLen >= 16 && b.includes(a.slice(0, probeLen))) return true
  if (a.length >= 48 && b.length >= 48) {
    const aHead = a.slice(0, 200)
    const bHead = b.slice(0, 200)
    let hit = 0
    const step = 12
    for (let i = 0; i + step <= aHead.length; i += step) {
      if (bHead.includes(aHead.slice(i, i + step))) hit += 1
    }
    const slots = Math.floor(aHead.length / step)
    if (slots > 0 && hit / slots >= 0.55) return true
  }
  return false
}

const HEADLINE_MAX_CHARS = 80
const HEADLINE_SKIP_HINTS = /汇总未生成|暂无可用结论|未能生成|系统未找到足够/

/**
 * 从 summary 首段确定性截取一行 headline（非 LLM）。
 * lite 档跳过；过短或占位提示跳过。
 */
export function extractUserFacingHeadline(
  summary: string,
  replyTier?: ReplyTier
): string | undefined {
  if (replyTier === 'lite') return undefined
  const raw = String(summary || '').trim()
  if (!raw || HEADLINE_SKIP_HINTS.test(raw)) return undefined

  // 跳过开头的 markdown 标题行，取首个实质段落
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  let first = ''
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) continue
    if (/^[-*|>]\s/.test(line) && !first) {
      first = line.replace(/^[-*|>]\s+/, '')
      break
    }
    first = line
    break
  }
  if (!first) return undefined

  // 去掉粗体/斜体标记，按句号截断
  let text = first
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\d+[\.\)]\s+/, '')
    .trim()
  const sentenceEnd = text.search(/[。！？.!?]/)
  if (sentenceEnd >= 12) text = text.slice(0, sentenceEnd + 1)
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length < 8) return undefined
  if (text.length > HEADLINE_MAX_CHARS) {
    text = `${text.slice(0, HEADLINE_MAX_CHARS - 1).trim()}…`
  }
  return text
}

/**
 * 从 graph 结果组装 UserFacingPayload。
 * 优先 synth 叙述；简单任务可回退 handoff.summary；复杂/多源禁止专才 dump join。
 */
export function buildUserFacingPayload(input: {
  finalText?: string
  synth?: string
  intent?: string
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
  planSteps?: Array<{ agent?: string }>
  actions?: UserFacingActionCard[]
}): UserFacingPayload {
  const meta = (input.meta && typeof input.meta === 'object' ? input.meta : {}) as Record<string, unknown>
  const synth = String(input.synth || input.finalText || '').trim()
  const { summary: fromSynth, appendix } = extractAppendix(synth)
  const heavy = isHeavyUserFacingTask({
    intent: input.intent,
    results: input.results,
    planSteps: input.planSteps,
    meta
  })
  const presentationPlan = presentationPlanFromMeta(meta)
  const replyTier = resolveReplyTier({
    intent: input.intent,
    results: input.results,
    planSteps: input.planSteps,
    meta,
    multiSourceSynth: heavy,
    canShowAuxOutputs: heavy,
    adminSynthContext:
      Boolean(String(input.results?.admin ?? '').trim()) ||
      (Array.isArray(input.planSteps) &&
        input.planSteps.some((s) => String(s?.agent || '') === 'admin')),
    hasGuiResult: Boolean(String(input.results?.gui ?? '').trim()),
    hasDbResult: Boolean(String(input.results?.db ?? '').trim()),
    chatWebReply: Boolean(meta.chatWebOnly) || String(meta.webExecutionMode || '') === 'search_chat',
    presentationPlan
  })

  let summary = fromSynth
  // synth 流式正文优先保留（含库表原文回显）；仅开发者腔 / 阶段标签拼接 / stub 才回退
  const phaseLabeled =
    ((summary || '').match(
      /^(查数据库|采集网页|清洗数据|计算数据|撰写报告|检索知识库|生成图表)[：:]/gm
    ) || []).length >= 1
  if (!summary || looksLikeDeveloperDump(summary) || looksLikeHandoffStubOrBlob(summary) || phaseLabeled) {
    const light = stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(synth)))
    const lightPhase =
      ((light || '').match(
        /^(查数据库|采集网页|清洗数据|计算数据|撰写报告|检索知识库|生成图表)[：:]/gm
      ) || []).length >= 1
    if (
      light &&
      !looksLikeDeveloperDump(light) &&
      !looksLikeHandoffStubOrBlob(light) &&
      !lightPhase
    ) {
      summary = light
    } else if (heavy) {
      summary = SYNTH_MISSING_HINT
    } else {
      const handoffs = collectHandoffSummaries({
        evidence: input.evidence,
        meta,
        results: input.results
      })
      summary = normalizeHandoffFallback(handoffs.join('\n\n')) || resolveConversationalFallback(meta) || LIGHT_MISSING_HINT
    }
  }

  summary = stripSystemAuditColumnsFromMarkdown(
    stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(summary)))
  )
  summary = stripPhaseStepLabels(summary)
  // DB 用户面：剥表名/字段原名；TABLE_DATA 单元格不得被掏空
  if (Boolean(String(input.results?.db ?? '').trim()) || collectDbSchemaIdentifiers(input.evidence).length) {
    summary = scrubProsePreservingTableData(summary, collectDbSchemaIdentifiers(input.evidence))
  }
  // 剥掉 summary 里的空 TABLE_DATA，避免与有数 final 冲突后仍留空壳看板
  summary = summary.replace(
    /<!--\s*TABLE_DATA\s*-->[\s\S]*?<!--\s*\/TABLE_DATA\s*-->/gi,
    (full) => (tableDataBlockHasValues(full) ? full : '')
  )
  summary = summary.replace(/\n{3,}/g, '\n\n').trim()
  // report 档过短：若完整 synth 更长且含分段，回升（避免 Code answer 一句带过）
  if (
    replyTier === 'report' &&
    isReportTierSummaryTooThin(summary, replyTier) &&
    synth &&
    !isReportTierSummaryTooThin(stripPhaseStepLabels(synth), replyTier)
  ) {
    summary = stripSystemAuditColumnsFromMarkdown(
      stripStructuredExecReport(
        stripDeveloperJargon(stripSynthPromptLeakage(stripPhaseStepLabels(synth)))
      )
    )
  }
  if (!summary) {
    summary = heavy ? SYNTH_MISSING_HINT : resolveConversationalFallback(meta) || LIGHT_MISSING_HINT
  }
  // 截断 dump：若完整 synth 更长，回升到 synth（与流式预览对齐）
  if (
    looksLikeTruncatedSummary(summary) &&
    synth &&
    stripPhaseStepLabels(synth).length > summary.length * 1.05
  ) {
    summary = stripSystemAuditColumnsFromMarkdown(
      stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(stripPhaseStepLabels(synth))))
    )
  }

  const outcome = resolveOutcome(meta)
  const sources = shouldShowSources(presentationPlan)
    ? collectUnifiedSources({ evidence: input.evidence, meta, max: 12 })
    : []

  const slots = applyPresentationToSlots(
    collectModuleSlots({
      results: input.results,
      meta,
      synth,
      evidence: input.evidence
    }),
    presentationPlan
  )
  const actions = resolveActions({ meta, actions: input.actions })

  if (
    (summary === SYNTH_MISSING_HINT || !String(summary || '').trim()) &&
    heavy &&
    (slots.metrics?.length || slots.chart || slots.table)
  ) {
    const auxFallback = buildHeavyAuxSummaryFallback({
      results: input.results,
      metrics: slots.metrics,
      chart: slots.chart
    })
    if (auxFallback) {
      summary = stripSystemAuditColumnsFromMarkdown(
        stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(auxFallback)))
      )
    }
  }

  const cleanAppendix = appendix
    ? stripSystemAuditColumnsFromMarkdown(stripStructuredExecReport(appendix))
    : ''
  const payload: UserFacingPayload = {
    summary,
    outcome,
    outcomeLabel: outcomeLabelZh(outcome),
    replyTier
  }
  if (presentationPlan && isPresentationPlanActive(presentationPlan)) {
    payload.presentationPlan = presentationPlan
  }
  const headline = shouldShowHeadline(presentationPlan, replyTier)
    ? extractUserFacingHeadline(summary, replyTier)
    : undefined
  if (headline) payload.headline = headline
  if (meta.evidenceGatePassed === false) {
    payload.badge = 'evidence_rejected'
    payload.badgeLabel = '无证据拒答'
    if (outcome === 'failed' && !/证据|依据|拒答/.test(summary)) {
      payload.summary = `${summary}\n\n（系统未找到足够可核验依据，已拒绝编造结论。）`
    }
  } else if (Boolean(meta.needsClarify)) {
    payload.badge = 'needs_clarify'
    payload.badgeLabel = '需补充信息'
  }
  // 执行摘要类 dump / lite·standard / 与正文重复 → 不进用户附录
  const allowAppendix =
    shouldIncludeReportAppendix(presentationPlan, replyTier) &&
    cleanAppendix &&
    cleanAppendix.length >= 40 &&
    !looksLikeExecAuditDump(cleanAppendix) &&
    !appendixOverlapsSummary(summary, cleanAppendix)
  if (allowAppendix) {
    payload.appendix = cleanAppendix
  }
  if (sources.length) payload.sources = sources
  if (slots.metrics?.length) payload.metrics = slots.metrics
  if (slots.chart) payload.chart = slots.chart
  // 无有效单元格的表不进 userFacing，避免气泡「数据看板」空壳盖掉 Markdown
  if (slots.table && structuredTableHasValues(slots.table)) payload.table = slots.table
  if (actions?.length) payload.actions = actions
  if (
    presentationPlan?.suggestions?.length &&
    isPresentationPlanActive(presentationPlan)
  ) {
    payload.suggestions = presentationPlan.suggestions.slice(0, 4)
  }
  const artifactSlots = buildReplyArtifactSlots({
    plan: presentationPlan,
    chartTitle: slots.chart?.title,
    hasChart: Boolean(slots.chart),
    hasTable: Boolean(slots.table),
    hasReport: Boolean(allowAppendix && cleanAppendix)
  })
  if (artifactSlots.length) payload.artifacts = artifactSlots
  return payload
}

/** 用户主列正文：仅 summary（附录/执行摘要不进主气泡） */
export function formatUserFacingMainText(payload: UserFacingPayload): string {
  return stripSystemAuditColumnsFromMarkdown(
    stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(payload.summary || '')))
  )
}
