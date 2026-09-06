/**
 * 总管 envelope → TaskSpec（纯结构，无 LLM）
 */
import { isUserBrowserProfile, resolveBrowserProfile } from './browserProfiles'
import { clampFormFillGoals } from './lobsterFormGoals'
import { matchSiteRecipe } from './siteRecipes'
import {
  LobsterTaskKindSchema,
  toLobsterTaskSpec,
  type LobsterTaskSpec,
  type LobsterTaskUnderstandParsed,
} from './lobsterTaskUnderstandSchema'

function parsePositiveInt(raw: unknown): number | undefined {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

/**
 * 站点 recipe 已声明 formFields 时，将 unknown TaskSpec 升为 form_fill。
 * 依据 host→recipe 结构 SSOT，不解析用户原话意图。
 */
export function applySiteRecipeFormFillHint(
  spec: LobsterTaskSpec | null | undefined,
  task: string,
  startUrl?: string,
): LobsterTaskSpec | null {
  if (!spec || spec.task_kind !== 'unknown') return spec || null
  const recipe = matchSiteRecipe(task, startUrl || spec.start_url)
  if (!recipe?.formFields?.length) return spec
  const defaultProfile =
    spec.browser_profile === 'user' || spec.browser_profile === 'managed'
      ? spec.browser_profile
      : isUserBrowserProfile()
        ? 'user'
        : resolveBrowserProfile()
  return toLobsterTaskSpec(
    {
      canonical_task: spec.canonical_task || task,
      start_url: spec.start_url || startUrl,
      engine_hint: 'auto',
      task_kind: 'form_fill',
      browser_profile: defaultProfile,
      needs_login: false,
      explicitly_avoid_login: false,
      confidence: Math.max(0.82, Number(spec.confidence) || 0),
      rationale: `site_recipe_form:${recipe.id}`,
      success_criteria: spec.success_criteria || spec.completion_criteria,
    },
    'manager',
    defaultProfile,
  )
}

/** Manager envelope 直传字段 → TaskSpec（跳过 LLM） */
export function taskSpecFromManagerHints(input: {
  task: string
  startUrl?: string
  engineHint?: string
  intentHint?: string
  taskKind?: string
  needsLogin?: boolean
  siteRecipeId?: string
  successCriteria?: string
  maxInteractionSteps?: number
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
  const criteria = String(input.successCriteria || '').trim() || undefined
  const row: LobsterTaskUnderstandParsed = {
    canonical_task: task,
    start_url: input.startUrl,
    engine_hint,
    task_kind,
    browser_profile: 'auto',
    intent_hint: String(input.intentHint || task_kind || '').trim() || undefined,
    needs_login: input.needsLogin === true || task_kind === 'login',
    explicitly_avoid_login: false,
    ...(criteria ? { success_criteria: criteria, completion_criteria: criteria } : {}),
    confidence: task_kind !== 'unknown' ? 0.9 : 0.85,
    rationale: input.siteRecipeId
      ? `manager_recipe:${input.siteRecipeId}`
      : task_kind !== 'unknown'
        ? `manager_envelope:${task_kind}`
        : 'manager_envelope',
    // plan_steps/goals 由 toLobsterTaskSpec 按 task_kind 兜底生成
  }
  const spec = toLobsterTaskSpec(row, 'manager', defaultProfile)
  const maxSteps = parsePositiveInt(input.maxInteractionSteps)
  return maxSteps ? { ...spec, max_interaction_steps: maxSteps } : spec
}

/** 总管已给 form_fill/login 时优先保留，避免 Understand 误判成 search */
export function mergeManagerAndUnderstoodTaskSpec(
  managerSpec: LobsterTaskSpec | null | undefined,
  understood: LobsterTaskSpec | null | undefined,
): LobsterTaskSpec | null {
  if (!managerSpec && !understood) return null
  if (!managerSpec) return understood || null
  if (!understood) return managerSpec
  const mgrStart = String(managerSpec.start_url || '').trim()
  const undStart = String(understood.start_url || '').trim()
  // Manager/用户已给 start_url 时不可被 Understand 幻觉域名覆盖（如 .com.cn → w3schools.com）
  const start_url = mgrStart || undStart || undefined
  const mgrCriteria =
    String(managerSpec.success_criteria || managerSpec.completion_criteria || '').trim() || undefined
  const undCriteria =
    String(understood.success_criteria || understood.completion_criteria || '').trim() || undefined
  const success_criteria = mgrCriteria || undCriteria
  const max_interaction_steps =
    parsePositiveInt(managerSpec.max_interaction_steps) ||
    parsePositiveInt(understood.max_interaction_steps)

  const mgrOperate =
    managerSpec.task_kind === 'form_fill' ||
    managerSpec.task_kind === 'login' ||
    managerSpec.task_kind === 'desktop_app' ||
    managerSpec.task_kind === 'mobile_app'
  if (!mgrOperate) {
    return {
      ...understood,
      start_url,
      needs_login: understood.needs_login || managerSpec.needs_login,
      plan_steps:
        understood.plan_steps?.length > 0 ? understood.plan_steps : managerSpec.plan_steps || [],
      goals: { ...managerSpec.goals, ...understood.goals },
      ...(success_criteria
        ? { success_criteria, completion_criteria: success_criteria }
        : {}),
      ...(max_interaction_steps ? { max_interaction_steps } : {}),
      // 总管已明确 task_kind 时保留（含 navigate/search），避免 Understand 覆盖
      ...(managerSpec.task_kind !== 'unknown' ? { task_kind: managerSpec.task_kind } : {}),
    }
  }
  const mergedGoals = { ...managerSpec.goals, ...understood.goals }
  const goals =
    managerSpec.task_kind === 'form_fill'
      ? clampFormFillGoals(mergedGoals, managerSpec.canonical_task || understood.canonical_task)
      : mergedGoals
  return {
    ...understood,
    task_kind: managerSpec.task_kind,
    needs_login: managerSpec.needs_login || understood.needs_login,
    intent_hint: managerSpec.intent_hint || understood.intent_hint,
    confidence: Math.max(understood.confidence, managerSpec.confidence),
    rationale: `manager_priority:${managerSpec.task_kind};${understood.rationale}`.slice(0, 320),
    source: 'manager',
    start_url,
    // 操作类：engine_hint 保持 auto，由 resolveEngineFromTaskSpec 按 task_kind 软选 stagehand
    engine_hint: managerSpec.engine_hint !== 'auto' ? managerSpec.engine_hint : 'auto',
    plan_steps:
      understood.plan_steps?.length > 0 ? understood.plan_steps : managerSpec.plan_steps || [],
    goals,
    ...(success_criteria
      ? { success_criteria, completion_criteria: success_criteria }
      : {}),
    ...(max_interaction_steps ? { max_interaction_steps } : {}),
  }
}
