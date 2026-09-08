/**
 * RAG 检索指令拼装（结构化模板，主题扩展与完整性由模型裁判负责）。
 */
import {
  extractManagerCoreQuestion,
  inferManagerRagSubQueries,
  resolveLeanSubAgentQuery,
  splitCompoundQueries,
  stripPlanConstraintsFromQuery,
  type ManagerRagTaskPayload,
} from '#agent-shared/managerSubAgentProtocol'
import { buildTurnScopePayload, parseTurnScopeMode, type TurnScopePayload } from '#agent-shared/turnScope'

export type RagProbeHint = { hasDocs?: boolean; hits?: number; sources?: string[]; snippets?: string[] }

export { stripPlanConstraintsFromQuery }

export function isRetrieverPlanEnabled() {
  const v = String(process.env.MANAGER_RETRIEVER_PLAN ?? '1').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

function compactQuery(q: string, max = 900) {
  const s = String(q ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 复合句中偏公网/爬虫的子句，不宜作为 RAG 预取问句 */
function looksLikeWebOnlyClause(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (/公开网站|公网|联网|搜索引擎|SERP|crawler|网页抓取/.test(t) && !/知识库|文档|库内/.test(t)) return true
  return false
}

/** 从「知识库…，再从公网…」类复合句抽出 RAG 子句并去掉包装前缀 */
export function extractRagClauseFromCompound(text: string): string {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const parts = splitCompoundQueries(raw)
  for (const p of parts) {
    if (/知识库|文档库|库内|私有知识|已索引|个人.*财务|月度财务/.test(p) && !looksLikeWebOnlyClause(p)) {
      return normalizeRagPrefetchClause(p)
    }
  }
  if (/知识库|文档库|库内/.test(raw) && !looksLikeWebOnlyClause(raw)) {
    return normalizeRagPrefetchClause(raw)
  }
  return ''
}

export function normalizeRagPrefetchClause(clause: string): string {
  let s = String(clause ?? '').trim()
  s = s
    .replace(/^在知识库中检索/, '')
    .replace(/^从知识库中检索/, '')
    .replace(/^知识库检索/, '')
    .replace(/^请从知识库检索/, '')
    .trim()
  return s.length >= 4 ? s : String(clause ?? '').trim()
}

/**
 * RAG 预取专用 lean 问句：复合任务只取知识库子句，避免 multi_part 导致 RAG 端 0 命中。
 */
export function resolveRagPrefetchLeanQuery(input: {
  lastUser: string
  planRagFocus?: string
  routedQuery?: string
  coalescedTask?: string
}): string {
  const last = String(input.lastUser ?? '').trim()
  for (const raw of [input.planRagFocus, input.routedQuery, input.coalescedTask]) {
    const candidate = String(raw ?? '').trim()
    if (candidate.length < 4 || looksLikeWebOnlyClause(candidate)) continue
    const lean = resolveLeanRagQuery(candidate, last)
    if (lean.length >= 4 && !looksLikeWebOnlyClause(lean)) {
      const fromCompound = extractRagClauseFromCompound(lean)
      return fromCompound || normalizeRagPrefetchClause(lean) || lean
    }
  }
  const fromLast = extractRagClauseFromCompound(last)
  if (fromLast.length >= 4) return fromLast
  const lean = resolveLeanRagQuery(last, last)
  return normalizeRagPrefetchClause(lean) || lean || last
}

/** 预取侧车：禁止 multi_part / force_deep，与 RAG /api/probe 快路径对齐 */
export function buildRagPrefetchTaskPayload(input: {
  ragLeanQuery: string
  userTask?: string
  turnScopeMode?: string | null
  turnKind?: string | null
}): ManagerRagTaskPayload {
  const lean = String(input.ragLeanQuery ?? '').trim()
  const mode = parseTurnScopeMode(input.turnScopeMode)
  const turn_scope: TurnScopePayload | undefined = mode
    ? buildTurnScopePayload(mode, input.turnKind)
    : undefined
  return {
    source: 'manager',
    lean_query: lean,
    query_intent: 'fact_lookup',
    force_deep_retrieval: false,
    output_style: 'manager_bullets',
    turn_scope
  }
}

/** RAG 预取/retrieve 用：去掉约束后缀与总管模板包装，避免向 RAG 发送空 query */
export function resolveLeanRagQuery(stepOrRouted: string, lastUserMessage = ''): string {
  const last = String(lastUserMessage ?? '').trim()
  const raw = String(stepOrRouted ?? '').trim()
  return (
    resolveLeanSubAgentQuery(
      [extractManagerCoreQuestion(raw) || '', stripPlanConstraintsFromQuery(raw), raw],
      last
    ) ||
    last ||
    raw
  )
}

/** 总管 → RAG 结构化侧车（与 message 模板双轨；子 Agent 优先读此 JSON） */
export function buildManagerRagTaskPayload(input: {
  leanQuery: string
  scopeHint?: string
  subQueries?: string[]
  userTask?: string
  retrievalKeywords?: string[]
  excludeHints?: string[]
  queryIntent?: string
  turnScopeMode?: string | null
  turnKind?: string | null
  imageCaption?: string
}): ManagerRagTaskPayload {
  const leanBase = String(input.leanQuery ?? '').trim()
  const caption = String(input.imageCaption || '').trim().slice(0, 80)
  const lean =
    caption && leanBase && !leanBase.includes(caption)
      ? `${leanBase}（图意：${caption}）`.slice(0, 900)
      : leanBase
  const userTask = String(input.userTask ?? '').trim()
  const mode = parseTurnScopeMode(input.turnScopeMode)
  const turn_scope: TurnScopePayload | undefined = mode
    ? buildTurnScopePayload(mode, input.turnKind)
    : undefined
  const sub =
    (input.subQueries || []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6) ||
    inferManagerRagSubQueries(userTask, lean)
  const scope = String(input.scopeHint || '').trim()
  const forceDeep = scope.length > 100 || sub.length >= 3
  const dialogAnchor =
    !turn_scope?.suppress_anchor && userTask.length > lean.length + 12 && userTask !== lean
      ? userTask.slice(0, 600)
      : undefined
  const keywords = [
    ...(input.retrievalKeywords || []).filter(Boolean),
    ...(caption ? [caption] : [])
  ].slice(0, 12)
  const exclude = (input.excludeHints || []).filter(Boolean).slice(0, 8)
  return {
    source: 'manager',
    lean_query: lean || sub[0] || '',
    scope_hint: scope || undefined,
    sub_queries: sub.length ? sub : undefined,
    dialog_anchor: dialogAnchor,
    retrieval_keywords: keywords.length ? keywords : undefined,
    query_intent: sub.length >= 2 ? 'multi_part' : input.queryIntent || undefined,
    force_deep_retrieval: forceDeep || undefined,
    output_style: 'manager_bullets',
    exclude_hints: exclude.length ? exclude : undefined,
    turn_scope,
    ...(caption ? { image_caption: caption } : {})
  }
}

/**
 * @param scopeHint 由模型生成的检索范围说明（可选，来自 createRagScopeHintJudge）
 * @param retrievalKeywords / excludeHints 保留参数兼容；透传协议下不写入 message/sidecar
 */
export function buildRagRetrievalMessage(
  userTask: string,
  stepQuery: string,
  probeRag?: RagProbeHint | null,
  _scopeHint?: string,
  planSidecar?: { retrievalKeywords?: string[]; excludeHints?: string[]; turnScopeMode?: string | null; turnKind?: string | null }
) {
  const stripped = stripPlanConstraintsFromQuery(String(stepQuery || userTask || '').trim())
  const leanQuery =
    resolveLeanRagQuery(String(stepQuery || userTask || '').trim(), String(userTask || '').trim()) ||
    compactQuery(stripped) ||
    compactQuery(stripPlanConstraintsFromQuery(String(userTask || '').trim()))
  const hits = Number(probeRag?.hits ?? 0) || 0
  const sources = Array.isArray(probeRag?.sources)
    ? probeRag!.sources!.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    : []
  // 透传：message = lean NL，不包装【检索任务】、不带 managerRagTask
  return {
    message: leanQuery,
    leanQuery,
    managerRagTask: undefined,
    meta: {
      mode: 'passthrough' as const,
      probeHits: hits,
      sourceCount: sources.length,
      turnScopeMode: planSidecar?.turnScopeMode ?? null,
      turnKind: planSidecar?.turnKind ?? null
    }
  }
}
