/**
 * 总管 envelope → TaskSpec（纯结构，无 LLM）
 */
import { isUserBrowserProfile, resolveBrowserProfile } from './browserProfiles'
import {
  LobsterTaskKindSchema,
  toLobsterTaskSpec,
  type LobsterTaskSpec,
  type LobsterTaskUnderstandParsed,
} from './lobsterTaskUnderstandSchema'

/** Manager envelope 直传字段 → TaskSpec（跳过 LLM） */
export function taskSpecFromManagerHints(input: {
  task: string
  startUrl?: string
  engineHint?: string
  intentHint?: string
  taskKind?: string
  needsLogin?: boolean
  siteRecipeId?: string
}): LobsterTaskSpec | null {
  const task = String(input.task || '').trim()
  if (!task) return null
  const engine = String(input.engineHint || 'auto').trim().toLowerCase()
  const engine_hint =
    engine === 'classic' ||
    engine === 'mcp' ||
    engine === 'stagehand' ||
    engine === 'desktop' ||
    engine === 'mobile'
      ? (engine as LobsterTaskUnderstandParsed['engine_hint'])
      : ('auto' as const)
  const kindParsed = LobsterTaskKindSchema.safeParse(String(input.taskKind || input.intentHint || '').trim())
  const task_kind = kindParsed.success ? kindParsed.data : 'unknown'
  const defaultProfile = isUserBrowserProfile() ? 'user' : resolveBrowserProfile()
  const row: LobsterTaskUnderstandParsed = {
    canonical_task: task,
    start_url: input.startUrl,
    engine_hint,
    task_kind,
    browser_profile: 'auto',
    intent_hint: String(input.intentHint || task_kind || '').trim() || undefined,
    needs_login: input.needsLogin === true || task_kind === 'login',
    explicitly_avoid_login: false,
    confidence: task_kind !== 'unknown' ? 0.9 : 0.85,
    rationale: input.siteRecipeId
      ? `manager_recipe:${input.siteRecipeId}`
      : task_kind !== 'unknown'
        ? `manager_envelope:${task_kind}`
        : 'manager_envelope',
    // plan_steps/goals 由 toLobsterTaskSpec 按 task_kind 兜底生成
  }
  return toLobsterTaskSpec(row, 'manager', defaultProfile)
}

/** 总管已给 form_fill/login 时优先保留，避免 Understand 误判成 search */
export function mergeManagerAndUnderstoodTaskSpec(
  managerSpec: LobsterTaskSpec | null | undefined,
  understood: LobsterTaskSpec | null | undefined,
): LobsterTaskSpec | null {
  if (!managerSpec && !understood) return null
  if (!managerSpec) return understood || null
  if (!understood) return managerSpec
  const mgrOperate = managerSpec.task_kind === 'form_fill' || managerSpec.task_kind === 'login'
  if (!mgrOperate) {
    return {
      ...understood,
      start_url: understood.start_url || managerSpec.start_url,
      needs_login: understood.needs_login || managerSpec.needs_login,
      plan_steps:
        understood.plan_steps?.length > 0 ? understood.plan_steps : managerSpec.plan_steps || [],
      goals: { ...managerSpec.goals, ...understood.goals },
    }
  }
  return {
    ...understood,
    task_kind: managerSpec.task_kind,
    needs_login: managerSpec.needs_login || understood.needs_login,
    intent_hint: managerSpec.intent_hint || understood.intent_hint,
    confidence: Math.max(understood.confidence, managerSpec.confidence),
    rationale: `manager_priority:${managerSpec.task_kind};${understood.rationale}`.slice(0, 320),
    source: 'manager',
    start_url: understood.start_url || managerSpec.start_url,
    // 操作类：engine_hint 保持 auto，由 resolveEngineFromTaskSpec 按 task_kind 软选 stagehand
    engine_hint: managerSpec.engine_hint !== 'auto' ? managerSpec.engine_hint : 'auto',
    plan_steps:
      understood.plan_steps?.length > 0 ? understood.plan_steps : managerSpec.plan_steps || [],
    goals: { ...managerSpec.goals, ...understood.goals },
  }
}
