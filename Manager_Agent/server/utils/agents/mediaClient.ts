import WebSocket from 'ws'
import { toManagerProxyMediaUrl } from '#agent-shared/mediaUrls'
import { withTimeout } from './agentTransport'
import { buildMediaWebContext } from '../search/managerWebSearch'
import { musicHttpPollEnabled, pollAgentJob } from './pollAgentJob'
import {
  wrapMediaAgentResult,
  wrapMultimodalResult,
  coalesceAgentResult,
  type AgentCallResult
} from './agentResult'
import { buildAgentTraceHeaders, withTraceBody } from './agentTrace'
import type { AgentResult } from './types'

function wsCancelOnAbort(ws: WebSocket) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' }))
  } catch {
    /* ignore */
  }
}

/** 编排前轻量 caption（≤80 字）；不走 unified 长 VL */
export async function callMultimodalCaption(params: {
  multimodalAgentHttpUrl: string
  timeoutMs: number
  filePath: string
  query?: string
  traceId?: string
  signal?: AbortSignal
}): Promise<{ caption: string; ocrSnippet?: string; latencyMs?: number; raw?: unknown }> {
  const base = String(params.multimodalAgentHttpUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('multimodalAgentHttpUrl missing')
  const filePath = String(params.filePath || '').trim()
  if (!filePath) throw new Error('filePath missing')

  const url = `${base}/api/multimodal/caption`
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAgentTraceHeaders(params.traceId)
      },
      body: JSON.stringify(
        withTraceBody(
          {
            file_path: filePath,
            query: String(params.query || '').slice(0, 200),
          },
          params.traceId
        )
      ),
      signal: params.signal
    }),
    params.timeoutMs,
    'multimodalCaption',
    params.signal
  )
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(String(data?.error || data?.detail || res.statusText))
  }
  const caption = String(data.caption || data.description || '').trim()
  const ocrSnippet = String(data.ocr_snippet || data.ocrSnippet || '').trim() || undefined
  const latencyMs = Number(data.latency_ms ?? data.latencyMs)
  return {
    caption,
    ...(ocrSnippet ? { ocrSnippet } : {}),
    ...(Number.isFinite(latencyMs) ? { latencyMs: Math.floor(latencyMs) } : {}),
    raw: data
  }
}

export async function callMultimodalAgent(params: {
  multimodalAgentHttpUrl: string
  timeoutMs: number
  query: string
  mediaType?: string
  action?: string
  filePath?: string
  traceId?: string
  signal?: AbortSignal
}): Promise<AgentCallResult> {
  const base = String(params.multimodalAgentHttpUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('multimodalAgentHttpUrl missing')

  const url = `${base}/api/multimodal/unified`
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAgentTraceHeaders(params.traceId)
      },
      body: JSON.stringify(
        withTraceBody(
          {
            query: params.query,
            media_type: params.mediaType || 'image',
            action: params.action || 'understand',
            file_path: params.filePath || undefined
          },
          params.traceId
        )
      ),
      signal: params.signal
    }),
    params.timeoutMs,
    'multimodalAgent',
    params.signal
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(String((data as any)?.error || (data as any)?.detail || res.statusText))
  const answer = formatMultimodalAnswer(data)
  const fallback = wrapMultimodalResult(answer, data, params.traceId)
  const agentResult = coalesceAgentResult((data as any)?.agentResult as AgentResult | undefined, fallback)
  return {
    answer: String(agentResult.answer || answer),
    agentResult
  }
}

function formatMediaAgentAnswer(label: string, data: any): string {
  if (typeof data === 'string') return data
  const r = data?.result ?? data?.data ?? data
  const lines: string[] = [`【${label}】`]
  if (r?.final_video_url || r?.video_url) lines.push(`视频：${toManagerProxyMediaUrl(r.final_video_url || r.video_url, 'video')}`)
  if (r?.bgm_url || r?.audio_url) lines.push(`音频：${toManagerProxyMediaUrl(r.bgm_url || r.audio_url, 'audio')}`)
  const listenWav = r?.wav_url || r?.instrumental_wav_url || r?.remix_wav_url
  if (r?.midi_url) lines.push(`MIDI：${toManagerProxyMediaUrl(r.midi_url, 'audio')}`)
  if (listenWav) lines.push(`试听：${toManagerProxyMediaUrl(listenWav, 'audio')}`)
  if (r?.mp3_url) lines.push(`MP3：${toManagerProxyMediaUrl(r.mp3_url, 'audio')}`)
  if (r?.file_url) lines.push(`文件：${toManagerProxyMediaUrl(r.file_url, 'file')}`)
  if (r?.files_url) lines.push(`文件列表：${toManagerProxyMediaUrl(r.files_url, 'file')}`)
  if (r?.user_prompt) lines.push(`需求：${r.user_prompt}`)
  if (r?.error) lines.push(`错误：${r.error}`)
  if (lines.length > 1) return lines.join('\n')
  try {
    return JSON.stringify(data, null, 2).slice(0, 6000)
  } catch {
    return String(data ?? '')
  }
}

export async function callMusicAgent(params: {
  musicAgentWsUrl: string
  timeoutMs: number
  prompt: string
  traceId?: string
  webContext?: ReturnType<typeof buildMediaWebContext>
  sendThinking?: (text: string) => void
  sendProgress?: (data: { agent: 'music'; stage: string; pct?: number }) => void
  signal?: AbortSignal
}): Promise<AgentCallResult> {
  const wsUrl = String(params.musicAgentWsUrl || '').trim()
  if (!wsUrl) throw new Error('musicAgentWsUrl missing')

  if (musicHttpPollEnabled()) {
    const httpBase = wsUrl.replace(/^ws(s)?:\/\//i, 'http$1://').replace(/\/ws\/?$/i, '').replace(/\/+$/, '')
    if (httpBase.startsWith('http')) {
      try {
        params.sendThinking?.('音乐 Agent：异步任务已提交…')
        const donePayload = await pollAgentJob<any>({
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          submit: async () => {
            const res = await fetch(`${httpBase}/api/music/compose/async`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...buildAgentTraceHeaders(params.traceId) },
              body: JSON.stringify({
                prompt: params.prompt,
                ...(params.traceId ? { trace_id: params.traceId } : {}),
                ...(params.webContext ? { web_context: params.webContext } : {})
              }),
              signal: params.signal
            })
            const data = (await res.json().catch(() => ({}))) as any
            if (!res.ok) throw new Error(String(data?.detail || data?.message || res.statusText))
            return { jobId: String(data.job_id || '').trim() }
          },
          poll: async (jobId) => {
            const res = await fetch(`${httpBase}/api/jobs/${encodeURIComponent(jobId)}`, {
              headers: buildAgentTraceHeaders(params.traceId),
              signal: params.signal
            })
            const data = (await res.json().catch(() => ({}))) as any
            if (!res.ok) throw new Error(String(data?.detail || res.statusText))
            const status = String(data.status || 'running').toLowerCase()
            const mapped =
              status === 'done' ? 'done' : status === 'failed' ? 'failed' : status === 'canceled' ? 'canceled' : 'running'
            return {
              status: mapped as any,
              stage: data.stage,
              pct: data.pct,
              result: data.result,
              error: data.error,
              raw: data
            }
          },
          onProgress: (p) => {
            const stage = String(p.stage || '').trim()
            if (stage) {
              params.sendThinking?.(`音乐 Agent：${stage}`)
              params.sendProgress?.({ agent: 'music', stage, pct: p.pct })
            }
          }
        })
        const answer = formatMediaAgentAnswer('音乐生成', donePayload)
        const fallback = wrapMediaAgentResult('music', answer, donePayload, params.traceId)
        return { answer: String(fallback.answer || answer), agentResult: fallback }
      } catch {
        params.sendThinking?.('音乐 Agent：异步不可用，回退 WebSocket…')
      }
    }
  }

  params.sendThinking?.('音乐 Agent：正在创作…')
  const ws = new WebSocket(wsUrl, { headers: buildAgentTraceHeaders(params.traceId) })
  return await withTimeout(
    new Promise<AgentCallResult>((resolve, reject) => {
      let donePayload: any = null
      const onAbort = () => {
        wsCancelOnAbort(ws)
        cleanup()
        reject(new Error('musicAgent aborted'))
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
          JSON.stringify({
            type: 'compose',
            prompt: params.prompt,
            ...(params.traceId ? { trace_id: params.traceId } : {}),
            ...(params.webContext ? { web_context: params.webContext } : {})
          })
        )
      })
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(String(raw || '{}')) as any
          const type = String(data?.type || '')
          if (type === 'stage' || type === 'thinking') {
            const msg = String(data?.message || data?.stage || '').trim()
            if (msg) {
              params.sendThinking?.(`音乐 Agent：${msg}`)
              params.sendProgress?.({ agent: 'music', stage: msg, pct: typeof data?.pct === 'number' ? data.pct : undefined })
            }
            return
          }
          if (type === 'error') {
            cleanup()
            reject(new Error(String(data?.message || 'musicAgent error')))
            return
          }
          if (type === 'done') {
            donePayload = data?.result ?? data?.data ?? data
            cleanup()
            const answer = formatMediaAgentAnswer('音乐生成', donePayload)
            const fallback = wrapMediaAgentResult('music', answer, donePayload, params.traceId)
            const agentResult = coalesceAgentResult(data?.agentResult as AgentResult | undefined, fallback)
            resolve({
              answer: String(agentResult.answer || answer),
              agentResult
            })
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
        if (donePayload) {
          const answer = formatMediaAgentAnswer('音乐生成', donePayload)
          const fallback = wrapMediaAgentResult('music', answer, donePayload, params.traceId)
          resolve({
            answer,
            agentResult: fallback
          })
        }
      })
    }),
    params.timeoutMs,
    'musicAgent',
    params.signal
  )
}

export async function callVideoAgent(params: {
  videoAgentWsUrl: string
  timeoutMs: number
  prompt: string
  traceId?: string
  webContext?: ReturnType<typeof buildMediaWebContext>
  sendThinking?: (text: string) => void
  sendProgress?: (data: { agent: 'video'; stage: string; pct?: number }) => void
  signal?: AbortSignal
}): Promise<AgentCallResult> {
  const wsUrl = String(params.videoAgentWsUrl || '').trim()
  if (!wsUrl) throw new Error('videoAgentWsUrl missing')
  params.sendThinking?.('视频 Agent：正在生成（可能较久）…')
  const ws = new WebSocket(wsUrl, { headers: buildAgentTraceHeaders(params.traceId) })
  return await withTimeout(
    new Promise<AgentCallResult>((resolve, reject) => {
      let donePayload: any = null
      const onAbort = () => {
        wsCancelOnAbort(ws)
        cleanup()
        reject(new Error('videoAgent aborted'))
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
          JSON.stringify({
            type: 'generate',
            prompt: params.prompt,
            ...(params.traceId ? { trace_id: params.traceId } : {}),
            ...(params.webContext ? { web_context: params.webContext } : {})
          })
        )
      })
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(String(raw || '{}')) as any
          const type = String(data?.type || '')
          if (type === 'stage') {
            const node = String(data?.node || '')
            if (node) {
              params.sendThinking?.(`视频 Agent · ${node}`)
              params.sendProgress?.({ agent: 'video', stage: node, pct: typeof data?.pct === 'number' ? data.pct : undefined })
            }
            return
          }
          if (type === 'error') {
            cleanup()
            reject(new Error(String(data?.message || 'videoAgent error')))
            return
          }
          if (type === 'done') {
            donePayload = data?.result ?? data
            cleanup()
            const answer = formatMediaAgentAnswer('视频生成', donePayload)
            const fallback = wrapMediaAgentResult('video', answer, donePayload, params.traceId)
            const agentResult = coalesceAgentResult(data?.agentResult as AgentResult | undefined, fallback)
            resolve({
              answer: String(agentResult.answer || answer),
              agentResult
            })
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
        if (donePayload) {
          const answer = formatMediaAgentAnswer('视频生成', donePayload)
          const fallback = wrapMediaAgentResult('video', answer, donePayload, params.traceId)
          resolve({
            answer,
            agentResult: fallback
          })
        }
      })
    }),
    params.timeoutMs,
    'videoAgent',
    params.signal
  )
}

function formatMultimodalAnswer(data: any): string {
  if (typeof data === 'string') return data
  if (typeof data?.agent_reply === 'string' && data.agent_reply.trim()) {
    return data.agent_reply.trim()
  }
  const r = data?.result ?? data
  if (typeof r === 'string') return r
  const parts: string[] = []
  if (r?.answer) parts.push(String(r.answer))
  if (r?.description) parts.push(String(r.description))
  if (r?.summary) parts.push(String(r.summary))
  if (r?.transcript) parts.push(String(r.transcript))
  if (r?.ocr_text) parts.push(`OCR：${r.ocr_text}`)
  if (data?.answer) parts.push(String(data.answer))
  if (parts.length) return parts.join('\n')
  try {
    return JSON.stringify(data, null, 2).slice(0, 6000)
  } catch {
    return String(data ?? '')
  }
}
