import WebSocket from 'ws'
import {
  withTimeout,
  LruCache,
  agentHttpBaseFromWsUrl,
  waitForAgentHttpReady,
  waitForAgentHttpReadyCached,
  isRetriableAgentTransportError
} from './agentTransport'
import { buildAgentTraceHeaders, withTraceBody } from './agentTrace'
import { wrapCodeResult } from './agentResult'
import type { CodeAgentMeta, CodeAgentResult, CodeTransportMetrics } from './types'
import { resolveManagerEnvBool } from '../platform/managerEnvModes'

export type { CodeTransportMetrics }

const CODE_HEALTH_PATHS = ['/api/health', '/']
const codeComputeCache = new LruCache<{ answer: string; meta?: CodeAgentMeta; agentResult?: CodeAgentResult['agentResult'] }>(
  80,
  60_000
)

export function isCodeHttpComputeEnabled() {
  const v = String(process.env.MANAGER_CODE_HTTP_COMPUTE ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

function isManagerComputeTask(managerTask?: Record<string, unknown> | null) {
  const source = String((managerTask as { source?: string })?.source ?? '').toLowerCase()
  const kind = String((managerTask as { task_kind?: string })?.task_kind ?? '').toLowerCase()
  return source === 'manager' && kind === 'compute'
}

function isManagerOrchestratedTask(managerTask?: Record<string, unknown> | null) {
  return String((managerTask as { source?: string })?.source ?? '').toLowerCase() === 'manager'
}

export function isCodeRetrieveFirstEnabled(env: NodeJS.ProcessEnv = process.env) {
  return resolveManagerEnvBool('MANAGER_CODE_RETRIEVE_FIRST', env)
}

function shouldCodeRetrieveFirst(message: string, managerTask?: Record<string, unknown> | null) {
  if (isManagerOrchestratedTask(managerTask)) return false
  const kind = String((managerTask as any)?.task_kind ?? '').toLowerCase()
  if (kind === 'compute') return false
  if (/已知上下文[：:]/.test(message) && /请基于以上上下文做/.test(message)) return false
  return kind === 'inspect' || kind === 'edit'
}

async function callCodeComputeHttp(params: {
  codeAgentHttpUrl: string
  timeoutMs: number
  message: string
  traceId?: string
  managerTask?: Record<string, unknown> | null
  threadId: string
  signal?: AbortSignal
  skipCache?: boolean
}): Promise<CodeAgentResult> {
  const base = params.codeAgentHttpUrl.replace(/\/+$/, '')
  const taskKey = params.managerTask ? JSON.stringify(params.managerTask) : ''
  const cacheKey = `compute|${base}|${params.threadId}|${params.message}|${taskKey}`
  if (!params.skipCache) {
    const cached = codeComputeCache.get(cacheKey)
    if (cached?.answer) {
      return {
        answer: cached.answer,
        meta: cached.meta,
        trace_id: params.traceId,
        agentResult: cached.agentResult,
        transportMetrics: { wall_ms: 0, inference_ms: 0, attempts: 1, retry_wait_ms: 0, cached: true }
      }
    }
  }

  const url = `${base}/api/compute`
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAgentTraceHeaders(params.traceId),
        'x-manager-orchestrated': '1'
      },
      body: JSON.stringify(
        withTraceBody(
          {
            message: params.message,
            threadId: params.threadId,
            ...(params.managerTask && Object.keys(params.managerTask).length
              ? { managerTask: params.managerTask }
              : {})
          },
          params.traceId
        )
      ),
      signal: params.signal
    }),
    params.timeoutMs,
    'codeCompute(http)',
    params.signal
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const detail = text || res.statusText
    if (res.status === 403 && /quota|AllocationQuota|free tier|免费/i.test(detail)) {
      throw new Error(
        `codeCompute 403：DashScope 模型免费额度已用尽。请在百炼控制台关闭「仅使用免费额度」或开通付费；当前模型见 code_assistent_Agent/.env 的 OPENAI_MODEL。原始信息：${detail.slice(0, 240)}`
      )
    }
    if (res.status === 401) {
      throw new Error(
        `codeCompute http 401: ${detail || 'login_required'}（检查 code_assistent_agent 的 CLAWHIVE_INTERNAL_TOKEN 是否与 Manager 一致，且 .env.agents-lan 未被压成单行注释）`
      )
    }
    throw new Error(`codeCompute http ${res.status}: ${detail}`)
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const answer = typeof data?.answer === 'string' ? data.answer : ''
  const meta = (data?.meta && typeof data.meta === 'object' ? data.meta : undefined) as CodeAgentMeta | undefined
  const trace_id = typeof data?.trace_id === 'string' ? data.trace_id : params.traceId
  const agentResult =
    data?.agentResult && typeof data.agentResult === 'object'
      ? (data.agentResult as CodeAgentResult['agentResult'])
      : wrapCodeResult(answer, meta, trace_id)
  const metaErr =
    meta && typeof (meta as { error?: unknown }).error === 'string'
      ? String((meta as { error?: string }).error).trim()
      : ''
  const arAnswer =
    agentResult && typeof (agentResult as { answer?: unknown }).answer === 'string'
      ? String((agentResult as { answer?: string }).answer).trim()
      : ''
  const failed = data?.ok === false || !answer.trim()
  if (failed) {
    const detail =
      metaErr ||
      arAnswer ||
      (typeof data?.error_code === 'string' ? data.error_code : '') ||
      'empty answer'
    throw new Error(`codeCompute failed: ${detail.slice(0, 320)}`)
  }
  codeComputeCache.set(cacheKey, { answer, meta, agentResult })
  return { answer, meta, trace_id, agentResult }
}

export async function callCodeRetrieve(params: {
  codeAgentHttpUrl: string
  timeoutMs: number
  query: string
  traceId?: string
  signal?: AbortSignal
}) {
  const url = `${params.codeAgentHttpUrl.replace(/\/+$/, '')}/api/retrieve`
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAgentTraceHeaders(params.traceId) },
      body: JSON.stringify(withTraceBody({ query: params.query }, params.traceId)),
      signal: params.signal,
    }),
    params.timeoutMs,
    'codeRetrieve',
    params.signal,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`codeRetrieve http ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as {
    ok?: boolean
    query?: string
    hits?: number
    snippets?: Array<{ path?: string; score?: number; preview?: string }>
  }
}

export async function callCodeAgent(params: {
  codeAgentWsUrl: string
  timeoutMs: number
  message: string
  threadId: string
  traceId?: string
  managerTask?: Record<string, unknown> | null
  managerTaskEnvelope?: string
  sendThinking?: (text: string) => void
  sendDelta?: (delta: string) => void
  onMeta?: (meta: CodeAgentMeta) => void
  signal?: AbortSignal
  skipCache?: boolean
}): Promise<CodeAgentResult> {
  const wallStart = Date.now()
  let retryWaitMs = 0
  const managerCompute = isManagerComputeTask(params.managerTask)
  params.sendThinking?.(
    managerCompute
      ? '代码助手 Agent：正在整理上游数据…'
      : '代码助手 Agent：正在分析代码并生成建议…'
  )

  const httpBase = agentHttpBaseFromWsUrl(params.codeAgentWsUrl, '13103')
  const readyWaitMs = managerCompute ? 8_000 : 25_000
  const ready = await waitForAgentHttpReadyCached(httpBase, readyWaitMs, params.signal, CODE_HEALTH_PATHS)
  if (!ready && !params.signal?.aborted) {
    params.sendThinking?.('代码助手 Agent：服务尚未就绪，等待 dev 服务启动…')
    await waitForAgentHttpReady(httpBase, managerCompute ? 20_000 : 45_000, params.signal, CODE_HEALTH_PATHS)
  }

  let managerTask = params.managerTask

  if (managerCompute && isCodeHttpComputeEnabled()) {
    try {
      const result = await callCodeComputeHttp({
        codeAgentHttpUrl: httpBase,
        timeoutMs: params.timeoutMs,
        message: params.message,
        managerTask,
        threadId: params.threadId,
        traceId: params.traceId,
        signal: params.signal,
        skipCache: params.skipCache
      })
      const wall_ms = Date.now() - wallStart
      return {
        ...result,
        transportMetrics: {
          wall_ms,
          inference_ms: wall_ms,
          attempts: 1,
          retry_wait_ms: 0,
          transport: 'http',
          ...(result.transportMetrics || {})
        }
      }
    } catch (e) {
      const msg = String((e as Error)?.message || e || '')
      if (!isRetriableAgentTransportError(msg) || params.signal?.aborted) throw e
      params.sendThinking?.('代码助手 Agent：HTTP compute 失败，回退 WebSocket…')
    }
  }
  if (isCodeRetrieveFirstEnabled() && shouldCodeRetrieveFirst(params.message, managerTask)) {
    try {
      params.sendThinking?.('代码助手 Agent：正在检索相关代码片段…')
      const retrieveData = await callCodeRetrieve({
        codeAgentHttpUrl: httpBase,
        timeoutMs: Math.min(params.timeoutMs, 30_000),
        query: params.message,
        traceId: params.traceId,
        signal: params.signal,
      })
      const hints = (retrieveData.snippets || [])
        .map((s) => String(s.path ?? '').trim())
        .filter(Boolean)
        .slice(0, 6)
      if (hints.length) {
        const { mergeManagerCodeTaskPayload } = await import('../code/managerCodeTaskPayload')
        managerTask = mergeManagerCodeTaskPayload(managerTask, {
          hint_files: hints,
          task_kind: 'inspect',
          refined_question: params.message,
        })
      }
    } catch {
      /* retrieve 失败不阻断 WS 主链路 */
    }
  }

  const maxAttempts = 5
  let lastErr: unknown
  let attempts = 0
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts = attempt + 1
    if (attempt > 0) {
      const waitMs = Math.min(12_000, 1_500 * attempt * attempt)
      retryWaitMs += waitMs
      const wallSoFar = Date.now() - wallStart
      params.sendThinking?.(
        `代码助手 Agent：连接异常，${Math.round(waitMs / 1000)}s 后重试（${attempt + 1}/${maxAttempts}）· 已等待 ${Math.round(wallSoFar / 1000)}s…`
      )
      await new Promise((r) => setTimeout(r, waitMs))
      if (params.signal?.aborted) break
      await waitForAgentHttpReadyCached(httpBase, 20_000, params.signal, CODE_HEALTH_PATHS)
    }
    try {
      const result = await callCodeAgentOnce({ ...params, managerTask })
      const wall_ms = Date.now() - wallStart
      const inference_ms = Math.max(0, wall_ms - retryWaitMs)
      if (attempts > 1 || retryWaitMs > 0) {
        params.sendThinking?.(
          `代码助手 Agent：完成（墙钟 ${Math.round(wall_ms / 1000)}s，推理约 ${Math.round(inference_ms / 1000)}s，重试 ${attempts - 1} 次）`
        )
      }
      return {
        ...result,
        transportMetrics: { wall_ms, inference_ms, attempts, retry_wait_ms: retryWaitMs }
      }
    } catch (e) {
      lastErr = e
      const msg = String((e as any)?.message || e || '')
      if (attempt < maxAttempts - 1 && isRetriableAgentTransportError(msg) && !params.signal?.aborted) continue
      throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'codeAgent failed'))
}

async function callCodeAgentOnce(params: {
  codeAgentWsUrl: string
  timeoutMs: number
  message: string
  threadId: string
  traceId?: string
  managerTask?: Record<string, unknown> | null
  managerTaskEnvelope?: string
  sendThinking?: (text: string) => void
  sendDelta?: (delta: string) => void
  onMeta?: (meta: CodeAgentMeta) => void
  signal?: AbortSignal
}) {
  const ws = new WebSocket(params.codeAgentWsUrl)
  const final = await withTimeout(
    new Promise<CodeAgentResult>((resolve, reject) => {
      let buf = ''
      let sawDone = false
      let lastMeta: CodeAgentMeta | undefined
      const onAbort = () => {
        cleanup()
        reject(new Error('codeAgent aborted'))
      }
      const cleanup = () => {
        try {
          ws.removeAllListeners()
          ws.close()
        } catch {}
        try {
          params.signal?.removeEventListener('abort', onAbort)
        } catch {}
      }
      if (params.signal) params.signal.addEventListener('abort', onAbort)
      ws.on('open', () => {
        const payload: Record<string, unknown> = withTraceBody(
          {
            threadId: params.threadId,
            message: params.message,
            mode: 'auto',
          },
          params.traceId
        )
        if (params.managerTask && Object.keys(params.managerTask).length) {
          payload.managerTask = params.managerTask
        }
        if (params.managerTaskEnvelope) {
          payload.manager_task_envelope_v2 = params.managerTaskEnvelope
        }
        // 总管侧默认工程根（Docker 下为宿主 monorepo 挂载点 /workspace）
        const codeRoot = String(process.env.MANAGER_CODE_PROJECT_ROOT || process.env.CODE_PROJECT_DIR || '').trim()
        if (codeRoot) payload.root = codeRoot
        ws.send(JSON.stringify({ type: 'agent-chat', payload }))
      })
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(String(raw || '{}')) as any
          const type = String(data?.type || '')
          if (type === 'agent_edit_preview') {
            const preview = {
              files: Array.isArray(data?.files) ? data.files.map(String).filter(Boolean) : [],
              unified_diff: data?.unified_diff ? String(data.unified_diff) : undefined,
              diff_stat: data?.diff_stat ? String(data.diff_stat) : undefined,
              branch: data?.branch ? String(data.branch) : undefined,
            }
            lastMeta = {
              ...(lastMeta || {}),
              edit_preview: preview,
              files_touched: [...new Set([...(lastMeta?.files_touched ?? []), ...preview.files])],
              unified_diff: preview.unified_diff,
              diff_stat: preview.diff_stat,
              branch: preview.branch,
            }
            return
          }
          if (type === 'meta') {
            const meta = (data?.payload ?? data?.meta ?? data) as CodeAgentMeta
            if (meta && typeof meta === 'object') {
              lastMeta = { ...(lastMeta || {}), ...meta }
              params.onMeta?.(lastMeta)
            }
            return
          }
          if (type === 'clarify') {
            const payload = (data?.payload ?? data) as CodeAgentMeta
            lastMeta = {
              ...(lastMeta || {}),
              ...(payload && typeof payload === 'object' ? payload : {}),
              needsClarify: true,
            }
            return
          }
          if (type === 'delta') {
            const d = String(data?.payload || '')
            if (d) {
              buf += d
              params.sendDelta?.(d)
            }
            return
          }
          if (type === 'error') {
            cleanup()
            reject(new Error(String(data?.payload || 'codeAgent error')))
            return
          }
          if (type === 'done') {
            sawDone = true
            cleanup()
            const trace_id = params.traceId
            const base = { answer: buf, meta: lastMeta, trace_id }
            resolve({ ...base, agentResult: wrapCodeResult(buf, lastMeta, trace_id) })
          }
        } catch (e) {
          void e
        }
      })
      ws.on('error', (err) => {
        cleanup()
        reject(err)
      })
      ws.on('close', () => {
        if (sawDone) return
        if (buf.trim()) {
          cleanup()
          const trace_id = params.traceId
          resolve({ answer: buf, meta: lastMeta, trace_id, agentResult: wrapCodeResult(buf, lastMeta, trace_id) })
          return
        }
        cleanup()
        reject(new Error('codeAgent websocket closed before producing a reply'))
      })
    }),
    params.timeoutMs,
    'codeAgent',
    params.signal
  )
  return final
}
