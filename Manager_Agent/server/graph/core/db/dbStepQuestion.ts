/**
 * 总管 → DB 问句对齐：优先编排 blueprint / taskClauses（结构化），复合任务再交 LLM 拆解。
 * 避免 regex 切句与整句 prefetch 污染 DB schema 接地。
 */
import { collectSubAgentScopeCandidates, pickSubAgentScopeSync } from '../../../utils/route/managerSubAgentScopeLlm'
import { buildAgentScopedQuery, clausesFromMeta } from '../routing/clauses'
import { sanitizeConstraintBlockForDbAgent } from '../text'

const DB_STEP_PREFIXES = [
  '从数据库查询相关记录并返回结构化结果：',
  '从数据库查询相关记录并返回结构化结果:',
  '从数据库查询相关记录：',
  '从数据库查询相关记录:',
  '从数据库查询：',
  '从数据库查询:',
  '在数据库中查询：',
  '在数据库中查询:',
  '在数据库中查询 '
] as const

function stripDbManagerPrefixes(raw: string): string {
  let s = String(raw ?? '').trim()
  for (const p of DB_STEP_PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length).trim()
      break
    }
  }
  return s
}

function stripPlanConstraintsFromQuery(query: string): string {
  const markers = ['\n\n[约束', '\n\n[上下文', '\n\n[上游', '\n\n[步骤', '\n\n[总管', '\n\n约束：', '\n\n约束:']
  let out = String(query ?? '').trim()
  let cut = out.length
  for (const m of markers) {
    const i = out.indexOf(m)
    if (i >= 0 && i < cut) cut = i
  }
  return cut < out.length ? out.slice(0, cut).trim() : out
}

/**
 * 清洗 Planner/步骤文案中的表名与 SQL 片段（确定性文本处理，非用户意图识别）。
 * 避免「关联 remote_activity_foot_measure_log」污染 DB 独立 NLU。
 */
export function sanitizeSubAgentBusinessQuestion(raw: string): string {
  let s = stripPlanConstraintsFromQuery(stripDbManagerPrefixes(String(raw ?? '').trim()))
  if (!s) return s
  // 反引号 / 代码围栏中的标识符
  s = s.replace(/`([A-Za-z][A-Za-z0-9_]{2,})`/g, '')
  // 显式 SQL 片段
  s = s.replace(/\b(SELECT|FROM|JOIN|WHERE|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|ON)\b[\s\S]{0,120}/gi, ' ')
  // 「关联/连接/表 xxx_yyy」类 Planner 幻觉
  s = s.replace(
    /(?:关联|连接|联表|join)\s*[：:]?\s*[A-Za-z][A-Za-z0-9_]{3,}(?:\s*(?:和|与|,|，|、)\s*[A-Za-z][A-Za-z0-9_]{3,})*/gi,
    ' '
  )
  s = s.replace(/(?:表|table)\s*[：:]?\s*[A-Za-z][A-Za-z0-9_]{3,}/gi, ' ')
  // snake_case 表名 token（含 _log / _info 等）
  s = s.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/gi, (tok) => {
    const t = tok.toLowerCase()
    if (/_(?:log|info|record|detail|measure|activity|remote|person|nursing|foot)/.test(t)) return ' '
    if (t.split('_').length >= 3) return ' '
    return tok
  })
  s = s.replace(/[（(]\s*[)）]/g, ' ')
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*([，,。；;])\s*/g, '$1').trim()
  s = s.replace(/^[，,。；;\s]+|[，,。；;\s]+$/g, '').trim()
  return s || String(raw ?? '').trim()
}

/**
 * 是否单源 DB 任务：执行应透传用户原话，勿锁编排 queryFocus（与独立端 /api/ask 对齐）。
 */
export function isSingleSourceDbTask(meta: unknown): boolean {
  const m = (meta && typeof meta === 'object' ? meta : null) as Record<string, unknown> | null
  if (!m) return false
  const intent = String(
    m.intent || (m.intentClassify as { primaryIntent?: string } | undefined)?.primaryIntent || ''
  ).trim()
  if (intent === 'db') return true
  const shortcut = String(
    (m.intentClassify as { planShortcut?: string } | undefined)?.planShortcut || m.planShortcut || ''
  ).trim()
  if (shortcut === 'db_only') return true
  const allowed = Array.isArray(m.allowedAgents)
    ? (m.allowedAgents as unknown[]).map((a) => String(a || '').trim()).filter(Boolean)
    : []
  if (allowed.length === 1 && allowed[0] === 'db') return true
  const steps = Array.isArray((m.planBlueprint as { steps?: unknown[] } | undefined)?.steps)
    ? ((m.planBlueprint as { steps: Array<{ agent?: string }> }).steps || [])
    : []
  const stepAgents = steps.map((s) => String(s?.agent || '').trim()).filter(Boolean)
  if (stepAgents.length === 1 && stepAgents[0] === 'db') return true
  return false
}

/** 多步/多子句才锁编排 DB 子问句；单源 db 不锁，避免与独立端问句分叉 */
export function hasOrchestratedDbScope(meta: unknown): boolean {
  if (isSingleSourceDbTask(meta)) return false
  return dbQueryFocusFromMeta(meta).length >= 4
}

export function dbQueryFocusFromMeta(meta: unknown, stepQuery = ''): string {
  const candidates = collectSubAgentScopeCandidates('db', meta, stepQuery)
  const picked = pickSubAgentScopeSync(candidates)
  if (picked.length >= 4) {
    return stripDbManagerPrefixes(stripPlanConstraintsFromQuery(picked))
  }

  const clauses = clausesFromMeta(meta)
  if (clauses.length) {
    const m = meta as Record<string, unknown> | null
    const scoped = buildAgentScopedQuery('db', clauses, String(stepQuery || '').trim(), m)
    const clean = stripPlanConstraintsFromQuery(stripDbManagerPrefixes(scoped))
    if (clean.length >= 4) return clean
  }
  return ''
}

/** 同步解析：与 DB 直连时应一致的「纯 DB 问句」 */
export function resolveDbStepQuestionSync(
  stepOrRouted: string,
  lastUserMessage: string,
  meta?: unknown
): string {
  const step = sanitizeConstraintBlockForDbAgent(String(stepOrRouted ?? '').trim())
  const last = String(lastUserMessage ?? '').trim()

  const intent = String(
    (meta as { intent?: string; intentClassify?: { primaryIntent?: string } } | null)?.intent ||
      (meta as { intentClassify?: { primaryIntent?: string } } | null)?.intentClassify?.primaryIntent ||
      ''
  ).trim()

  // 单源 db：始终用户原话（等同独立端）；勿被同义 queryFocus 替换
  if ((intent === 'db' || isSingleSourceDbTask(meta)) && last.length >= 4) {
    return sanitizeSubAgentBusinessQuestion(last)
  }

  const fromOrchestration = dbQueryFocusFromMeta(meta, step)
  if (fromOrchestration.length >= 4) {
    return sanitizeSubAgentBusinessQuestion(fromOrchestration)
  }

  if (step.length >= 4) {
    return sanitizeSubAgentBusinessQuestion(step)
  }
  if (last.length >= 4) {
    return sanitizeSubAgentBusinessQuestion(last)
  }
  return sanitizeSubAgentBusinessQuestion(step || last)
}

/** prefetch / exec 共用：从 graph state 取 DB 子问句 */
export function resolveDbPrefetchQuestionFromState(
  state: { meta?: unknown; intent?: string; routedQuery?: string; messages?: unknown[] },
  lastUser: string,
  fallbackTask: string
): string {
  const routed = String(state.routedQuery || fallbackTask || '').trim()
  const stepHint = resolveDbStepQuestionSync(routed, lastUser, state.meta)
  if (stepHint.length >= 4) return stepHint
  return resolveDbStepQuestionSync(fallbackTask, lastUser, state.meta)
}
