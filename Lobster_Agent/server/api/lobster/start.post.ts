import { readBody, getHeader } from 'h3'
import { useRuntimeConfig } from '#imports'
import { mergeLobsterRuntimeConfig } from '../../utils/platform_config'
import { startRun } from '../../services/lobsterRuntime'
import { assertLobsterAuth } from '../../utils/auth'
import { resolveLobsterManagerStartHints } from '../../services/lobsterManagerEnvelope'
import { taskSpecFromManagerHints } from '../../services/lobsterManagerTaskSpec'

export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig() as any
  assertLobsterAuth(event, cfg)
  const body = (await readBody(event).catch(() => null)) as any
  const rawTask = String(body?.task ?? '').trim()
  let startUrl = body?.startUrl ? String(body.startUrl).trim() : undefined
  const sessionId = body?.sessionId ? String(body.sessionId).trim() : undefined
  let storageProfile = body?.storageProfile ? String(body.storageProfile).trim() : undefined
  let engineHint = body?.engineHint ? String(body.engineHint).trim() : undefined
  const browserProfileRaw = String(body?.browserProfile ?? body?.browser_profile ?? '').trim().toLowerCase()
  const handoffContext = String(body?.handoff_context ?? body?.handoffContext ?? '').trim().toLowerCase()
  const traceId = String(body?.trace_id ?? body?.traceId ?? '').trim() || undefined
  const managerTaskJson =
    typeof body?.manager_task_json === 'string'
      ? body.manager_task_json.trim() || undefined
      : body?.manager_task && typeof body.manager_task === 'object'
        ? JSON.stringify(body.manager_task)
        : undefined
  const managerTaskEnvelope = body?.manager_task_envelope_v2 ?? undefined

  const merged = resolveLobsterManagerStartHints({
    task: rawTask,
    startUrl,
    storageProfile,
    engineHint,
    managerTaskJson,
    managerTaskEnvelope,
  })
  const task = merged.task || rawTask
  startUrl = merged.startUrl || startUrl
  storageProfile = merged.storageProfile || storageProfile
  engineHint = merged.engineHint || engineHint
  if (handoffContext === 'post_human_confirm') engineHint = 'classic'
  const browserProfile =
    browserProfileRaw === 'user' || browserProfileRaw === 'managed'
      ? browserProfileRaw
      : merged.browserProfile
  const workflowId =
    merged.workflowId ||
    String(body?.workflow_id ?? body?.workflowId ?? '').trim() ||
    undefined
  let workflowArgs = merged.workflowArgs
  const rawArgs = body?.workflow_args ?? body?.workflowArgs
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    workflowArgs = { ...(workflowArgs || {}), ...(rawArgs as Record<string, unknown>) }
  }

  if (!task) {
    throw createError({ statusCode: 400, statusMessage: '缺少 task' })
  }

  const mergedCfg = await mergeLobsterRuntimeConfig({
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
    lobster: cfg.lobster
  })

  const taskSpec = taskSpecFromManagerHints({
    task,
    startUrl,
    engineHint,
    intentHint: merged.intentHint,
    taskKind: merged.taskKind,
    needsLogin: merged.needsLogin,
    siteRecipeId: merged.siteRecipeId,
    successCriteria: merged.successCriteria,
    maxInteractionSteps: merged.maxInteractionSteps,
  })

  const runId = startRun({
    task,
    startUrl,
    sessionId,
    tenantId: String(body?.tenantId || body?.tenant_id || getHeader(event, 'x-tenant-id') || 'default').trim() || 'default',
    storageProfile,
    engineHint,
    workflowId,
    workflowArgs,
    browserProfile,
    taskSpec: taskSpec || undefined,
    externalTraceId: traceId,
    config: mergedCfg
  })

  return { runId, traceId: traceId || runId }
})
