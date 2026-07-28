import WebSocket from 'ws'
import { structuralAnswerVerdict } from '../../graph/core/agent/agentAnswerJudge'
import { withTimeout, LruCache, normalizeDbWsUrl, dbHttpBaseFromWsUrl } from './agentTransport'
import { fetchWithExpertPolicy } from '../../graph/core/runtime/expertFailure'
import { buildAgentTraceHeaders, withTraceBody } from './agentTrace'
import { MANAGER_ORCHESTRATED_HEADER } from '../route/managerSubAgentHelpers'
import { wrapDbResult } from './agentResult'
import type { ChatMessage, DbResult } from './types'

function inferDbAnswerEmpty(answer: string): boolean {
  const v = structuralAnswerVerdict(String(answer ?? ''))
  return v.empty || !v.usable
}

const dbCache = new LruCache<DbResult>(120, 60_000)

export async function probeDb(params: {
  dbAgentHttpUrl: string
  question: string
  timeoutMs: number
  dbId?: string
  traceId?: string
}) {
  const url = `${params.dbAgentHttpUrl.replace(/\/+$/, '')}/api/probe`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAgentTraceHeaders(params.traceId) },
    body: JSON.stringify(withTraceBody({ question: params.question, dbId: params.dbId }, params.traceId))
  })
  if (!res.ok) throw new Error(`db probe failed: ${res.status}`)
  return await res.json()
}

export async function fetchDbTaskPlan(params: {
  dbAgentHttpUrl: string;
  question: string;
  timeoutMs: number;
  dbId?: string;
  traceId?: string;
  managerTask?: Record<string, unknown>;
}) {
  const url = `${params.dbAgentHttpUrl.replace(/\/+$/, '')}/api/plan`
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAgentTraceHeaders(params.traceId) },
      body: JSON.stringify(
        withTraceBody(
          {
            question: params.question,
            dbId: params.dbId,
            ...(params.managerTask && Object.keys(params.managerTask).length
              ? { managerTask: params.managerTask }
              : {})
          },
          params.traceId
        )
      )
    }),
    params.timeoutMs,
    'dbPlan'
  )
  if (!res.ok) {
    if (res.status === 404) return null
    throw new Error(`db plan failed: ${res.status}`)
  }
  return await res.json()
}


function finalizeDbResult(
  raw: Omit<DbResult, 'agentResult'>,
  traceId?: string,
  serverAgentResult?: unknown
): DbResult {
  const trace_id = String(traceId || raw.trace_id || '').trim() || undefined
  const base = { ...raw, trace_id }
  const agentResult =
    serverAgentResult && typeof serverAgentResult === 'object'
      ? (serverAgentResult as DbResult['agentResult'])
      : wrapDbResult(base, trace_id)
  return { ...base, agentResult }
}

export async function callDbAgent(params: {
  dbAgentWsUrl: string
  dbAgentHttpUrl?: string
  timeoutMs: number
  messages: ChatMessage[]
  dbId?: string
  traceId?: string
  /** 与总管 session 对齐，支持 DB 多轮追问 */
  sessionId?: string
  /** 总管结构化拆解，透传 DB_Agent /api/ask */
  managerTask?: Record<string, unknown>
  sendThinking?: (text: string) => void
  httpOnly?: boolean
  signal?: AbortSignal
}): Promise<DbResult> {
  const question = String(params.messages?.[params.messages.length - 1]?.content ?? '').trim()
  const wsUrl = normalizeDbWsUrl(params.dbAgentWsUrl)
  const sessionKey = String(params.sessionId || '').trim()
  const taskKey = params.managerTask ? JSON.stringify(params.managerTask) : ''
  const cacheKey = `db|${wsUrl}|${String(params.dbId || 'default')}|${sessionKey}|${question}|${taskKey}`
  const cached = dbCache.get(cacheKey)
  // 不缓存「空结果」：避免误查/短超时后的空答案长期命中，造成「总管 HTTP 永远查不到」假象
  if (cached && !cached.empty) return cached

  // Define HTTP caller first to avoid temporal dead zone issues
  const tryHttp = async (forced = false) => {
    params.sendThinking?.(forced ? '数据库 Agent：HTTP 调用中…' : '数据库 Agent：WebSocket 不可用，改用 HTTP 调用…')
    const base = String(params.dbAgentHttpUrl || dbHttpBaseFromWsUrl(wsUrl))
    const url = `${base.replace(/\/+$/, '')}/api/ask`
    const res = await fetchWithExpertPolicy(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAgentTraceHeaders(params.traceId) },
        body: JSON.stringify(
          withTraceBody(
            {
              messages: params.messages.length ? params.messages : [{ role: 'user', content: question }],
              dbId: params.dbId,
              ...(sessionKey ? { session_id: sessionKey, sessionId: sessionKey } : {}),
              ...(params.managerTask && Object.keys(params.managerTask).length ? { managerTask: params.managerTask } : {})
            },
            params.traceId
          )
        ),
        signal: params.signal
      },
      {
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        label: 'dbAgent(http)'
      }
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`dbAgent http ${res.status}: ${text || res.statusText}`)
    }
    const contentType = String(res.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '')
      const head = String(text || '').slice(0, 200).replace(/\s+/g, ' ')
      throw new Error(`dbAgent invalid response (expected json): ${head || contentType || 'unknown'}`)
    }
    const data = (await res.json().catch(() => null)) as any
    const answer = typeof data?.answer === 'string' ? data.answer : JSON.stringify(data ?? {})
    const empty = typeof data?.empty === 'boolean' ? data.empty : inferDbAnswerEmpty(answer)
    const reason = typeof data?.reason === 'string' ? data.reason : empty ? 'no_data_or_unmatched' : 'ok'
    const run_id = typeof data?.run_id === 'string' ? data.run_id : undefined
    const trace_id = typeof data?.trace_id === 'string' ? data.trace_id : params.traceId
    return finalizeDbResult(
      { answer, empty, reason, run_id, transport: 'http' as const },
      trace_id,
      data?.agentResult
    )
  }

  // If HTTP only is requested, skip WS and use HTTP directly
  if (params.httpOnly) {
    const ans = await tryHttp(true)
    if (!ans.empty) dbCache.set(cacheKey, ans)
    return ans
  }

  const tryWs = async (): Promise<DbResult> => {
    params.sendThinking?.('数据库 Agent：通过 WebSocket 调用中…')
    const orchestrated = Boolean(params.managerTask && Object.keys(params.managerTask).length)
    const ws = new WebSocket(wsUrl, {
      headers: {
        ...buildAgentTraceHeaders(params.traceId),
        ...(orchestrated ? { [MANAGER_ORCHESTRATED_HEADER]: '1' } : {})
      }
    })
    return await withTimeout(
      new Promise<string>((resolve, reject) => {
        let lastMessage = ''
        let sawEnd = false
        const onAbort = () => {
          cleanup()
          reject(new Error('dbAgent(ws) aborted'))
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
          ws.send(
            JSON.stringify(
              withTraceBody(
                {
                  messages: params.messages,
                  dbId: params.dbId,
                  ...(sessionKey ? { session_id: sessionKey, sessionId: sessionKey } : {}),
                  ...(params.managerTask && Object.keys(params.managerTask).length ? { managerTask: params.managerTask } : {})
                },
                params.traceId
              )
            )
          )
        })
        ws.on('message', (raw) => {
          try {
            const data = JSON.parse(String(raw || '{}')) as any
            const event = String(data?.event || '')
            if (event === 'status') {
              const s = String(data?.data || '')
              if (s) params.sendThinking?.(`数据库 Agent：status=${s}`)
              if (s === 'end') {
                sawEnd = true
                cleanup()
                resolve(lastMessage)
              }
              return
            }
            if (event === 'thinking') {
              const t = String(data?.data || '')
              if (t) params.sendThinking?.(`数据库 Agent：${t}`)
              return
            }
            if (event === 'message') {
              lastMessage = String(data?.data || '')
              // DB WS 协议中 message 就是最终答案；直接返回，避免等待 end 导致超时
              cleanup()
              resolve(lastMessage)
              return
            }
            if (event === 'error') {
              const msg = String(data?.data || 'dbAgent error')
              cleanup()
              reject(new Error(msg))
            }
          } catch {
            void 0
          }
        })
        ws.on('error', (err) => {
          cleanup()
          reject(err)
        })
        ws.on('close', () => {
          if (sawEnd) return
          if (lastMessage) resolve(lastMessage)
          else reject(new Error('dbAgent websocket closed before producing a reply'))
        })
      }),
      params.timeoutMs,
      'dbAgent(ws)',
      params.signal
    ).then((answer) => {
      const text = String(answer ?? '')
      const empty = inferDbAnswerEmpty(text)
      return finalizeDbResult(
        {
          answer: text,
          empty,
          reason: empty ? 'no_data_or_unmatched' : 'ok',
          transport: 'ws' as const
        },
        params.traceId
      )
    })
  }

  try {
    const ans = await tryWs()
    if (!ans.empty) dbCache.set(cacheKey, ans)
    return ans
  } catch (e: any) {
    params.sendThinking?.(`数据库 Agent：WebSocket 调用失败：${String(e?.message || e)}`)
    const ans = await tryHttp(false)
    if (!ans.empty) dbCache.set(cacheKey, ans)
    return ans
  }
}
