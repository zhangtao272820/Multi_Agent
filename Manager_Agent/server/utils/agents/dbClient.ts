import WebSocket from 'ws'
import { structuralAnswerVerdict } from '../../graph/core/agent/agentAnswerJudge'
import { withTimeout, LruCache, normalizeDbWsUrl, dbHttpBaseFromWsUrl } from './agentTransport'
import { fetchWithExpertPolicy } from '../../graph/core/runtime/expertFailure'
import { buildAgentTraceHeaders, withTraceBody } from './agentTrace'
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
            dbId: params.dbId
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
    const statusText = String(res.statusText || '').trim()
    const hint =
      res.status === 401
        ? statusText || 'login_required（检查子 Agent CLAWHIVE_INTERNAL_TOKEN 是否与 Manager 一致）'
        : statusText
    throw new Error(hint ? `db plan failed: ${res.status} ${hint}` : `db plan failed: ${res.status}`)
  }
  return await res.json()
}


function finalizeDbResult(
  raw: Omit<DbResult, 'agentResult'>,
  traceId?: string,
  serverAgentResult?: unknown,
  extraStructured?: Record<string, unknown>
): DbResult {
  const trace_id = String(traceId || raw.trace_id || '').trim() || undefined
  const base = { ...raw, trace_id }
  let agentResult =
    serverAgentResult && typeof serverAgentResult === 'object'
      ? (serverAgentResult as DbResult['agentResult'])
      : wrapDbResult(base, trace_id)
  if (extraStructured && agentResult) {
    agentResult = {
      ...agentResult,
      structured: { ...(agentResult.structured || {}), ...extraStructured }
    }
  }
  return { ...base, agentResult }
}

function structuredFromVannaPayload(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const arStructured = (data?.agentResult as { structured?: Record<string, unknown> } | undefined)?.structured
  const rowsTop = Array.isArray(data?.rows) ? data!.rows : []
  const rowsAr = Array.isArray(arStructured?.rows) ? (arStructured!.rows as unknown[]) : []
  const rows = rowsTop.length ? rowsTop : rowsAr
  const fieldDetails = Array.isArray(data?.field_details)
    ? data!.field_details
    : Array.isArray(arStructured?.field_details)
      ? (arStructured!.field_details as unknown[])
      : Array.isArray(arStructured?.fieldDetails)
        ? (arStructured!.fieldDetails as unknown[])
        : []
  const chart =
    data?.chart != null
      ? data.chart
      : arStructured?.chart
  const deliverables =
    data?.deliverables && typeof data.deliverables === 'object'
      ? data.deliverables
      : arStructured?.deliverables && typeof arStructured.deliverables === 'object'
        ? arStructured.deliverables
        : undefined
  if (rows.length) out.rows = rows
  if (fieldDetails.length) out.field_details = fieldDetails
  if (chart != null) out.chart = chart
  if (deliverables && typeof deliverables === 'object') out.deliverables = deliverables
  return out
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
  sendThinking?: (text: string) => void
  sendDelta?: (delta: string) => void
  httpOnly?: boolean
  signal?: AbortSignal
  /** 写库预览：传 managerTask.write_allowed（仍须 HITL 才执行） */
  managerTask?: Record<string, unknown>
}): Promise<DbResult> {
  const question = String(params.messages?.[params.messages.length - 1]?.content ?? '').trim()
  const wsUrl = normalizeDbWsUrl(params.dbAgentWsUrl)
  const sessionKey = String(params.sessionId || '').trim()
  const writeKey = params.managerTask?.write_allowed === true ? '|w1' : ''
  const cacheKey = `db|${wsUrl}|${String(params.dbId || 'default')}|${sessionKey}|${question}${writeKey}`
  const cached = dbCache.get(cacheKey)
  // 不缓存「空结果」：避免误查/短超时后的空答案长期命中，造成「总管 HTTP 永远查不到」假象
  if (cached && !cached.empty && !writeKey) return cached

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
              ...(params.managerTask ? { managerTask: params.managerTask } : {})
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
      data?.agentResult,
      structuredFromVannaPayload(data)
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
    const ws = new WebSocket(wsUrl, {
      headers: {
        ...buildAgentTraceHeaders(params.traceId)
      }
    })
    type WsPayload = { answer: string; meta?: Record<string, unknown> | null }
    return await withTimeout(
      new Promise<WsPayload>((resolve, reject) => {
        let lastMessage = ''
        let lastMeta: Record<string, unknown> | null = null
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
                  ...(sessionKey ? { session_id: sessionKey, sessionId: sessionKey } : {})
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
                // 优先等 meta（含 rows）；若 meta 已到则结束，否则留给后续 meta / close / timeout
                if (lastMeta && Array.isArray(lastMeta.rows)) {
                  cleanup()
                  resolve({ answer: lastMessage, meta: lastMeta })
                }
              }
              return
            }
            if (event === 'thinking') {
              const t = String(data?.data || '')
              if (t) params.sendThinking?.(`数据库 Agent：${t}`)
              return
            }
            if (event === 'delta') {
              const d = String(data?.data || '')
              if (d) {
                params.sendDelta?.(d)
                lastMessage += d
              }
              return
            }
            if (event === 'stream_start') {
              lastMessage = ''
              return
            }
            if (event === 'meta') {
              if (data?.data && typeof data.data === 'object') {
                lastMeta = data.data as Record<string, unknown>
              }
              // meta 晚于 end / message：立刻收口，避免总管丢 rows
              if (sawEnd || (lastMessage && Array.isArray(lastMeta?.rows))) {
                cleanup()
                resolve({ answer: lastMessage, meta: lastMeta })
              }
              return
            }
            if (event === 'message') {
              const msg = String(data?.data || '')
              if (msg) lastMessage = msg
              // 必须等 meta（含 rows/field_details）再结束；避免仅有正文、丢结构化表
              if (lastMeta && Array.isArray(lastMeta.rows)) {
                cleanup()
                resolve({ answer: lastMessage, meta: lastMeta })
              }
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
          if (lastMessage) resolve({ answer: lastMessage, meta: lastMeta })
          else reject(new Error('dbAgent websocket closed before producing a reply'))
        })
      }),
      params.timeoutMs,
      'dbAgent(ws)',
      params.signal
    ).then((payload) => {
      const text = String(payload?.answer ?? '')
      const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : null
      const metaEmpty =
        meta?.empty === true ||
        meta?.error_code === 'empty_result' ||
        meta?.error_code === 'schema_miss'
      const empty = metaEmpty ? true : inferDbAnswerEmpty(text)
      const reason =
        typeof meta?.fail_reason === 'string' && meta.fail_reason
          ? String(meta.fail_reason)
          : empty
            ? 'no_data_or_unmatched'
            : 'ok'
      const executedSql = typeof meta?.executed_sql === 'string' ? String(meta.executed_sql).trim() : ''
      const errorCode =
        typeof meta?.error_code === 'string' && meta.error_code
          ? String(meta.error_code)
          : empty
            ? 'empty_result'
            : undefined
      const explain =
        Array.isArray(meta?.explain_preflight)
          ? (meta!.explain_preflight as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean)
          : []
      const serverAgentResult = {
        // 业务空结果（empty_result）仍 ok=true，与 Vanna build_db_agent_result 对齐
        ok:
          Boolean(meta?.needs_clarification)
            ? false
            : empty
              ? errorCode === 'empty_result' || meta?.empty === true
                ? true
                : false
              : true,
        agent: 'db',
        trace_id: params.traceId,
        answer: text,
        sources: undefined as undefined,
        structured: {
          empty,
          reason,
          transport: 'ws' as const,
          ...(executedSql ? { executed_sql: executedSql } : {}),
          ...(errorCode ? { error_code: errorCode } : {}),
          ...(typeof meta?.path === 'string' && meta.path ? { path: String(meta.path) } : {}),
          ...(explain.length ? { explain_preflight: explain } : {}),
          ...(Array.isArray(meta?.rows) && meta.rows.length ? { rows: meta.rows } : {}),
          ...(Array.isArray(meta?.field_details) && meta.field_details.length
            ? { field_details: meta.field_details }
            : {}),
          ...(meta?.chart != null ? { chart: meta.chart } : {}),
          ...(meta?.deliverables && typeof meta.deliverables === 'object'
            ? { deliverables: meta.deliverables }
            : {})
        },
        needs_clarify: Boolean(meta?.needs_clarification),
        error_code: errorCode,
      }
      return finalizeDbResult(
        {
          answer: text,
          empty,
          reason,
          transport: 'ws' as const
        },
        params.traceId,
        serverAgentResult
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

/** 写库 HITL：确认/取消 pending（T2 须 confirm_token） */
export async function callDbPendingDecide(params: {
  dbAgentHttpUrl: string
  pendingId: string
  decision: '确认' | '取消'
  confirmToken?: string
  blastRadius?: string
  /** 高影响写：用户已在 HITL 卡确认后传 true */
  impactAck?: boolean
  verifySql?: string
  dbId?: string
  sessionId?: string
  traceId?: string
  timeoutMs: number
  signal?: AbortSignal
  sendThinking?: (text: string) => void
}): Promise<DbResult> {
  params.sendThinking?.(`数据库 Agent：正在${params.decision}写库待办…`)
  const base = String(params.dbAgentHttpUrl || '').replace(/\/+$/, '')
  const url = `${base}/api/pending/decide`
  const res = await fetchWithExpertPolicy(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAgentTraceHeaders(params.traceId) },
      body: JSON.stringify(
        withTraceBody(
          {
            pending_id: params.pendingId,
            decision: params.decision,
            confirm_token: params.confirmToken || '',
            blast_radius: params.blastRadius || 't2',
            impact_ack: params.impactAck === true,
            ...(params.verifySql ? { verify_sql: params.verifySql } : {}),
            dbId: params.dbId,
            ...(params.sessionId ? { session_id: params.sessionId, sessionId: params.sessionId } : {})
          },
          params.traceId
        )
      ),
      signal: params.signal
    },
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      label: 'dbAgent(pendingDecide)'
    }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`db pending decide ${res.status}: ${text || res.statusText}`)
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const answer = typeof data?.answer === 'string' ? data.answer : JSON.stringify(data ?? {})
  return finalizeDbResult(
    {
      answer,
      empty: false,
      reason: data?.ok === false ? 'business' : 'ok',
      transport: 'http' as const
    },
    params.traceId,
    data?.agentResult,
    structuredFromVannaPayload(data || undefined)
  )
}
