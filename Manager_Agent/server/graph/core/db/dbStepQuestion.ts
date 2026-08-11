/**
 * 总管 → DB 问句对齐：优先编排 blueprint / taskClauses（结构化），复合任务再交 LLM 拆解。
 * 避免 regex 切句与整句 prefetch 污染 DB schema 接地。
 */
import { collectSubAgentScopeCandidates, pickSubAgentScopeSync } from '../../../utils/route/managerSubAgentScopeLlm'
import { buildAgentScopedQuery, clausesFromMeta } from '../routing/clauses'
import {
  isSingleSourceDbTask,
  isTrueMultiTask
} from '../routing/subAgentPassthrough'
import { sanitizeConstraintBlockForDbAgent } from '../text'
import { groundFollowupQuery, shouldGroundFollowupQuery } from '#agent-shared/followupQueryGrounding'
import { sessionIntentAnchorFromMeta } from '../memory/multiTurnIntent'

export { isSingleSourceDbTask, isTrueMultiTask } from '../routing/subAgentPassthrough'

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

function hasPlannerArtifacts(raw: string): boolean {
  const s = String(raw ?? '')
  if (!s.trim()) return false
  if (DB_STEP_PREFIXES.some((p) => s.startsWith(p))) return true
  if (/\n\n\[(?:约束|上下文|上游|步骤|总管)/.test(s)) return true
  if (/\n\n约束[:：]/.test(s)) return true
  if (/`[A-Za-z][A-Za-z0-9_]{2,}`/.test(s)) return true
  if (/\b(SELECT|FROM|JOIN|WHERE|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN)\b/i.test(s)) return true
  if (/(?:关联|连接|联表|join)\s*[：:]?\s*[A-Za-z][A-Za-z0-9_]{3,}/i.test(s)) return true
  if (/(?:表|table)\s*[：:]?\s*[A-Za-z][A-Za-z0-9_]{3,}/i.test(s)) return true
  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/i.test(s)) return true
  return false
}

/**
 * 清洗 Planner/步骤文案中的表名与 SQL 片段。
 * 纯用户 NL（无 planner 痕迹）原样返回，避免与独立端分叉。
 */
export function sanitizeSubAgentBusinessQuestion(raw: string): string {
  const original = String(raw ?? '').trim()
  if (!original) return original
  if (!hasPlannerArtifacts(original)) {
    return stripPlanConstraintsFromQuery(original)
  }
  let s = stripPlanConstraintsFromQuery(stripDbManagerPrefixes(original))
  if (!s) return original
  s = s.replace(/`([A-Za-z][A-Za-z0-9_]{2,})`/g, '')
  s = s.replace(/\b(SELECT|FROM|JOIN|WHERE|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|ON)\b[\s\S]{0,120}/gi, ' ')
  s = s.replace(
    /(?:关联|连接|联表|join)\s*[：:]?\s*[A-Za-z][A-Za-z0-9_]{3,}(?:\s*(?:和|与|,|，|、)\s*[A-Za-z][A-Za-z0-9_]{3,})*/gi,
    ' '
  )
  s = s.replace(/(?:表|table)\s*[：:]?\s*[A-Za-z][A-Za-z0-9_]{3,}/gi, ' ')
  s = s.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/gi, (tok) => {
    const t = tok.toLowerCase()
    if (/_(?:log|info|record|detail|measure|activity|remote|person|nursing|foot)/.test(t)) return ' '
    if (t.split('_').length >= 3) return ' '
    return tok
  })
  s = s.replace(/[（(]\s*[)）]/g, ' ')
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*([，,。；;])\s*/g, '$1').trim()
  s = s.replace(/^[，,。；;\s]+|[，,。；;\s]+$/g, '').trim()
  return s || original
}

/** 多步/多子句才锁编排 DB 子问句；单源与假 multi 不锁 */
export function hasOrchestratedDbScope(meta: unknown): boolean {
  if (isSingleSourceDbTask(meta)) return false
  if (!isTrueMultiTask(meta)) return false
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
  const turnKind = String((meta as { turnKind?: string } | null)?.turnKind || '').trim()
  const anchor = sessionIntentAnchorFromMeta(meta)?.coalescedTask || ''

  // 短承接：单源也不得用裸「再详细一点」；锚定上轮任务
  if (
    shouldGroundFollowupQuery({ turnKind, lastUser: last, anchorTask: anchor }) &&
    isSingleSourceDbTask(meta)
  ) {
    return groundFollowupQuery({
      lastUser: last,
      turnKind,
      anchorTask: anchor,
      candidate: step.length >= 4 ? step : last
    })
  }

  // 单源 db：始终用户原话（等同独立端）；勿 sanitize 改写用户 NL
  if (isSingleSourceDbTask(meta) && last.length >= 4) {
    return last
  }

  // 真 multi：编排子句 / queryFocus（一次切分）
  if (isTrueMultiTask(meta)) {
    const fromOrchestration = dbQueryFocusFromMeta(meta, step)
    if (fromOrchestration.length >= 4) {
      const cleaned = sanitizeSubAgentBusinessQuestion(fromOrchestration)
      if (shouldGroundFollowupQuery({ turnKind, lastUser: last, anchorTask: anchor })) {
        return groundFollowupQuery({
          lastUser: last,
          turnKind,
          anchorTask: anchor,
          candidate: cleaned
        })
      }
      return cleaned
    }
  }

  if (step.length >= 4) {
    const cleaned = sanitizeSubAgentBusinessQuestion(step)
    if (shouldGroundFollowupQuery({ turnKind, lastUser: last, anchorTask: anchor })) {
      return groundFollowupQuery({
        lastUser: last,
        turnKind,
        anchorTask: anchor,
        candidate: cleaned
      })
    }
    return cleaned
  }
  if (last.length >= 4) {
    return last
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
