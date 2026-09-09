/**
 * 总管 → AI_admin 结构化侧车（client_context.manager_task）
 * 对齐 AI_admin normalize_manager_task / passthrough_manager_tool_plan。
 */
import {
  inferAdminTaskFromActionText,
  isAdminLegacyInferEnabled,
  normalizeAdminToolPlan
} from '#agent-shared/adminCapabilities'
import { type TurnScopePayload } from '#agent-shared/turnScope'
import { stripAdminManagerGuards } from '../route/managerSubAgentHelpers'
import { resolveSubAgentTurnScope, resolveTurnScopeFromMeta } from '../../graph/core/runtime/sessionBridge'
import { collectSubAgentScopeCandidates, pickSubAgentScopeSync } from '../route/managerSubAgentScopeLlm'
import { clausesFromMeta } from '../../graph/core/routing/clauses'
import { stepDispatchDraftFromMeta } from '../../graph/core/proPuStack'
import {
  postureForcesReadOnly,
  resolveCollaborationPosture
} from '../platform/collaborationPosture'
import type { SpecialistBrief } from '#agent-shared/specialistBrief'

export type { TurnScopePayload }

/** 可写字段权威原话上限（标题/详细内容/邮件正文等） */
export const SOURCE_USER_TASK_MAX = 2000

export type ManagerAdminTaskPayload = {
  source: 'manager'
  action_text: string
  /**
   * 用户末轮原话（可写字段权威来源）。
   * scoped action_text 可摘要职责；description/content 等 args 须以本字段为准。
   */
  source_user_task?: string
  intent_hint?: string
  tool_plan?: Array<{ name: string; args: Record<string, unknown> }>
  read_only?: boolean
  /** 复合 admin 多子句（对齐 RAG sub_queries） */
  sub_queries?: string[]
  turn_scope?: TurnScopePayload
  /** Phase D：编排态 Outcome Brief（单源不传） */
  specialist_brief?: SpecialistBrief
}

/** 总管可编排范围内的只读工具（与 MANAGER_ADMIN_TOOL_NAMES 对齐） */
const READ_ONLY_ADMIN_TOOLS = new Set([
  'get_travel_route',
  'search_nearby_amap',
  'search_places_amap',
  'resolve_address_amap',
  'suggest_address_amap',
  'locate_coordinates_amap',
  'get_weather',
  'list_events',
  'list_tasks',
  'list_emails',
  'search_emails',
  'mark_email_read',
  'list_contacts',
  'search_contact',
  'get_contact_email',
  'list_reminders',
  'draft_email_reply',
  'list_email_attachments'
])

function orchestratedToolPlanFromMeta(meta: unknown): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  const m = meta as { adminToolPlan?: unknown; managerAdminToolPlan?: unknown } | null
  const raw = m?.adminToolPlan ?? m?.managerAdminToolPlan
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const name = String((item as { name?: string }).name ?? '').trim()
      const args = (item as { args?: Record<string, unknown> }).args
      if (!name) return null
      return { name, args: args && typeof args === 'object' ? { ...args } : {} }
    })
    .filter(Boolean) as Array<{ name: string; args: Record<string, unknown> }>
  return out.length ? out : undefined
}

/** 从编排 clauses / stepDispatchDraft 收集 admin 子问句 */
export function adminSubQueriesFromMeta(meta: unknown, actionText = ''): string[] {
  const out: string[] = []
  const push = (t: string) => {
    const s = stripAdminManagerGuards(String(t || '').trim())
    if (s.length >= 4 && !out.includes(s)) out.push(s.slice(0, 480))
  }
  for (const d of stepDispatchDraftFromMeta(meta)) {
    if (String(d.agent) === 'admin') push(d.scopedUserLanguage)
  }
  for (const c of clausesFromMeta(meta)) {
    if (c.agents?.includes('admin')) push(c.text)
  }
  if (out.length >= 2) return out.slice(0, 6)
  const scoped = adminScopedQueryFromMeta(meta, actionText)
  if (scoped) push(scoped)
  return out.length >= 2 ? out.slice(0, 6) : []
}

/** 从 PU stepDispatchDraft / taskClauses / stepQuery / 蓝图 queryFocus 取 admin 子问句（同步优先级） */
export function adminScopedQueryFromMeta(meta: unknown, stepQuery = ''): string {
  const candidates = collectSubAgentScopeCandidates('admin', meta, stepQuery)
  return pickSubAgentScopeSync(candidates)
}

export function buildManagerAdminTaskPayload(input: {
  actionText: string
  meta?: unknown
  /** LLM/编排已选定的 scope，跳过 sync 再解析 */
  scopedText?: string
  /** 用户末轮原话：可写字段（详细内容/邮件正文等）权威来源 */
  sourceUserTask?: string
  /** 编排 LLM 已产出且过 Zod 的 tool_plan（优先于 legacy infer） */
  orchestratedToolPlan?: Array<{ name: string; args: Record<string, unknown> }>
  orchestratedIntentHint?: string
  /** Phase D Outcome Brief（仅编排 multi/hub） */
  specialistBrief?: SpecialistBrief | null
}): ManagerAdminTaskPayload {
  const scoped =
    String(input.scopedText || '').trim() ||
    adminScopedQueryFromMeta(input.meta, input.actionText) ||
    String(input.actionText || '').trim().slice(0, 480)
  const fallbackLines = String(input.scopedText || input.actionText || '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && !l.startsWith('仅处理下列') && !l.startsWith('【总管') && !l.startsWith('· '))
  const action =
    stripAdminManagerGuards(scoped) ||
    stripAdminManagerGuards(String(input.actionText || '').trim()) ||
    (fallbackLines.length ? fallbackLines.join('，') : '') ||
    String(input.actionText || '').trim().slice(0, 480)

  const sourceUserTask = String(input.sourceUserTask || '')
    .trim()
    .slice(0, SOURCE_USER_TASK_MAX)
  // 可写字段规划优先用原话；scoped action 仅作职责焦点
  const fieldAuthority = sourceUserTask || action

  const fromMeta = orchestratedToolPlanFromMeta(input.meta)
  let tool_plan = normalizeAdminToolPlan(
    fieldAuthority,
    input.orchestratedToolPlan?.length ? input.orchestratedToolPlan : fromMeta
  )
  let intent_hint = String(input.orchestratedIntentHint || '').trim() || undefined

  if (!tool_plan?.length && isAdminLegacyInferEnabled()) {
    const inferred = inferAdminTaskFromActionText(fieldAuthority)
    tool_plan = normalizeAdminToolPlan(fieldAuthority, inferred.tool_plan)
    intent_hint = intent_hint || inferred.intent_hint
  }

  const turnScope = resolveSubAgentTurnScope(input.meta) ?? resolveTurnScopeFromMeta(input.meta)
  const sub_queries = adminSubQueriesFromMeta(input.meta, action)
  const posture = resolveCollaborationPosture(input.meta)
  const readOnly =
    postureForcesReadOnly(posture) ||
    (tool_plan?.length === 1 && READ_ONLY_ADMIN_TOOLS.has(String(tool_plan[0]?.name || '')))

  const brief = input.specialistBrief || undefined

  return {
    source: 'manager',
    action_text: action,
    ...(sourceUserTask ? { source_user_task: sourceUserTask } : {}),
    ...(intent_hint ? { intent_hint } : {}),
    ...(tool_plan?.length ? { tool_plan } : {}),
    ...(sub_queries.length >= 2 ? { sub_queries } : {}),
    ...(readOnly ? { read_only: true } : {}),
    ...(turnScope ? { turn_scope: turnScope } : {}),
    ...(brief ? { specialist_brief: brief } : {})
  }
}
