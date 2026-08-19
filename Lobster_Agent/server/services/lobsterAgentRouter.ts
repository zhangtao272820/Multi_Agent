import { runLobsterAgent, type RunParams } from './lobsterAgent'
import { probeLobsterMcpReady, runLobsterMcpAgent } from './lobsterMcpAgent'
import { probeLobsterDesktopReady, runLobsterDesktopMcpAgent } from './lobsterDesktopMcpAgent'
import { probeLobsterAndroidReady, runLobsterAndroidMcpAgent } from './lobsterAndroidMcpAgent'
import { probeStagehandReady, runLobsterStagehandAgent } from './lobsterStagehandAgent'
import type { LobsterEngineId } from './engineSelector'
import { requiresDesktopEngine, requiresMobileEngine } from './engineSelector'
import { resolveRunStoragePaths } from './sessionStorageBridge'
import { understandLobsterTask } from './lobsterTaskUnderstand'
import { taskSpecFromManagerHints, mergeManagerAndUnderstoodTaskSpec } from './lobsterManagerTaskSpec'
import { applyLobsterTaskUnderstand } from './lobsterTaskUnderstandSchema'
import {
  buildEngineChainFromPick,
  reorderChainForBrowserProfile,
  reorderChainForTaskSpec,
  resolveEngineFromTaskSpec,
} from './lobsterTaskSpec'
import { appendLobsterNluMetric, appendLobsterFailureInsight } from './lobsterNluMetrics'
import { ensureLobsterGuiFinalPayload } from './lobsterGuiFinalPayload'
import { recipeResultPageHints } from './siteRecipes'
import { browserProfileLabel, resolveRunBrowserProfile } from './browserProfiles'
import {
  isLobsterMcpEnabled,
  isStagehandEnabled,
  isLobsterDesktopMcpEnabled,
  isLobsterAndroidMcpEnabled,
  isLobsterHandsOnly,
  resolveLobsterExecutionMode
} from '../utils/lobster_env'
import { verifyLobsterRunResult, isLobsterRetryableFailure } from './lobsterRunVerify'
import { isLobsterWorkflowId, runLobsterWorkflowAgent } from './lobsterWorkflowRunner'
import { listLobsterWorkflowIds } from './lobsterWorkflowLoader'
import { runLobsterGuiPlusAgent } from './lobsterGuiPlusAgent'
import { shouldAttemptGuiPlusFallback } from './lobsterGuiPlusFallback'
import { wrapLobsterOutput } from './lobsterResultEnvelope'

/** 里程碑日志（禁 DOM/JSON 刷屏；总管侧再硬截断） */
function emitMilestone(params: RunParams, message: string) {
  params.emit({
    type: 'log',
    payload: { level: 'info', message: String(message || '').slice(0, 240), ts: Date.now() }
  })
}

function emitWarn(params: RunParams, message: string) {
  params.emit({
    type: 'log',
    payload: { level: 'warn', message: String(message || '').slice(0, 240), ts: Date.now() }
  })
}

async function runEngine(engine: LobsterEngineId, params: RunParams) {
  if (engine === 'desktop') return await runLobsterDesktopMcpAgent(params)
  if (engine === 'mobile') return await runLobsterAndroidMcpAgent(params)
  if (engine === 'stagehand') return await runLobsterStagehandAgent(params)
  if (engine === 'mcp') return await runLobsterMcpAgent(params)
  return await runLobsterAgent(params)
}

async function assertDesktopReady(params: RunParams) {
  if (process.platform !== 'win32') {
    throw new Error('lobster_desktop_requires_windows_host: 桌面任务需在 Windows 宿主机运行 Lobster')
  }
  if (!isLobsterDesktopMcpEnabled()) {
    throw new Error('lobster_desktop_mcp_disabled: 请设置 LOBSTER_DESKTOP_MCP_ENABLED=1')
  }
  // uvx windows-mcp serve 冷启动常 >8s；过短会 timeout → 总管当成「连接异常」重试后 aborted
  const probeMs = Number(process.env.LOBSTER_DESKTOP_MCP_PROBE_MS ?? 90_000)
  const probe = await probeLobsterDesktopReady(
    Number.isFinite(probeMs) && probeMs >= 15_000 ? Math.min(180_000, Math.floor(probeMs)) : 90_000,
  )
  if (!probe.ok) {
    throw new Error(`lobster_desktop_mcp_not_ready: ${probe.error || 'no_tools'}`)
  }
  emitMilestone(params, `Desktop MCP 就绪（${probe.toolCount} 工具）`)
}

async function assertAndroidReady(params: RunParams) {
  if (!isLobsterAndroidMcpEnabled()) {
    throw new Error('lobster_android_mcp_disabled: 请设置 LOBSTER_ANDROID_MCP_ENABLED=1')
  }
  const probe = await probeLobsterAndroidReady()
  if (!probe.ok) {
    throw new Error(`lobster_android_not_ready: ${probe.error || 'no_device'}`)
  }
  emitMilestone(params, `Android 就绪（${probe.deviceCount} 设备）`)
}

async function assertEngineReadyOrThrow(engine: LobsterEngineId): Promise<void> {
  if (engine === 'classic') return
  if (engine === 'desktop') {
    if (!isLobsterDesktopMcpEnabled()) throw new Error('lobster_desktop_mcp_disabled')
    const probeMs = Number(process.env.LOBSTER_DESKTOP_MCP_PROBE_MS ?? 90_000)
    const probe = await probeLobsterDesktopReady(
      Number.isFinite(probeMs) && probeMs >= 15_000 ? Math.min(180_000, Math.floor(probeMs)) : 90_000,
    )
    if (!probe.ok) throw new Error(`lobster_desktop_mcp_not_ready: ${probe.error || 'no_tools'}`)
    return
  }
  if (engine === 'mobile') {
    if (!isLobsterAndroidMcpEnabled()) throw new Error('lobster_android_mcp_disabled')
    const probe = await probeLobsterAndroidReady()
    if (!probe.ok) throw new Error(`lobster_android_not_ready: ${probe.error || 'no_device'}`)
    return
  }
  if (engine === 'mcp') {
    if (!isLobsterMcpEnabled()) throw new Error('lobster_mcp_disabled')
    const probe = await probeLobsterMcpReady()
    if (!probe.ok) throw new Error(`lobster_mcp_not_ready: ${probe.error || 'no_tools'}`)
    return
  }
  if (engine === 'stagehand') {
    if (!isStagehandEnabled()) {
      throw new Error('stagehand_unavailable: LOBSTER_STAGEHAND 未启用，请开启 Stagehand 后重试')
    }
    const probe = await probeStagehandReady()
    if (!probe.ok) {
      throw new Error(`stagehand_unavailable: ${probe.error || 'import_failed'}`)
    }
  }
}

/** classic | mcp | stagehand | auto（网页 = Stagehand only） */
export async function runLobsterWithRouter(params: RunParams) {
  const handsOnly = isLobsterHandsOnly()
  const forcedHintEarly = String(params.engineHint || '').trim().toLowerCase()
  const kindEarly = String(params.taskSpec?.task_kind || '').trim()
  const isDesktopRequest =
    forcedHintEarly === 'desktop' ||
    kindEarly === 'desktop_app' ||
    ((!kindEarly || kindEarly === 'unknown') &&
      requiresDesktopEngine(params.task, params.startUrl))

  if (handsOnly && !isDesktopRequest) {
    const failAnswer =
      '当前为 Hands 桌面侧车（LOBSTER_HANDS_ONLY=1），不支持网页 Stagehand 任务。请走 Docker Lobster（LOBSTER_AGENT_WS_URL）或改用桌面任务。'
    emitWarn(params, 'hands_web_not_supported')
    const out = wrapLobsterOutput(
      {
        task: params.task,
        finalUrl: '',
        stats: { stepCount: 0 },
        data: [{ via: 'hands', text: failAnswer }],
        answer: failAnswer,
        failureType: 'hands_web_not_supported',
        verify: { ok: false, reason: 'hands_web_not_supported' },
      },
      'desktop',
      { failureType: 'hands_web_not_supported', answer: failAnswer, confirmCount: 0 },
    )
    return ensureLobsterGuiFinalPayload(
      { ...out, engine: 'desktop', actualEngine: 'desktop', failureType: 'hands_web_not_supported' },
      params.task,
    )
  }

  if (handsOnly && isDesktopRequest) {
    await assertDesktopReady(params)
    emitForcedEngineLocal('desktop')
    const out = await runLobsterDesktopMcpAgent(params)
    return ensureLobsterGuiFinalPayload(
      { ...(out && typeof out === 'object' ? out : {}), engine: 'desktop', actualEngine: 'desktop' },
      params.task,
    )
  }

  function emitForcedEngineLocal(engine: string) {
    const ts = Date.now()
    params.emit({
      type: 'engine_chain',
      payload: { ts, chain: [engine], activeIndex: 0 },
    })
    params.emit({
      type: 'engine_active',
      payload: { ts, engine, actualEngine: engine, attemptIndex: 0 },
    })
  }

  const workflowId = String(params.workflowId || '').trim()
  if (workflowId && isLobsterWorkflowId(workflowId)) {
    const knownIds = listLobsterWorkflowIds()
    const known = knownIds.some((id) => id.toLowerCase() === workflowId.toLowerCase())
    if (!known) {
      emitWarn(params, `未知 Workflow「${workflowId}」，改走 Stagehand`)
    } else {
      emitMilestone(params, `路由：Workflow ${workflowId}`)
      const out = await runLobsterWorkflowAgent({ ...params, workflowId })
      return ensureLobsterGuiFinalPayload(
        { ...(out && typeof out === 'object' ? out : {}), engine: 'workflow', actualEngine: 'workflow' },
        params.task,
      )
    }
  }

  const mode = resolveLobsterExecutionMode()

  const emitForcedEngine = (engine: string) => {
    emitForcedEngineLocal(engine)
  }

  if (mode === 'classic') {
    emitForcedEngine('classic')
    return await runLobsterAgent(params)
  }
  if (mode === 'mcp') {
    emitForcedEngine('mcp')
    await assertEngineReadyOrThrow('mcp')
    return await runLobsterMcpAgent(params)
  }
  if (mode === 'stagehand') {
    emitForcedEngine('stagehand')
    await assertEngineReadyOrThrow('stagehand')
    return await runLobsterStagehandAgent(params)
  }

  const forcedHint = String(params.engineHint || '').trim().toLowerCase()
  const kindHint = String(params.taskSpec?.task_kind || '').trim()
  if (forcedHint === 'mobile' || kindHint === 'mobile_app') {
    await assertAndroidReady(params)
    return await runLobsterAndroidMcpAgent(params)
  }
  if (forcedHint === 'desktop' || kindHint === 'desktop_app') {
    await assertDesktopReady(params)
    return await runLobsterDesktopMcpAgent(params)
  }
  // 无 task_kind / forced 时才允许关键词兜底（兼容旧调用方）
  if (!kindHint || kindHint === 'unknown') {
    if (requiresMobileEngine(params.task, params.startUrl)) {
      await assertAndroidReady(params)
      return await runLobsterAndroidMcpAgent(params)
    }
    if (requiresDesktopEngine(params.task, params.startUrl)) {
      await assertDesktopReady(params)
      return await runLobsterDesktopMcpAgent(params)
    }
  }

  const managerSpec = taskSpecFromManagerHints({
    task: params.task,
    startUrl: params.startUrl,
    engineHint: params.engineHint,
    intentHint: params.taskSpec?.intent_hint,
    taskKind: params.taskSpec?.task_kind,
    needsLogin: params.taskSpec?.needs_login,
    successCriteria:
      params.taskSpec?.success_criteria || params.taskSpec?.completion_criteria,
    maxInteractionSteps: params.taskSpec?.max_interaction_steps,
  })

  const understoodRaw =
    (await understandLobsterTask({
      task: params.task,
      startUrl: params.startUrl,
      engineHint: params.engineHint,
      browserProfile: params.taskSpec?.browser_profile,
      config: params.config,
      signal: params.signal,
    })) ?? null

  const understood = mergeManagerAndUnderstoodTaskSpec(managerSpec, understoodRaw) ?? managerSpec

  const mergedTask = understood
    ? {
        task: understood.canonical_task,
        startUrl: params.startUrl || understood.start_url,
        engineHint: params.engineHint,
      }
    : applyLobsterTaskUnderstand(
        { task: params.task, startUrl: params.startUrl, engineHint: params.engineHint },
        null,
      )

  const taskSpec = understood ?? params.taskSpec
  const profileMode = resolveRunBrowserProfile({
    browserProfile: params.taskSpec?.browser_profile,
    taskSpecProfile: taskSpec?.browser_profile,
  })
  if (understood?.source === 'llm' || understood?.source === 'manager') {
    emitMilestone(
      params,
      `understand：${understood.task_kind} · ${understood.rationale.slice(0, 80)}`,
    )
  }

  const runParams: RunParams = {
    ...params,
    task: mergedTask.task,
    startUrl: mergedTask.startUrl,
    engineHint: mergedTask.engineHint,
    taskSpec:
      taskSpec && profileMode
        ? { ...taskSpec, browser_profile: profileMode }
        : taskSpec ?? params.taskSpec,
  }

  const storage = await resolveRunStoragePaths({
    startUrl: runParams.startUrl,
    sessionId: runParams.sessionId,
    storageProfile: runParams.storageProfile,
    storageDir: String(runParams.config?.lobster?.storageDir || '').trim() || undefined
  })
  const hasStorage = Boolean(storage.loadPath)

  const picked = resolveEngineFromTaskSpec({
    spec: taskSpec,
    task: runParams.task,
    startUrl: runParams.startUrl,
    engineHint: runParams.engineHint,
    hasStorage,
  })
  let chain = buildEngineChainFromPick(picked)
  chain = reorderChainForTaskSpec(chain, taskSpec ?? undefined, hasStorage)
  chain = reorderChainForBrowserProfile(chain, profileMode)

  emitMilestone(
    params,
    `引擎：${chain[0] || picked.engine}（${picked.source} · ${browserProfileLabel(profileMode)}）`,
  )
  params.emit({
    type: 'understand',
    payload: {
      ts: Date.now(),
      taskSpec: taskSpec
        ? {
            task_kind: taskSpec.task_kind,
            plan_steps: (taskSpec.plan_steps || []).slice(0, 6).map((s) => s.op),
            goals: taskSpec.goals,
          }
        : undefined,
      picked: {
        engine: picked.engine,
        source: picked.source,
        confidence: picked.confidence,
      },
      profile: browserProfileLabel(profileMode),
    },
  })
  params.emit({
    type: 'engine_chain',
    payload: {
      ts: Date.now(),
      chain: [...chain],
      activeIndex: 0,
      profile: browserProfileLabel(profileMode),
      picked: {
        engine: picked.engine,
        source: picked.source,
        confidence: picked.confidence,
        reason: picked.reason,
      },
    },
  })

  void appendLobsterNluMetric({
    ts: Date.now(),
    run_id: params.runId,
    task_kind: taskSpec?.task_kind,
    engine_hint: taskSpec?.engine_hint,
    engine_picked: picked.engine,
    browser_profile: profileMode,
    confidence: taskSpec?.confidence ?? picked.confidence,
    source: picked.source,
    needs_login: taskSpec?.needs_login,
    rationale: taskSpec?.rationale?.slice(0, 200),
  })

  // 网页 Stagehand-only：单引擎，失败直接返回/抛错，禁止整链回退刷日志
  const engine = chain[0] || picked.engine
  await assertEngineReadyOrThrow(engine)

  params.emit({
    type: 'engine_active',
    payload: {
      ts: Date.now(),
      engine,
      actualEngine: engine,
      attemptIndex: 0,
      chain: [engine],
      activeIndex: 0,
    },
  })

  const outputRaw = await runEngine(engine, runParams)
  const output =
    outputRaw && typeof outputRaw === 'object'
      ? ensureLobsterGuiFinalPayload(outputRaw as Record<string, unknown>, runParams.task)
      : outputRaw
  const verify = verifyLobsterRunResult({
    task: runParams.task,
    status: 'done',
    result: output,
  })
  params.emit({
    type: 'verify',
    payload: {
      ts: Date.now(),
      engine,
      attemptIndex: 0,
      verify: {
        ok: verify.ok,
        reason: verify.reason,
        failureType: verify.failureType,
        hints: verify.hints,
        // 网页无下一引擎；retryable 仅供总管 HITL 决策，不驱动回退
        retryable: false,
      },
    },
  })
  if (!verify.ok) {
    const finalUrl = String((output as any)?.finalUrl || '').trim()
    const hints = recipeResultPageHints(runParams.task, runParams.startUrl)
    const channelHit = Array.isArray(hints?.channelHomeExclude)
      ? hints!.channelHomeExclude!.some((h) => finalUrl.includes(h.replace(/^https?:\/\//, '')))
      : /news\.baidu\.com|map\.baidu\.com|tieba\.baidu\.com/i.test(finalUrl)
    void appendLobsterFailureInsight({
      ts: Date.now(),
      run_id: params.runId,
      kind: channelHit ? 'wrong_channel_click' : String(verify.reason || 'verify_fail'),
      url: finalUrl,
      stage: String(verify.reason || ''),
      detail: String(verify.hints?.[0] || '').slice(0, 240),
    })
    emitWarn(
      params,
      `${engine} verify 未通过（${verify.reason}${verify.hints?.[0] ? `：${verify.hints[0].slice(0, 80)}` : ''}）`,
    )

    // DOM 主路径失败 → 有限次 gui-plus computer_use 兜底（captcha/登录墙仍走 HITL）
    if (
      engine !== 'desktop' &&
      engine !== 'mobile' &&
      shouldAttemptGuiPlusFallback({
        verifyOk: false,
        failureType: verify.failureType || verify.reason,
      })
    ) {
      try {
        emitMilestone(params, '改走 gui-plus 有限步兜底（截图→坐标，省 token 硬帽）…')
        const resumeUrl = finalUrl || String(runParams.startUrl || '').trim()
        const gpOut = await runLobsterGuiPlusAgent(runParams, {
          resumeUrl: resumeUrl || undefined,
          priorFailure: String(verify.failureType || verify.reason || ''),
        })
        const gpPayload =
          gpOut && typeof gpOut === 'object'
            ? ensureLobsterGuiFinalPayload(gpOut as Record<string, unknown>, runParams.task)
            : gpOut
        const gpVerify = verifyLobsterRunResult({
          task: runParams.task,
          status: 'done',
          result: gpPayload,
        })
        params.emit({
          type: 'verify',
          payload: {
            ts: Date.now(),
            engine: 'gui_plus',
            attemptIndex: 1,
            verify: {
              ok: gpVerify.ok,
              reason: gpVerify.reason,
              failureType: gpVerify.failureType,
              hints: gpVerify.hints,
              retryable: false,
            },
          },
        })
        if (gpVerify.ok || String((gpPayload as any)?.answer || '').trim().length >= 8) {
          return gpPayload
        }
        emitWarn(params, `gui-plus 兜底未通过（${gpVerify.reason || 'incomplete'}），返回原 ${engine} 结果`)
      } catch (e: unknown) {
        emitWarn(
          params,
          `gui-plus 兜底失败：${String((e as Error)?.message || e).slice(0, 160)}`,
        )
      }
    }

    // 非 retryable 语义失败：仍返回结果（含 failureType），供总管 HITL / 用户面
    if (!isLobsterRetryableFailure({ status: 'done', result: output, verify })) {
      return output
    }
    // infra / navigation soft fail：返回结构化失败，不抛、不换引擎
    return output
  }
  return output
}

export { probeLobsterMcpReady } from './lobsterMcpAgent'
export { probeStagehandReady } from './lobsterStagehandAgent'
export { probeLobsterDesktopReady } from './lobsterDesktopMcpAgent'
export { probeLobsterAndroidReady } from './lobsterAndroidMcpAgent'
