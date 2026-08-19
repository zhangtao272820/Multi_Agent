import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type AgentConfig, type EmitEvent, type LobsterPublicState } from './lobsterAgent'
import { runLobsterWithRouter } from './lobsterAgentRouter'
import type { LobsterTaskSpec } from './lobsterTaskUnderstandSchema'
import { resolveRunBrowserProfile } from './browserProfiles'
import { ensureLobsterGuiFinalPayload } from './lobsterGuiFinalPayload'

/** error/canceled 终态：把 state.pageUrl / 截图痕迹写入 result，避免只剩 traceId */
function salvageGuiResultOnFailure(rec: RunRecord): Record<string, unknown> | null {
  const existing =
    rec.result && typeof rec.result === 'object' ? { ...(rec.result as Record<string, unknown>) } : {}
  const pageUrl = String(rec.state?.pageUrl || existing.finalUrl || existing.url || '').trim()
  const pageTitle = String((rec.state as any)?.pageTitle || existing.pageTitle || '').trim()
  const hasShot = Boolean(String(rec.lastScreenshotDataUrl || '').trim())
  const hasExisting =
    Boolean(String(existing.answer || existing.summary || '').trim()) ||
    Boolean(String(existing.finalUrl || existing.url || '').trim()) ||
    (Array.isArray(existing.data) && existing.data.length > 0)
  if (!pageUrl && !hasShot && !hasExisting) return null
  const base: Record<string, unknown> = {
    ...existing,
    task: String(existing.task || rec.task || ''),
    traceId: String(existing.traceId || rec.traceId || rec.runId || ''),
    ...(pageUrl ? { finalUrl: pageUrl, url: pageUrl } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(hasShot ? { hasScreenshot: true } : {}),
    ...(rec.error ? { error: String(rec.error).slice(0, 400) } : {}),
  }
  return ensureLobsterGuiFinalPayload(base, String(base.task || rec.task || ''))
}

type RunStatus = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'canceled'

type RunRecord = {
  runId: string
  task: string
  startUrl?: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  ttlMs: number
  controller: AbortController
  state: LobsterPublicState
  lastScreenshotDataUrl: string
  result: any
  error?: string
  traceId?: string
  traceZipPath?: string
}

const runs = new Map<string, RunRecord>()
const runQueue: string[] = []
let draining = false
const maxQueueSize = 50
type HumanAction = { type: string; [k: string]: any }
export type LobsterPendingConfirm = {
  id: string
  title: string
  message: string
  ts: number
}

type RunChannel = {
  paused: boolean
  stepTokens: number
  actions: HumanAction[]
  wakeups: Array<() => void>
  confirms: Map<string, { resolve: (ok: boolean) => void; ts: number }>
  confirmCount: number
  pendingConfirm: LobsterPendingConfirm | null
}
const channels = new Map<string, RunChannel>()
const cleanupEveryMs = 30_000
let cleanupTimerStarted = false
const confirmTtlMs = 15 * 60 * 1000

let fatalHandlersInstalled = false
function isPlaywrightGuidNotBoundError(e: any) {
  const msg = e?.message ? String(e.message) : String(e || '')
  return /Object with guid\s+response@/i.test(msg) && /was not bound in the connection/i.test(msg)
}

async function markRunningRunsAsError(message: string) {
  const now = Date.now()
  const list = Array.from(runs.values()).filter((r) => r.status === 'running')
  await Promise.all(
    list.map(async (r) => {
      r.status = 'error'
      r.error = message
      r.endedAt = now
      try {
        r.controller.abort()
      } catch {}
      const salvaged = salvageGuiResultOnFailure(r)
      if (salvaged) r.result = salvaged
      const cfg = (r as any).__config as AgentConfig | undefined
      const runsDir = cfg ? runsDirFromConfig(cfg) : path.resolve(process.cwd(), '.data', 'runs')
      if (salvaged) await writeJsonSafe(perRunResultPath(runsDir, r.runId), salvaged).catch(() => {})
      await writeJsonSafe(perRunSummaryPath(runsDir, r.runId), {
        type: 'run_summary',
        runId: r.runId,
        status: r.status,
        task: r.task,
        startUrl: r.startUrl || null,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        error: r.error
      }).catch(() => {})
      await appendRunLog(runsDir, {
        type: 'run_end',
        runId: r.runId,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        error: r.error,
        traceId: r.traceId || null,
        traceZipPath: r.traceZipPath || null
      }).catch(() => {})
    })
  )
}

function installFatalHandlers() {
  if (fatalHandlersInstalled) return
  fatalHandlersInstalled = true

  const handle = (kind: 'uncaughtException' | 'unhandledRejection', err: any) => {
    const msg = err?.message ? String(err.message) : String(err)
    if (isPlaywrightGuidNotBoundError(err)) {
      console.error(`[lobsterRuntime] ${kind}: playwright connection error: ${msg}`)
      void markRunningRunsAsError(msg).catch(() => {})
      return
    }
    console.error(`[lobsterRuntime] ${kind}:`, err)
    void markRunningRunsAsError(msg)
      .catch(() => {})
      .finally(() => {
        try {
          process.exit(1)
        } catch {}
      })
  }

  process.on('uncaughtException', (err) => handle('uncaughtException', err))
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason))
}

function startCleanupLoop() {
  if (cleanupTimerStarted) return
  installFatalHandlers()
  cleanupTimerStarted = true
  const t = setInterval(() => {
    const now = Date.now()
    for (const [, c] of channels.entries()) {
      for (const [id, rec] of c.confirms.entries()) {
        if (!rec?.ts) {
          c.confirms.delete(id)
          continue
        }
        if (now - rec.ts > confirmTtlMs) c.confirms.delete(id)
      }
    }
    for (const [id, r] of runs.entries()) {
      if (r.status === 'running') continue
      const endedAt = Number(r.endedAt || 0)
      if (!endedAt) continue
      const ttl = Number(r.ttlMs || 0)
      if (ttl > 0 && now - endedAt > ttl) {
        runs.delete(id)
        channels.delete(id)
      }
    }
  }, cleanupEveryMs)
  ;(t as any).unref?.()
}

function emptyState(): LobsterPublicState {
  return { phase: 'idle', stepCount: 0, pageUrl: '' }
}

function getChannel(runId: string) {
  const c = channels.get(runId)
  if (c) return c
  const created: RunChannel = {
    paused: false,
    stepTokens: 0,
    actions: [],
    wakeups: [],
    confirms: new Map(),
    confirmCount: 0,
    pendingConfirm: null,
  }
  channels.set(runId, created)
  return created
}

function wake(runId: string) {
  const c = channels.get(runId)
  if (!c) return
  const ws = c.wakeups.splice(0, c.wakeups.length)
  for (const fn of ws) {
    try {
      fn()
    } catch {}
  }
}

export function pauseRun(runId: string) {
  const c = getChannel(runId)
  c.paused = true
  c.stepTokens = 0
  wake(runId)
  return true
}

export function resumeRun(runId: string) {
  const c = getChannel(runId)
  c.paused = false
  c.stepTokens = 0
  wake(runId)
  return true
}

export function stepRun(runId: string) {
  const c = getChannel(runId)
  c.paused = true
  c.stepTokens = Math.min(5, Math.max(1, c.stepTokens + 1))
  wake(runId)
  return true
}

export function sendHumanAction(runId: string, action: HumanAction) {
  const c = getChannel(runId)
  c.actions.push(action)
  wake(runId)
  return true
}

export function resolveConfirm(runId: string, id: string, ok: boolean) {
  const c = channels.get(runId)
  if (!c) return false
  const rec = c.confirms.get(id)
  if (!rec) return false
  c.confirms.delete(id)
  if (c.pendingConfirm?.id === id) c.pendingConfirm = null
  try {
    rec.resolve(!!ok)
  } catch {}
  return true
}

export function getRunPendingConfirm(runId: string): LobsterPendingConfirm | null {
  const c = channels.get(runId)
  return c?.pendingConfirm ?? null
}

function runsDirFromConfig(config: AgentConfig) {
  const raw = String((config as any)?.lobster?.runsDir || '').trim()
  if (raw) return path.resolve(raw)
  return path.resolve(process.cwd(), '.data', 'runs')
}

function ttlMsFromConfig(config: AgentConfig) {
  const n = Number((config as any)?.lobster?.runTtlMs ?? 30 * 60 * 1000)
  if (!Number.isFinite(n) || n <= 0) return 30 * 60 * 1000
  return Math.min(24 * 60 * 60 * 1000, Math.floor(n))
}

function maxConcurrentFromConfig(config: AgentConfig) {
  const n = Number((config as any)?.lobster?.maxConcurrentRuns ?? 2)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(10, Math.floor(n))
}

function dailyJsonlPath(dir: string) {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return path.resolve(dir, `${yyyy}${mm}${dd}.runs.jsonl`)
}

async function appendRunLog(dir: string, payload: any) {
  const p = dailyJsonlPath(dir)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.appendFile(p, `${JSON.stringify(payload)}\n`, 'utf-8')
}

async function writeJsonSafe(filePath: string, data: any) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, filePath).catch(async () => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rm(tmp, { force: true }).catch(() => {})
  })
}

function perRunSummaryPath(dir: string, runId: string) {
  return path.resolve(dir, `${runId}.summary.json`)
}

function perRunResultPath(dir: string, runId: string) {
  return path.resolve(dir, `${runId}.result.json`)
}

function perRunEventsPath(dir: string, runId: string) {
  return path.resolve(dir, `${runId}.events.jsonl`)
}

function computeTraceZipPath(config: AgentConfig, runId: string) {
  const lobster: any = (config as any)?.lobster || {}
  const traceDirRaw = String(lobster?.traceDir || lobster?.storageDir || path.resolve(process.cwd(), '.data', 'traces')).trim()
  if (!traceDirRaw) return ''
  return path.resolve(traceDirRaw, `${runId}.zip`)
}

export function getRun(runId: string) {
  return runs.get(runId) || null
}

export function getRunStatus(runId: string) {
  const r = runs.get(runId)
  if (!r) return null
  const pendingConfirm = getRunPendingConfirm(runId)
  return {
    runId: r.runId,
    traceId: r.traceId,
    traceZipPath: r.traceZipPath,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    state: r.state,
    error: r.error,
    hasScreenshot: !!r.lastScreenshotDataUrl,
    hasResult: !!r.result,
    pendingConfirm,
    awaitingConfirm: Boolean(pendingConfirm),
  }
}

export function getRunScreenshot(runId: string) {
  const r = runs.get(runId)
  if (!r) return null
  return r.lastScreenshotDataUrl || null
}

export function getLobsterRuntimeMetrics() {
  let running = 0
  let queued = 0
  let done = 0
  let error = 0
  let canceled = 0
  const errorCodes: Record<string, number> = {}
  for (const r of runs.values()) {
    if (r.status === 'running') running++
    else if (r.status === 'queued') queued++
    else if (r.status === 'done') done++
    else if (r.status === 'error') {
      error++
      const code = String(r.error || 'error').slice(0, 64) || 'error'
      errorCodes[code] = (errorCodes[code] || 0) + 1
    } else if (r.status === 'canceled') canceled++
  }
  const finished = done + error
  return {
    service: 'lobster',
    runs: { total: runs.size, running, queued, done, error, canceled },
    queue_depth: runQueue.length,
    channels: channels.size,
    // E2：与 Manager experts.lobster 同形
    sli: {
      sampleCount: runs.size,
      queueDepth: runQueue.length,
      errorRate: finished > 0 ? error / finished : 0,
      errorCodes,
    },
    capabilityAudit: {
      CAP_ROUTE: process.env.CAP_ROUTE || null,
      CAP_REASON: process.env.CAP_REASON || null,
      silent_upgrade_forbidden: true,
    },
  }
}

export function stopRun(runId: string) {
  const r = runs.get(runId)
  if (!r) return false
  const sessionId = String((r as any).__sessionId || '').trim() || undefined
  // 取消/停止：作废该 run 已写入的 playbook 影子学习（对齐总管：作废不进学习）
  void import('./lobsterPlaybookEvolution')
    .then(({ supersedePlaybooksForRun }) =>
      supersedePlaybooksForRun({ runId, sessionId, reason: 'cancel' })
    )
    .catch(() => {})
  if (r.status === 'queued') {
    r.status = 'canceled'
    r.endedAt = Date.now()
    r.error = 'canceled'
    const idx = runQueue.indexOf(runId)
    if (idx >= 0) runQueue.splice(idx, 1)
    wake(runId)
    void drainQueue().catch(() => {})
    return true
  }
  try {
    r.controller.abort()
  } catch {}
  wake(runId)
  return true
}

async function runOnce(params: {
  runId: string
  task: string
  startUrl?: string
  sessionId?: string
  storageProfile?: string
  engineHint?: string
  workflowId?: string
  workflowArgs?: Record<string, unknown>
  browserProfile?: 'managed' | 'user'
  taskSpec?: LobsterTaskSpec
  config: AgentConfig
  controller: AbortController
  emit: (evt: EmitEvent) => void
}) {
  const {
    runId,
    task,
    startUrl,
    sessionId,
    storageProfile,
    engineHint,
    workflowId,
    workflowArgs,
    browserProfile,
    taskSpec: taskSpecIn,
    config,
    controller,
    emit,
  } = params
  const profile = resolveRunBrowserProfile({
    browserProfile,
    taskSpecProfile: taskSpecIn?.browser_profile,
  })
  const hintNorm = String(engineHint || '').trim().toLowerCase()
  const taskSpec: LobsterTaskSpec | undefined = taskSpecIn
    ? { ...taskSpecIn, browser_profile: profile }
    : ({
      canonical_task: task,
      start_url: startUrl,
      engine_hint:
        hintNorm === 'classic' ||
        hintNorm === 'mcp' ||
        hintNorm === 'stagehand' ||
        hintNorm === 'desktop' ||
        hintNorm === 'mobile'
          ? hintNorm
          : 'auto',
      task_kind:
        hintNorm === 'desktop' ? 'desktop_app' : hintNorm === 'mobile' ? 'mobile_app' : 'unknown',
      browser_profile: profile,
      needs_login: false,
      explicitly_avoid_login: false,
      confidence: 1,
      rationale: 'runtime_profile',
      source: 'manager',
    } as LobsterTaskSpec)
  return await runLobsterWithRouter({
    runId,
    task,
    startUrl,
    sessionId,
    storageProfile,
    engineHint,
    workflowId,
    workflowArgs,
    taskSpec,
    config,
    signal: controller.signal,
    emit,
    human: {
      waitWhilePaused: async (signal: AbortSignal) => {
        const c = getChannel(runId)
        while (!signal.aborted && c.paused && c.stepTokens <= 0) {
          await new Promise<void>((r) => c.wakeups.push(r))
        }
        if (signal.aborted) throw new Error('canceled')
        if (c.paused && c.stepTokens > 0) c.stepTokens = Math.max(0, c.stepTokens - 1)
      },
      tryPopAction: () => {
        const c = getChannel(runId)
        return c.actions.shift() || null
      },
      waitConfirm: async (id: string, signal: AbortSignal) => {
        const c = getChannel(runId)
        if (signal.aborted) throw new Error('canceled')
        return await new Promise<boolean>((resolve, reject) => {
          if (signal.aborted) return reject(new Error('canceled'))
          c.confirms.set(id, {
            resolve: (ok) => {
              if (ok) c.confirmCount++
              if (c.pendingConfirm?.id === id) c.pendingConfirm = null
              resolve(ok)
            },
            ts: Date.now()
          })
          const onAbort = () => {
            c.confirms.delete(id)
            reject(new Error('canceled'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
        })
      }
    }
  })
}

async function drainQueue() {
  if (draining) return
  draining = true
  try {
    while (true) {
      const nextId = runQueue[0]
      if (!nextId) break
      const next = runs.get(nextId)
      if (!next || next.status !== 'queued') {
        runQueue.shift()
        continue
      }
      const max = maxConcurrentFromConfig(((next as any).__config as AgentConfig) || ({} as any))
      const runningCount = Array.from(runs.values()).filter((r) => r.status === 'running').length
      if (runningCount >= max) break
      runQueue.shift()
      void startExecution(nextId).catch(() => {})
    }
  } finally {
    draining = false
  }
}

async function startExecution(runId: string) {
  const rec = runs.get(runId)
  if (!rec) return
  const cfg = (rec as any).__config as AgentConfig | undefined
  const runsDir = cfg ? runsDirFromConfig(cfg) : path.resolve(process.cwd(), '.data', 'runs')
  rec.status = 'running'
  rec.state = { ...rec.state, phase: 'running' }
  try {
    ;(rec as any).__emit?.({ type: 'log', payload: { level: 'info', message: '已出队，开始执行', ts: Date.now() } })
    ;(rec as any).__emit?.({ type: 'state', payload: rec.state })
  } catch {}
  const emit = (evt: EmitEvent) => {
    if (evt.type === 'state') rec.state = evt.payload
    if (evt.type === 'confirm') {
      const p = evt.payload && typeof evt.payload === 'object' ? (evt.payload as Record<string, unknown>) : {}
      const id = String(p.id || '').trim()
      if (id) {
        const ch = getChannel(runId)
        ch.pendingConfirm = {
          id,
          title: String(p.title || '需要确认').trim(),
          message: String(p.message || '').trim(),
          ts: Number(p.ts || Date.now()),
        }
      }
    }
    if (evt.type === 'screenshot') rec.lastScreenshotDataUrl = String(evt.payload?.dataUrl || '')
    if (evt.type === 'result') {
      rec.result = evt.payload
      if (evt.payload && typeof evt.payload === 'object') {
        rec.traceId = String((evt.payload as any).traceId || '') || rec.traceId
        rec.traceZipPath = String((evt.payload as any).traceZipPath || '') || rec.traceZipPath
      }
    }
    if (evt.type === 'error') rec.error = String(evt.payload?.message || '')
    if (evt.type !== 'screenshot') {
      void appendRunLog(runsDir, { type: 'evt', runId, ts: Date.now(), evt }).catch(() => {})
      void fs
        .appendFile(perRunEventsPath(runsDir, runId), `${JSON.stringify({ ts: Date.now(), evt })}\n`, 'utf-8')
        .catch(() => {})
    }
    ;(rec as any).__emit?.(evt)
  }

  void writeJsonSafe(perRunSummaryPath(runsDir, runId), {
    type: 'run_summary',
    runId,
    status: rec.status,
    task: rec.task,
    startUrl: rec.startUrl || null,
    startedAt: rec.startedAt
  }).catch(() => {})

  try {
    const output = await runOnce({
      runId,
      task: rec.task,
      startUrl: rec.startUrl,
      sessionId: String((rec as any).__sessionId || '').trim() || undefined,
      storageProfile: String((rec as any).__storageProfile || '').trim() || undefined,
      engineHint: String((rec as any).__engineHint || '').trim() || undefined,
      workflowId: String((rec as any).__workflowId || '').trim() || undefined,
      workflowArgs:
        (rec as any).__workflowArgs && typeof (rec as any).__workflowArgs === 'object'
          ? ((rec as any).__workflowArgs as Record<string, unknown>)
          : undefined,
      browserProfile: (() => {
        const p = String((rec as any).__browserProfile || '').trim().toLowerCase()
        return p === 'user' || p === 'managed' ? p : undefined
      })(),
      taskSpec: (rec as any).__taskSpec as LobsterTaskSpec | undefined,
      config: cfg || ({} as any),
      controller: rec.controller,
      emit
    })
    rec.status = 'done'
    rec.result = output
    rec.traceId = String((output as any)?.traceId || '') || rec.traceId
    rec.traceZipPath = String((output as any)?.traceZipPath || '') || rec.traceZipPath
    rec.endedAt = Date.now()
    const ch = channels.get(runId)
    const summaryExtra = {
      engine: String((output as any)?.engine || (output as any)?.executionEngine || ''),
      ms: rec.endedAt - rec.startedAt,
      confirmCount: Number((output as any)?.confirmCount ?? ch?.confirmCount ?? 0),
      stepCount: Number((output as any)?.stats?.stepCount ?? 0)
    }
    void appendRunLog(runsDir, {
      type: 'run_end',
      runId,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      traceId: rec.traceId || null,
      traceZipPath: rec.traceZipPath || null
    }).catch(() => {})
    void writeJsonSafe(perRunResultPath(runsDir, runId), output).catch(() => {})
    void writeJsonSafe(perRunSummaryPath(runsDir, runId), {
      type: 'run_summary',
      runId,
      status: rec.status,
      task: rec.task,
      startUrl: rec.startUrl || null,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      traceId: rec.traceId || null,
      traceZipPath: rec.traceZipPath || null,
      ...summaryExtra
    }).catch(() => {})
  } catch (e: any) {
    if (rec.controller.signal.aborted) {
      rec.status = 'canceled'
      rec.endedAt = Date.now()
      const salvagedCancel = salvageGuiResultOnFailure(rec)
      if (salvagedCancel) {
        rec.result = salvagedCancel
        void writeJsonSafe(perRunResultPath(runsDir, runId), salvagedCancel).catch(() => {})
      }
      emit({ type: 'log', payload: { level: 'warn', message: '任务已取消', ts: Date.now() } })
      void appendRunLog(runsDir, {
        type: 'run_end',
        runId,
        status: rec.status,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        traceId: rec.traceId || null,
        traceZipPath: rec.traceZipPath || null
      }).catch(() => {})
      void writeJsonSafe(perRunSummaryPath(runsDir, runId), {
        type: 'run_summary',
        runId,
        status: rec.status,
        task: rec.task,
        startUrl: rec.startUrl || null,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        traceId: rec.traceId || null,
        traceZipPath: rec.traceZipPath || null,
        error: rec.error || 'canceled'
      }).catch(() => {})
      if (rec.result) void writeJsonSafe(perRunResultPath(runsDir, runId), rec.result).catch(() => {})
    } else {
      rec.status = 'error'
      rec.error = e?.message ? String(e.message) : String(e)
      rec.endedAt = Date.now()
      const salvaged = salvageGuiResultOnFailure(rec)
      if (salvaged) {
        rec.result = salvaged
        void writeJsonSafe(perRunResultPath(runsDir, runId), salvaged).catch(() => {})
      }
      emit({ type: 'error', payload: { message: rec.error, ts: Date.now() } })
      void appendRunLog(runsDir, {
        type: 'run_end',
        runId,
        status: rec.status,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        error: rec.error,
        traceId: rec.traceId || null,
        traceZipPath: rec.traceZipPath || null
      }).catch(() => {})
      void writeJsonSafe(perRunSummaryPath(runsDir, runId), {
        type: 'run_summary',
        runId,
        status: rec.status,
        task: rec.task,
        startUrl: rec.startUrl || null,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        error: rec.error
      }).catch(() => {})
    }
  } finally {
    void drainQueue().catch(() => {})
  }
}

export function startRun(params: {
  task: string
  startUrl?: string
  sessionId?: string
  storageProfile?: string
  engineHint?: string
  workflowId?: string
  workflowArgs?: Record<string, unknown>
  browserProfile?: 'managed' | 'user'
  taskSpec?: LobsterTaskSpec
  externalTraceId?: string
  config: AgentConfig
  emit?: (evt: EmitEvent) => void
}) {
  const runId = crypto.randomUUID()
  const externalTrace = String(params.externalTraceId || '').trim()
  const controller = new AbortController()
  startCleanupLoop()
  getChannel(runId)
  const ttlMs = ttlMsFromConfig(params.config)
  const runsDir = runsDirFromConfig(params.config)
  const maxConcurrent = maxConcurrentFromConfig(params.config)
  const runningCount = Array.from(runs.values()).filter((r) => r.status === 'running').length
  const willQueue = runningCount >= maxConcurrent
  const rec: RunRecord = {
    runId,
    task: params.task,
    startUrl: params.startUrl,
    status: willQueue ? 'queued' : 'running',
    startedAt: Date.now(),
    ttlMs,
    controller,
    state: emptyState(),
    lastScreenshotDataUrl: '',
    result: null,
    traceId: externalTrace || runId,
    traceZipPath: computeTraceZipPath(params.config, runId) || undefined
  }
  runs.set(runId, rec)
  ;(rec as any).__config = params.config
  ;(rec as any).__emit = params.emit
  ;(rec as any).__sessionId = params.sessionId
  ;(rec as any).__storageProfile = params.storageProfile
  ;(rec as any).__engineHint = params.engineHint
  ;(rec as any).__workflowId = params.workflowId
  ;(rec as any).__workflowArgs = params.workflowArgs
  ;(rec as any).__browserProfile = params.browserProfile
  ;(rec as any).__taskSpec = params.taskSpec

  void appendRunLog(runsDir, {
    type: 'run_start',
    runId,
    task: params.task,
    startUrl: params.startUrl || null,
    startedAt: rec.startedAt
  }).catch(() => {})

  void writeJsonSafe(perRunSummaryPath(runsDir, runId), {
    type: 'run_summary',
    runId,
    status: willQueue ? 'queued' : 'running',
    task: params.task,
    startUrl: params.startUrl || null,
    startedAt: rec.startedAt
  }).catch(() => {})

  if (willQueue) {
    if (runQueue.length >= maxQueueSize) {
      rec.status = 'error'
      rec.error = `队列已满：maxQueueSize=${maxQueueSize}`
      rec.endedAt = Date.now()
      params.emit?.({ type: 'error', payload: { message: rec.error, ts: Date.now() } })
      void appendRunLog(runsDir, {
        type: 'run_end',
        runId,
        status: rec.status,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        error: rec.error
      }).catch(() => {})
      void writeJsonSafe(perRunSummaryPath(runsDir, runId), {
        type: 'run_summary',
        runId,
        status: rec.status,
        task: params.task,
        startUrl: params.startUrl || null,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        error: rec.error
      }).catch(() => {})
      return runId
    }
    rec.state = { phase: 'queued', stepCount: 0, pageUrl: '' }
    runQueue.push(runId)
    params.emit?.({ type: 'log', payload: { level: 'info', message: `已进入队列：当前并发上限 maxConcurrentRuns=${maxConcurrent}`, ts: Date.now() } })
    params.emit?.({ type: 'state', payload: rec.state })
    void drainQueue().catch(() => {})
    return runId
  }

  void startExecution(runId).catch(() => {})

  return runId
}
