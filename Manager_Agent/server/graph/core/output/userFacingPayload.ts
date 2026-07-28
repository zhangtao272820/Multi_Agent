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
  stripStructuredExecReport,
  stripSynthPromptLeakage
} from '#agent-shared/synthOutputSanitize'
import { planAgentLabel } from '../runtime/phaseLabels'
import type { SpecialistHandoff } from '../../../utils/agents/types'
import { buildActionCardsFromHumanConfirm } from './actionCard'

export { looksLikeExecAuditDump, stripStructuredExecReport }

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

export type UserFacingPayload = {
  summary: string
  metrics?: UserFacingMetric[]
  chart?: { title: string; option: object }
  table?: { headers: string[]; rows: string[][] }
  actions?: UserFacingActionCard[]
  appendix?: string
  sources?: Array<{ title: string; url?: string }>
  outcome?: UserFacingOutcome
  outcomeLabel?: string
  /** U3：无证据拒答徽章 */
  badge?: 'evidence_rejected' | 'needs_clarify'
  badgeLabel?: string
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
  return false
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
  const push = (raw: string, agent?: string) => {
    const cleaned = stripDeveloperJargon(raw)
    if (!cleaned || looksLikeDeveloperDump(cleaned)) return
    const key = cleaned.slice(0, 120)
    if (seen.has(key)) return
    seen.add(key)
    const label = agent ? planAgentLabel(agent) : ''
    out.push(label && !cleaned.startsWith(label) ? `${label}：${cleaned}` : cleaned)
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
    if (['clean', 'visualize'].includes(agent)) continue
    const text = String(raw ?? '').trim()
    if (!text || looksLikeDeveloperDump(text)) continue
    const brief = text.length > 400 ? `${text.slice(0, 400).trim()}…` : text
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

/** 解析 markdown 表（TABLE_DATA 或 clean.tables） */
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
  return { headers, rows }
}

function collectModuleSlots(input: {
  results?: Record<string, unknown>
  meta?: Record<string, unknown>
  synth?: string
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
  if (!table && clean?.tables?.length) {
    const t0 = clean.tables[0]!
    const headers = (t0.columns || []).map((c) => humanizeFieldKey(String(c)))
    const rows = (t0.rows || []).slice(0, 40).map((row) =>
      headers.map((_, i) => {
        const col = t0.columns?.[i]
        const v = col && row && typeof row === 'object' ? (row as Record<string, unknown>)[col] : ''
        return String(v ?? '').slice(0, 120)
      })
    )
    if (headers.length && rows.length) table = { headers, rows }
  }
  if (table) out.table = table

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

/**
 * 从 graph 结果组装 UserFacingPayload。
 * 优先 synth 短结论；无 synth 时用 handoff.summary；禁止专才全文 join。
 */
export function buildUserFacingPayload(input: {
  finalText?: string
  synth?: string
  intent?: string
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
  actions?: UserFacingActionCard[]
}): UserFacingPayload {
  const meta = (input.meta && typeof input.meta === 'object' ? input.meta : {}) as Record<string, unknown>
  const synth = String(input.synth || input.finalText || '').trim()
  const { summary: fromSynth, appendix } = extractAppendix(synth)

  let summary = fromSynth
  if (!summary || looksLikeDeveloperDump(summary)) {
    const handoffs = collectHandoffSummaries({
      evidence: input.evidence,
      meta,
      results: input.results
    })
    summary = handoffs.length
      ? handoffs.join('\n\n')
      : '暂无结论。可查看上方进展，或换个说法再试一次。'
  }

  summary = stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(summary)))
  if (!summary) summary = '暂无结论。可查看上方进展，或换个说法再试一次。'

  const outcome = resolveOutcome(meta)
  const sources: UserFacingPayload['sources'] = []
  if (Array.isArray(meta.crawlerSources)) {
    for (const s of meta.crawlerSources.slice(0, 8) as Array<{ title?: string; url?: string; name?: string }>) {
      const title = String(s?.title || s?.name || s?.url || '').trim()
      if (title) sources.push({ title: title.slice(0, 120), url: s?.url ? String(s.url) : undefined })
    }
  }
  // U3：从 evidence 提取 RAG/doc 引用，供前端证据优先展示
  if (Array.isArray(input.evidence)) {
    for (const ev of input.evidence as Array<Record<string, unknown>>) {
      const ar = ev?.agentResult as { sources?: Array<{ type?: string; ref?: string }> } | undefined
      for (const s of ar?.sources || []) {
        const ref = String(s?.ref || '').trim()
        if (ref && !sources.some((x) => x.title === ref)) {
          sources.push({ title: ref.slice(0, 120) })
        }
      }
      const citations = (ev as { citations?: Array<{ source?: string }> })?.citations
      if (Array.isArray(citations)) {
        for (const c of citations.slice(0, 6)) {
          const title = String(c?.source || '').trim()
          if (title && !sources.some((x) => x.title === title)) sources.push({ title: title.slice(0, 120) })
        }
      }
    }
  }

  const slots = collectModuleSlots({ results: input.results, meta, synth })
  const actions = resolveActions({ meta, actions: input.actions })

  const cleanAppendix = appendix ? stripStructuredExecReport(appendix) : ''
  const payload: UserFacingPayload = {
    summary,
    outcome,
    outcomeLabel: outcomeLabelZh(outcome)
  }
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
  // 执行摘要类 dump 不进用户附录（开发者视图看 composeFinal.text）
  if (cleanAppendix && cleanAppendix.length >= 40 && !looksLikeExecAuditDump(cleanAppendix)) {
    payload.appendix = cleanAppendix
  }
  if (sources.length) payload.sources = sources.slice(0, 12)
  if (slots.metrics?.length) payload.metrics = slots.metrics
  if (slots.chart) payload.chart = slots.chart
  if (slots.table) payload.table = slots.table
  if (actions?.length) payload.actions = actions
  return payload
}

/** 用户主列正文：仅 summary（附录/执行摘要不进主气泡） */
export function formatUserFacingMainText(payload: UserFacingPayload): string {
  return stripStructuredExecReport(stripDeveloperJargon(stripSynthPromptLeakage(payload.summary || '')))
}
