import { textIncludesAny, DB_EMPTY_ANSWER_MARKERS } from './dbEmptyText'
import { wantsNarrativeReportSynth } from './synthShapePolicy'

const DETERMINISTIC_REPORT_MODES = new Set([
  'db_authority_deterministic',
  'code_authority_deterministic',
  'code_authority_llm',
  'deterministic'
])

/** report 步骤是否已由确定性路径生成（跳过 report/synth LLM 的依据） */
export function hasDeterministicReportEvidence(
  evidence?: Array<{ kind?: string; mode?: string }> | null
): boolean {
  if (!Array.isArray(evidence)) return false
  return evidence.some(
    (e) => String(e?.kind ?? '') === 'report' && DETERMINISTIC_REPORT_MODES.has(String(e?.mode ?? ''))
  )
}

/** 单源取数 + report 且 report 已确定性生成 → synth/critic 可直通 */
export function shouldPassthroughDeterministicReport(input: {
  planSteps?: Array<{ agent?: string }>
  results?: Record<string, unknown> | null
  evidence?: Array<{ kind?: string; mode?: string }> | null
  intent?: string
  question?: string
  meta?: unknown
}): boolean {
  const report = String(input.results?.report ?? '').trim()
  if (!report || !hasDeterministicReportEvidence(input.evidence)) return false

  if (wantsNarrativeReportSynth({ meta: input.meta, planSteps: input.planSteps })) return false
  if (!report.includes('<!--REPORT-->') && !report.includes('## 核心结论')) return false

  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const agents = steps.map((s) => String(s?.agent ?? '')).filter(Boolean)
  if (!agents.includes('report')) return false

  const dataSources = ['db', 'rag', 'crawler', 'code'].filter((a) => agents.includes(a))
  if (dataSources.length > 1) return false

  const intent = String(input.intent ?? '').trim()
  if (intent === 'multi' && dataSources.length === 0) return false

  const blockers = ['admin', 'music', 'video', 'multimodal', 'visualize'].filter((a) => agents.includes(a))
  if (blockers.length) return false

  return true
}

/** 单源 DB 且库内已有非空结果 → chat 模式可直通；单源薄编排时专业模式也可直通 */
export function shouldPassthroughDbOnly(input: {
  intent?: string
  planSteps?: Array<{ agent?: string }>
  results?: Record<string, unknown> | null
  evidence?: Array<{ kind?: string; empty?: boolean }> | null
  meta?: unknown
  /** 专业工作台：禁止直通，须 Synth 归纳解释（单源薄编排除外） */
  professionalMode?: boolean
}): boolean {
  const meta = input.meta
  const thickness =
    meta && typeof meta === 'object'
      ? String((meta as Record<string, unknown>).orchestrationThickness || '')
      : ''
  if (thickness === 'single_source') {
    /* 单源薄编排：允许直通 */
  } else if (input.professionalMode === true) return false
  const db = String(input.results?.db ?? '').trim()
  if (!db || db.length < 8) return false

  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const stepAgents = steps.map((s) => String(s?.agent ?? '')).filter(Boolean)
  if (stepAgents.includes('report') || stepAgents.includes('clean') || stepAgents.includes('code')) return false
  if (wantsNarrativeReportSynth({ meta: input.meta, planSteps: input.planSteps })) return false

  const dbEv = (Array.isArray(input.evidence) ? input.evidence : []).find(
    (e) => String(e?.kind ?? '') === 'db'
  )
  if (dbEv?.empty) return false

  if (textIncludesAny(db, DB_EMPTY_ANSWER_MARKERS) && db.length < 120) return false

  const otherAgents = [
    'rag',
    'crawler',
    'code',
    'admin',
    'gui',
    'clean',
    'visualize',
    'report',
    'music',
    'video',
    'multimodal'
  ]
  const hasOtherOutput = otherAgents.some((a) => String(input.results?.[a] ?? '').trim().length > 0)
  if (hasOtherOutput) return false

  const intent = String(input.intent ?? '').trim()

  if (intent === 'db') return true

  if (intent === 'multi') {
    if (stepAgents.length === 0) return true
    if (stepAgents.length === 1 && stepAgents[0] === 'db') return true
    const dataAgents = ['db', 'rag', 'crawler', 'code'].filter((a) => stepAgents.includes(a))
    if (dataAgents.length === 1 && dataAgents[0] === 'db') return true
  }

  return false
}

const RAG_EMPTY_ANSWER_MARKERS = [
  '暂未找到',
  '未检索到',
  '知识库检索未找到',
  '未找到相关',
  '查不到',
  '无法进行后续分析',
  '未找到相关背景信息',
  'RAG_NEEDS_CLARIFY',
  '【需要补充信息】'
] as const

type RagPassthroughEvidence = {
  kind?: string
  hits?: number
  empty?: boolean
  citations?: Array<{ source?: string; excerpt?: string; content?: string; title?: string }>
  sources?: unknown[]
  handoff?: { summary?: string; evidenceRefs?: unknown[] }
  agentResult?: { ok?: boolean; sources?: unknown[]; structured?: { evidence_count?: number } }
}

/** 从 run evidence 统计 RAG 证据单元（hits / citations / sources） */
export function extractRagEvidenceUnitsFromRun(
  evidence?: Array<RagPassthroughEvidence> | null
): number {
  if (!Array.isArray(evidence)) return 0
  let units = 0
  for (const ev of evidence) {
    if (String(ev?.kind ?? '') !== 'rag') continue
    units += Number(ev?.hits ?? 0) || 0
    if (Array.isArray(ev?.citations)) units += ev.citations.length
    if (Array.isArray(ev?.sources)) units += ev.sources.length
    const refs = ev?.handoff?.evidenceRefs
    if (Array.isArray(refs)) units += refs.length
    const structuredCount = Number(ev?.agentResult?.structured?.evidence_count ?? 0)
    if (structuredCount > 0) units += structuredCount
    const agentSources = ev?.agentResult?.sources
    if (Array.isArray(agentSources)) units += agentSources.length
  }
  return units
}

function paragraphLooksLikeRagMissOnly(paragraph: string): boolean {
  const t = String(paragraph || '').trim()
  if (!t) return true
  if (!textIncludesAny(t, RAG_EMPTY_ANSWER_MARKERS)) return false
  if (t.length >= 180) return false
  // 短「未找到」引导段；含明确数字/条款的长段视为已有实质内容
  if (/\d+(?:\.\d+)?/.test(t) && t.length >= 24) return false
  return true
}

function buildRagEvidenceExcerptFallback(
  evidence?: Array<RagPassthroughEvidence> | null
): string | null {
  if (!Array.isArray(evidence)) return null
  const lines: string[] = []
  for (const ev of evidence) {
    if (String(ev?.kind ?? '') !== 'rag') continue
    const handoff = String(ev?.handoff?.summary || '').trim()
    if (handoff.length >= 16 && !textIncludesAny(handoff, RAG_EMPTY_ANSWER_MARKERS)) {
      lines.push(handoff)
    }
    for (const c of ev?.citations || []) {
      const excerpt = String(c?.excerpt || c?.content || '').replace(/\s+/g, ' ').trim()
      const source = String(c?.source || c?.title || '').trim()
      if (excerpt.length >= 12) {
        lines.push(source ? `[${source}] ${excerpt.slice(0, 280)}` : excerpt.slice(0, 280))
      }
    }
    if (lines.length >= 3) break
  }
  if (!lines.length) return null
  return `根据知识库文档：\n${lines.slice(0, 3).join('\n')}`
}

/** 去掉重复段落（RAG 假阴性 + 重试后常见整段重复） */
export function dedupeRepeatedRagBlocks(text: string): string {
  const parts = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return String(text || '').trim()
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const key = p.replace(/\s+/g, ' ').slice(0, 160)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out.join('\n\n').trim()
}

/**
 * 有 evidence 时剥离开头假「未找到」引导，保留实质回答；必要时用 citation 兜底。
 * 用于 synth 直通与 RAG 步输出归一（非用户原话 regex 路由）。
 */
export function normalizeRagAnswerForPassthrough(input: {
  text: string
  evidence?: Array<RagPassthroughEvidence> | null
}): string {
  const raw = dedupeRepeatedRagBlocks(String(input.text || '').trim())
  if (!raw) return raw
  const units = extractRagEvidenceUnitsFromRun(input.evidence)
  if (units <= 0) return raw
  if (!textIncludesAny(raw, RAG_EMPTY_ANSWER_MARKERS)) return raw

  const paragraphs = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length >= 2) {
    let start = 0
    while (start < paragraphs.length - 1 && paragraphLooksLikeRagMissOnly(paragraphs[start]!)) {
      start += 1
    }
    const body = paragraphs.slice(start).join('\n\n').trim()
    if (body && !paragraphLooksLikeRagMissOnly(body)) return body
  }

  const sentences = raw.split(/(?<=[。！？!?])\s+/).map((s) => s.trim()).filter(Boolean)
  if (sentences.length >= 2 && textIncludesAny(sentences[0]!, RAG_EMPTY_ANSWER_MARKERS)) {
    const rest = sentences.slice(1).join(' ').trim()
    if (rest.length >= 20 && !textIncludesAny(rest, RAG_EMPTY_ANSWER_MARKERS)) return rest
  }

  const fallback = buildRagEvidenceExcerptFallback(input.evidence)
  if (fallback) return fallback
  return raw
}

export function resolveRagPassthroughText(input: {
  text: string
  evidence?: Array<RagPassthroughEvidence> | null
}): string {
  return normalizeRagAnswerForPassthrough(input)
}

/** 有 evidence 且归一后仍有实质内容 → 不应再当 miss */
export function ragPassthroughHasSubstantiveAnswer(input: {
  text: string
  evidence?: Array<RagPassthroughEvidence> | null
}): boolean {
  const normalized = resolveRagPassthroughText(input)
  if (!normalized || normalized.length < 12) return false
  const units = extractRagEvidenceUnitsFromRun(input.evidence)
  if (units <= 0) return !textIncludesAny(normalized, RAG_EMPTY_ANSWER_MARKERS)
  return !paragraphLooksLikeRagMissOnly(normalized)
}

/** 单源 RAG 且知识库已有非空结论 → chat 模式可直通；单源薄编排时专业模式也可直通 */
export function shouldPassthroughRagOnly(input: {
  intent?: string
  planSteps?: Array<{ agent?: string }>
  results?: Record<string, unknown> | null
  evidence?: Array<{ kind?: string; empty?: boolean; agentResult?: { ok?: boolean } }> | null
  meta?: unknown
  professionalMode?: boolean
}): boolean {
  const meta = input.meta
  const thickness =
    meta && typeof meta === 'object'
      ? String((meta as Record<string, unknown>).orchestrationThickness || '')
      : ''
  if (thickness === 'single_source') {
    /* 单源薄编排走 light synth，不整段跳过汇总 */
    return false
  } else if (input.professionalMode === true) return false
  const rag = String(input.results?.rag ?? '').trim()
  if (!rag || rag.length < 8) return false

  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const stepAgents = steps.map((s) => String(s?.agent ?? '')).filter(Boolean)
  if (stepAgents.includes('report') || stepAgents.includes('clean') || stepAgents.includes('code')) return false
  if (wantsNarrativeReportSynth({ meta: input.meta, planSteps: input.planSteps })) return false

  const ragEv = (Array.isArray(input.evidence) ? input.evidence : []).find(
    (e) => String(e?.kind ?? '') === 'rag'
  )
  if (ragEv?.empty) return false
  if (ragEv?.agentResult?.ok === false) return false

  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const normalized = resolveRagPassthroughText({ text: rag, evidence })
  if (!ragPassthroughHasSubstantiveAnswer({ text: rag, evidence })) return false
  if (textIncludesAny(normalized, RAG_EMPTY_ANSWER_MARKERS) && normalized.length < 120) return false

  const otherAgents = [
    'db',
    'crawler',
    'code',
    'admin',
    'gui',
    'clean',
    'visualize',
    'report',
    'music',
    'video',
    'multimodal'
  ]
  const hasOtherOutput = otherAgents.some((a) => String(input.results?.[a] ?? '').trim().length > 0)
  if (hasOtherOutput) return false

  const intent = String(input.intent ?? '').trim()

  if (intent === 'rag') return true

  if (intent === 'multi') {
    if (stepAgents.length === 0) return true
    if (stepAgents.length === 1 && stepAgents[0] === 'rag') return true
    const dataAgents = ['db', 'rag', 'crawler', 'code'].filter((a) => stepAgents.includes(a))
    if (dataAgents.length === 1 && dataAgents[0] === 'rag') return true
  }

  return false
}

const NARRATIVE_AGENTS = [
  'rag',
  'db',
  'crawler',
  'code',
  'gui',
  'clean',
  'visualize',
  'report',
  'music',
  'video',
  'multimodal'
] as const

/** admin 写操作文本是否像成功确认（非 pending / 失败 / 纯 preamble） */
function looksLikeSuccessfulAdminWrite(admin: string): boolean {
  const t = String(admin || '').trim()
  if (!t || t.length < 4) return false
  if (/【待确认】/.test(t)) return false
  if (/未确认，未写入/.test(t)) return false
  if (/未能完成写操作|工具未成功|无法成功设置|协议异常/.test(t)) return false
  const head = t.slice(0, 120).toLowerCase()
  if (head.includes('失败') || head.includes('error')) return false
  // 整段几乎只有能力清单
  if (/仅处理下列个人助理能力/.test(t)) {
    const withoutPreamble = t
      .replace(/(?:^|\n)(?:admin\s*[:：]\s*|error\s*[:：]\s*)?仅处理下列个人助理能力[^\n]*/gi, '')
      .replace(/(?:^|\n)·\s*(邮件|联系人|待办|日程|天气|高德|飞书)[：:][^\n]*/gi, '')
      .trim()
    if (withoutPreamble.length < 8) return false
  }
  return true
}

/**
 * 单步/纯 admin 写成功 → synth 直通短确认（跳过 500～800 字报告体 LLM）。
 * 复杂 multi（admin + 取数/出图等）仍走叙述汇总。
 */
export function shouldPassthroughAdminWriteOnly(input: {
  intent?: string
  planSteps?: Array<{ agent?: string }>
  results?: Record<string, unknown> | null
  evidence?: Array<{ kind?: string; failed?: boolean; agentResult?: { ok?: boolean } }> | null
}): boolean {
  const admin = String(input.results?.admin ?? '').trim()
  if (!looksLikeSuccessfulAdminWrite(admin)) return false

  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const hasFailedAdmin = evidence.some(
    (e) =>
      String(e?.kind || '') === 'admin' &&
      (e?.failed === true || e?.agentResult?.ok === false)
  )
  if (hasFailedAdmin) return false

  if (NARRATIVE_AGENTS.some((a) => String(input.results?.[a] ?? '').trim().length > 0)) return false

  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const stepAgents = steps.map((s) => String(s?.agent ?? '').trim()).filter(Boolean)
  if (stepAgents.some((a) => (NARRATIVE_AGENTS as readonly string[]).includes(a))) return false

  const intent = String(input.intent ?? '').trim()
  if (intent === 'admin') return true
  if (stepAgents.length === 0) return true
  if (stepAgents.every((a) => a === 'admin')) return true
  return false
}

/** 路由未含 crawler/媒体时 SERP 无下游，结构性跳过 web_search */
export function shouldSkipWebSearchStructurally(input: {
  allowedAgents?: string[]
  intent?: string
}): string | null {
  const agents = new Set(
    (Array.isArray(input.allowedAgents) ? input.allowedAgents : []).map((a) => String(a ?? '').trim()).filter(Boolean)
  )
  const hasSerpConsumer = agents.has('crawler') || agents.has('music') || agents.has('video')
  if (hasSerpConsumer) return null

  const intent = String(input.intent ?? '').trim()
  if (intent === 'db' || intent === 'rag') {
    return '路由无 crawler/媒体步骤，跳过 web_search（SERP 无下游）'
  }
  if (intent === 'multi' && (agents.has('db') || agents.has('rag')) && !hasSerpConsumer) {
    return '多步任务无 crawler/媒体，跳过 web_search'
  }
  return null
}
