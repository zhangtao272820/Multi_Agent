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

/** 单源 DB 且库内已有非空结果 → chat 模式可直通；专业模式走 Synth LLM（流式+叙述） */
export function shouldPassthroughDbOnly(input: {
  intent?: string
  planSteps?: Array<{ agent?: string }>
  results?: Record<string, unknown> | null
  evidence?: Array<{ kind?: string; empty?: boolean }> | null
  meta?: unknown
  /** 专业工作台：禁止直通，须 Synth 归纳解释 */
  professionalMode?: boolean
}): boolean {
  if (input.professionalMode === true) return false
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
  '未找到相关背景信息',
  'RAG_NEEDS_CLARIFY',
  '【需要补充信息】'
] as const

/** 单源 RAG 且知识库已有非空结论 → chat 模式可直通；专业模式走 Synth LLM */
export function shouldPassthroughRagOnly(input: {
  intent?: string
  planSteps?: Array<{ agent?: string }>
  results?: Record<string, unknown> | null
  evidence?: Array<{ kind?: string; empty?: boolean; agentResult?: { ok?: boolean } }> | null
  meta?: unknown
  professionalMode?: boolean
}): boolean {
  if (input.professionalMode === true) return false
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

  if (textIncludesAny(rag, RAG_EMPTY_ANSWER_MARKERS) && rag.length < 120) return false

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
