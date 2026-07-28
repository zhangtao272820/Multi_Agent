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
  reorderChainForHeadlessMcpSidecar,
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
  isLobsterMcpHeadlessSidecar,
  shouldUseLocalHeadedMcp,
  resolveLobsterExecutionMode
} from '../utils/lobster_env'
import { verifyLobsterRunResult, isLobsterRetryableFailure } from './lobsterRunVerify'
import { isLobsterWorkflowId, runLobsterWorkflowAgent } from './lobsterWorkflowRunner'
import { listLobsterWorkflowIds } from './lobsterWorkflowLoader'

function emitLog(params: RunParams, level: 'info' | 'warn' | 'error', message: string) {
  params.emit({
    type: 'log',
    payload: { level, message: String(message || '').slice(0, 2000), ts: Date.now() }
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
  const probe = await probeLobsterDesktopReady()
  if (!probe.ok) {
    throw new Error(`lobster_desktop_mcp_not_ready: ${probe.error || 'no_tools'}`)
  }
  emitLog(params, 'info', `Desktop MCP 就绪（${probe.toolCount} 个工具）`)
}

async function assertAndroidReady(params: RunParams) {
  if (!isLobsterAndroidMcpEnabled()) {
    throw new Error('lobster_android_mcp_disabled: 请设置 LOBSTER_ANDROID_MCP_ENABLED=1')
  }
  const probe = await probeLobsterAndroidReady()
  if (!probe.ok) {
    throw new Error(`lobster_android_not_ready: ${probe.error || 'no_device'}`)
  }
  emitLog(
    params,
    'info',
    `Android 就绪（${probe.deviceCount} 台设备${probe.toolCount ? ` · ${probe.toolCount} MCP 工具` : ''}）`,
  )
}

async function isEngineReady(engine: LobsterEngineId): Promise<boolean> {
  if (engine === 'classic') return true
  if (engine === 'desktop') {
    if (!isLobsterDesktopMcpEnabled()) return false
    const probe = await probeLobsterDesktopReady()
    return probe.ok
  }
  if (engine === 'mobile') {
    if (!isLobsterAndroidMcpEnabled()) return false
    const probe = await probeLobsterAndroidReady()
    return probe.ok
  }
  if (engine === 'mcp') {
    if (!isLobsterMcpEnabled()) return false
    const probe = await probeLobsterMcpReady()
    return probe.ok
  }
  if (engine === 'stagehand') {
    if (!isStagehandEnabled()) return false
    const probe = await probeStagehandReady()
    return probe.ok
  }
  return false
}

/** classic | mcp | stagehand | auto（TaskUnderstand 单点 + fallback 链） */
export async function runLobsterWithRouter(params: RunParams) {
  const workflowId = String(params.workflowId || '').trim()
  if (workflowId && isLobsterWorkflowId(workflowId)) {
    const knownIds = listLobsterWorkflowIds()
    const known = knownIds.some((id) => id.toLowerCase() === workflowId.toLowerCase())
    if (!known) {
      emitLog(
        params,
        'warn',
        `未知 Workflow Macro「${workflowId}」，回退逐步引擎（classic/mcp）`,
      )
    } else {
      emitLog(params, 'info', `路由：Workflow Macro ${workflowId}`)
      const out = await runLobsterWorkflowAgent({ ...params, workflowId })
      return ensureLobsterGuiFinalPayload(
        { ...(out && typeof out === 'object' ? out : {}), engine: 'workflow', actualEngine: 'workflow' },
        params.task,
      )
    }
  }

  const mode = resolveLobsterExecutionMode()

  const emitForcedEngine = (engine: string) => {
    const ts = Date.now()
    params.emit({
      type: 'engine_chain',
      payload: { ts, chain: [engine], activeIndex: 0 },
    })
    params.emit({
      type: 'engine_active',
      payload: { ts, engine, actualEngine: engine, attemptIndex: 0 },
    })
    params.emit({
      type: 'run_meta',
      payload: { ts, runId: params.runId, actualEngine: engine, engine },
    })
  }

  if (mode === 'classic') {
    emitForcedEngine('classic')
    return await runLobsterAgent(params)
  }
  if (mode === 'mcp') {
    emitForcedEngine('mcp')
    return await runLobsterMcpAgent(params)
  }
  if (mode === 'stagehand') {
    emitForcedEngine('stagehand')
    return await runLobsterStagehandAgent(params)
  }

  const forcedHint = String(params.engineHint || '').trim().toLowerCase()
  if (forcedHint === 'mobile' || requiresMobileEngine(params.task, params.startUrl)) {
    await assertAndroidReady(params)
    return await runLobsterAndroidMcpAgent(params)
  }
  if (forcedHint === 'desktop' || requiresDesktopEngine(params.task, params.startUrl)) {
    await assertDesktopReady(params)
    return await runLobsterDesktopMcpAgent(params)
  }

  const managerSpec = taskSpecFromManagerHints({
    task: params.task,
    startUrl: params.startUrl,
    engineHint: params.engineHint,
    intentHint: params.taskSpec?.intent_hint,
    taskKind: params.taskSpec?.task_kind,
    needsLogin: params.taskSpec?.needs_login,
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

  // engineHint 只保留调用方强制值；LLM/TaskSpec 的 engine_hint 走 resolveEngineFromTaskSpec（可回退）
  const mergedTask = understood
    ? {
        task: understood.canonical_task,
        startUrl: understood.start_url || params.startUrl,
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
    emitLog(
      params,
      'info',
      `taskUnderstand：kind=${understood.task_kind} engine=${understood.engine_hint} profile=${understood.browser_profile} conf=${understood.confidence.toFixed(2)} · ${understood.rationale.slice(0, 80)}`,
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
  chain = reorderChainForHeadlessMcpSidecar(chain, runParams.task, runParams.startUrl, taskSpec)
  const sidecarNote =
    isLobsterMcpHeadlessSidecar() && !shouldUseLocalHeadedMcp() ? '，MCP=无头 sidecar' : ''
  emitLog(
    params,
    'info',
    `auto 引擎链：${chain.join(' → ')}（首选 ${picked.engine}，来源=${picked.source}，profile=${browserProfileLabel(profileMode)}${sidecarNote}，conf=${picked.confidence.toFixed(2)}：${picked.reason.slice(0, 80)}）`
  )
  params.emit({
    type: 'engine_chain',
    payload: {
      ts: Date.now(),
      chain: [...chain],
      activeIndex: 0,
      profile: browserProfileLabel(profileMode),
      sidecarNote: sidecarNote || undefined,
      picked: {
        engine: picked.engine,
        source: picked.source,
        confidence: picked.confidence,
        reason: picked.reason,
      },
    },
  })
  params.emit({
    type: 'understand',
    payload: {
      ts: Date.now(),
      taskSpec: taskSpec ? { ...taskSpec } : undefined,
      picked: {
        engine: picked.engine,
        source: picked.source,
        confidence: picked.confidence,
        reason: picked.reason,
      },
      profile: browserProfileLabel(profileMode),
      storageProfile: params.storageProfile,
    },
  })
  params.emit({
    type: 'run_meta',
    payload: {
      ts: Date.now(),
      runId: params.runId,
      storageProfile: params.storageProfile,
      browserProfile: browserProfileLabel(profileMode),
      profile: browserProfileLabel(profileMode),
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

  let lastErr: unknown = null
  for (let i = 0; i < chain.length; i++) {
    const engine = chain[i]!
    if (!(await isEngineReady(engine))) {
      emitLog(params, 'warn', `${engine} 不可用，跳过`)
      continue
    }
    try {
      emitLog(params, 'info', `使用执行引擎：${engine}`)
      if (String(process.env.LOBSTER_ENGINE_TRUTH_LOG ?? '1').trim() !== '0') {
        emitLog(params, 'info', `actualEngine=${engine} chain=[${chain.join('→')}] attempt=${i}`)
      }
      params.emit({
        type: 'engine_active',
        payload: {
          ts: Date.now(),
          engine,
          actualEngine: engine,
          attemptIndex: i,
          chain: [...chain],
          activeIndex: i,
        },
      })
      params.emit({
        type: 'run_meta',
        payload: {
          ts: Date.now(),
          actualEngine: engine,
          engineChain: [...chain],
          activeIndex: i,
          profile: browserProfileLabel(profileMode),
          browserProfile: browserProfileLabel(profileMode),
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
          attemptIndex: i,
          verify: {
            ok: verify.ok,
            reason: verify.reason,
            failureType: verify.failureType,
            hints: verify.hints,
            retryable: isLobsterRetryableFailure({ status: 'done', result: output, verify }),
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
        const retryable = isLobsterRetryableFailure({ status: 'done', result: output, verify })
        emitLog(
          params,
          retryable ? 'warn' : 'info',
          `${engine} 结果未通过 verify（${verify.reason}${verify.hints?.[0] ? `：${verify.hints[0].slice(0, 100)}` : ''}）`
        )
        if (retryable) {
          throw new Error(`lobster_verify_${verify.reason}`)
        }
      }
      return output
    } catch (e: any) {
      lastErr = e
      const msg = e?.message ? String(e.message) : String(e)
      if (params.signal.aborted || /canceled/i.test(msg)) throw e
      const next = chain[i + 1]
      if (!next) break
      emitLog(params, 'warn', `${engine} 失败（${msg.slice(0, 200)}），回退 ${next}`)
    }
  }

  if (lastErr instanceof Error) throw lastErr
  throw lastErr ?? new Error('lobster_all_engines_failed')
}

export { probeLobsterMcpReady } from './lobsterMcpAgent'
export { probeStagehandReady } from './lobsterStagehandAgent'
export { probeLobsterDesktopReady } from './lobsterDesktopMcpAgent'
export { probeLobsterAndroidReady } from './lobsterAndroidMcpAgent'
