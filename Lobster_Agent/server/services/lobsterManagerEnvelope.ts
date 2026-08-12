/**
 * 从总管 manager_task / envelope v2 解析 Lobster 启动参数
 */
import {
  parseManagerTaskEnvelope,
  normalizeManagerGuiTaskKind,
  type ManagerGuiTaskKind,
  type ManagerGuiTaskPayload,
} from '#agent-shared/managerTaskEnvelope'
import { siteHintsForPrompt } from './siteRecipes'

export type LobsterManagerStartHints = {
  task?: string
  startUrl?: string
  storageProfile?: string
  engineHint?: string
  /** @deprecated 入口镜像；意图真源为 taskKind */
  intentHint?: string
  taskKind?: ManagerGuiTaskKind
  needsLogin?: boolean
  siteRecipeId?: string
  browserProfile?: 'managed' | 'user'
  /** OpenClaw 式 Workflow Macro */
  workflowId?: string
  workflowArgs?: Record<string, unknown>
  /** 总管下发的完成标准（优先于 task-understand 自拟） */
  successCriteria?: string
  /** 总管下发的交互步预算（≠ 图级 stepLimits） */
  maxInteractionSteps?: number
}

function guiPayloadFromEnvelope(raw: unknown): ManagerGuiTaskPayload | null {
  const envelope = parseManagerTaskEnvelope(raw as string | Record<string, unknown> | null)
  if (envelope?.payload.kind !== 'gui') return null
  return envelope.payload.data as ManagerGuiTaskPayload
}

function guiPayloadFromV1Json(raw: string): ManagerGuiTaskPayload | null {
  try {
    const mt = JSON.parse(raw) as Record<string, unknown>
    if (String(mt.source ?? '') !== 'manager') return null
    return mt as unknown as ManagerGuiTaskPayload
  } catch {
    return null
  }
}

function parsePositiveInt(raw: unknown): number | undefined {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

export function resolveLobsterManagerStartHints(input: {
  task: string
  startUrl?: string
  storageProfile?: string
  engineHint?: string
  managerTaskJson?: string
  managerTaskEnvelope?: string | Record<string, unknown> | null
}): LobsterManagerStartHints {
  const gui =
    guiPayloadFromEnvelope(input.managerTaskEnvelope) ??
    (input.managerTaskJson ? guiPayloadFromV1Json(input.managerTaskJson) : null)

  const lobster = gui?.lobster

  let task = String(gui?.task || input.task || '').trim()
  const startUrl = String(gui?.startUrl || input.startUrl || '').trim() || undefined
  const promptHints = siteHintsForPrompt(task, startUrl)
  if (promptHints && !task.includes('站点提示')) {
    task = `${task}\n\n${promptHints}`
  }

  const engineHint =
    String(input.engineHint || gui?.engineHint || '').trim() || undefined
  // 注意：勿把 recipe.preferred_engine 写入 engineHint —— 那会 forced 锁死单引擎，
  // 导致百度无头 MCP 验证码后无法回退 classic；recipe 由 resolveEngineFromTaskSpec 软选型。

  const taskKind =
    normalizeManagerGuiTaskKind(gui?.task_kind) ||
    normalizeManagerGuiTaskKind(gui?.intent_hint) ||
    undefined
  const needsLogin = typeof gui?.needs_login === 'boolean' ? gui.needs_login : undefined
  const workflowId =
    String(gui?.workflow_id || (gui as any)?.workflowId || '').trim() || undefined
  const workflowArgsRaw = gui?.workflow_args ?? (gui as any)?.workflowArgs
  const workflowArgs =
    workflowArgsRaw && typeof workflowArgsRaw === 'object' && !Array.isArray(workflowArgsRaw)
      ? (workflowArgsRaw as Record<string, unknown>)
      : undefined

  const successCriteria =
    String(gui?.success_criteria || (gui as any)?.successCriteria || '').trim() || undefined
  const maxInteractionSteps =
    parsePositiveInt(gui?.max_interaction_steps ?? (gui as any)?.maxInteractionSteps) || undefined

  return {
    task: task || input.task,
    startUrl: String(gui?.startUrl || input.startUrl || '').trim() || undefined,
    storageProfile:
      String(input.storageProfile || gui?.storageProfile || '').trim() || undefined,
    engineHint,
    taskKind,
    needsLogin,
    intentHint: taskKind || String(gui?.intent_hint || '').trim() || undefined,
    siteRecipeId: lobster?.site_recipe_id,
    browserProfile:
      gui?.browser_profile === 'user' || gui?.browser_profile === 'managed'
        ? gui.browser_profile
        : undefined,
    workflowId,
    workflowArgs,
    successCriteria,
    maxInteractionSteps,
  }
}
