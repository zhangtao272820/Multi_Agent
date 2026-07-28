export type Role = 'user' | 'assistant' | 'system'
export type ChatMessage = { role: Role; content: string }
export type RagHistoryMessage = { role: Role; content: string }

/** E2：跨 Agent 统一结果契约 */
export type AgentSource = { type: 'url' | 'doc' | 'table' | 'sql'; ref: string }

/** A2：专才 → 父编排结构化交接（父只吃摘要，全文按 rawRef 按需取） */
export type SpecialistHandoff = {
  summary: string
  evidenceRefs: string[]
  confidence: number
  failure?: { code: string; message: string }
  rawRef?: string
}

export type AgentResult = {
  ok: boolean
  agent: string
  trace_id?: string
  answer?: string
  sources?: AgentSource[]
  structured?: Record<string, unknown>
  needs_clarify?: boolean
  clarify_questions?: string[]
  needs_human_confirm?: boolean
  error_code?: string
  latency_ms?: number
  /** E3：可选用量；actual=提供商回传，缺省由总管估算 */
  usage?: { tokens?: number; usd?: number; actual?: boolean }
  /** A2 结构化 handoff（可选，优先于全文 answer 注入父上下文） */
  handoff?: SpecialistHandoff
}

export type RagCitation = {
  source: string
  title?: string
  url?: string
  page?: number
  chunkId?: string
  score?: number
  excerpt?: string
}

export type RagEvidence = { kind: 'rag'; query: string; hits?: number; citations: RagCitation[]; agentResult?: AgentResult }

export type DbResult = {
  answer: string
  empty: boolean
  reason?: string
  run_id?: string
  trace_id?: string
  transport: 'http' | 'ws'
  /** E2 结构化视图（可选，供 synth/critic） */
  agentResult?: AgentResult
}

export type CodeTransportMetrics = {
  wall_ms: number
  inference_ms: number
  attempts: number
  retry_wait_ms: number
  transport?: 'http' | 'ws'
  cached?: boolean
}

export type CodeEditPreviewMeta = {
  files?: string[]
  unified_diff?: string
  diff_stat?: string
  branch?: string
}

export type CodeAgentMeta = {
  task_kind?: string
  files_touched?: string[]
  validate_ok?: boolean
  tool_calls?: number
  needsClarify?: boolean
  needs_clarification?: boolean
  clarifyQuestions?: string[]
  questions?: string[]
  clarifyChips?: string[]
  missing_slots?: string[]
  edit_preview?: CodeEditPreviewMeta
  unified_diff?: string
  diff_stat?: string
  branch?: string
  /** §2.8.5：与专家 AgentResult.error_code 对齐 */
  error_code?: string
}

export type CodeAgentResult = {
  answer: string
  meta?: CodeAgentMeta
  trace_id?: string
  agentResult?: AgentResult
  transportMetrics?: CodeTransportMetrics
}

/** E2：admin / 媒体类 Agent 统一返回 */
export type MediaAgentCallResult = {
  answer: string
  agentResult?: AgentResult
  raw?: unknown
}
