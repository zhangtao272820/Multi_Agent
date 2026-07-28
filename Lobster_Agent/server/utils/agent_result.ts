import { detectLobsterSemanticBlock, verifyLobsterRunResult } from '#agent-shared/lobsterRunVerifyLite'

export type AgentSource = {
  type: 'url' | 'doc' | 'table' | 'sql'
  ref: string
}

export type AgentResult = {
  ok: boolean
  agent: string
  trace_id?: string
  answer?: string
  sources?: AgentSource[]
  structured?: Record<string, unknown>
  needs_clarify?: boolean
  clarify_questions?: string[]
  error_code?: string
  latency_ms?: number
}

type GuiDataChunk = Record<string, unknown>

function collectUrls(data: GuiDataChunk[], finalUrl?: string): AgentSource[] {
  const sources: AgentSource[] = []
  const seen = new Set<string>()
  const push = (url: string) => {
    const ref = String(url || '').trim()
    if (!ref || seen.has(ref)) return
    seen.add(ref)
    sources.push({ type: 'url', ref })
  }
  if (finalUrl) push(finalUrl)
  for (const chunk of data) {
    if (!chunk || typeof chunk !== 'object') continue
    push(String(chunk.url || ''))
    const items = Array.isArray(chunk.items) ? chunk.items : []
    for (const it of items.slice(0, 20)) {
      const row = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      push(String(row.url || row.href || row.link || ''))
    }
  }
  return sources
}

function summarizeData(data: GuiDataChunk[]): string {
  const lines: string[] = []
  for (const chunk of data.slice(-4)) {
    if (!chunk || typeof chunk !== 'object') continue
    const via = String(chunk.via || '').trim()
    const items = Array.isArray(chunk.items) ? chunk.items : null
    if (items?.length) {
      const preview = items.slice(0, 5).map((it) => {
        const row = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
        const title = String(row.title || row.text || row.label || '').trim().slice(0, 120)
        const url = String(row.url || row.href || '').trim()
        return title ? (url ? `${title} (${url})` : title) : JSON.stringify(row).slice(0, 160)
      })
      lines.push(`${via ? `[${via}] ` : ''}${preview.join('；')}`)
      continue
    }
    const text = JSON.stringify(chunk)
    if (text && text !== '{}') lines.push(text.slice(0, 1200))
  }
  return lines.join('\n').trim()
}

export function buildGuiAgentResult(params: {
  data?: GuiDataChunk[]
  finalUrl?: string
  task?: string
  trace_id?: string
  latency_ms?: number
  status?: string
  stats?: Record<string, unknown>
  error_code?: string
  answer?: string
  failureType?: string
}): AgentResult {
  const data = Array.isArray(params.data) ? params.data : []
  const finalUrl = String(params.finalUrl || '').trim()
  const stats = params.stats && typeof params.stats === 'object' ? params.stats : {}
  const stepCount = Number(stats.stepCount || 0)
  const sources = collectUrls(data, finalUrl)
  const excerpt = summarizeData(data)
  const task = String(params.task || '').trim()
  const directAnswer = String(params.answer || '').trim()
  const answerParts = [
    directAnswer,
    finalUrl ? `页面：${finalUrl}` : '',
    excerpt,
    !excerpt && stepCount > 0 ? `GUI 自动化已完成（${stepCount} 步）` : '',
    !excerpt && !stepCount && task ? `任务：${task}` : ''
  ].filter(Boolean)
  const answer = answerParts.join('\n').trim()
  const resultRow = {
    task,
    finalUrl,
    answer: directAnswer,
    data,
    failureType: String(params.failureType || '').trim() || undefined,
  }
  const semanticBlock = detectLobsterSemanticBlock({ task, result: resultRow, text: answer })
  const verify = verifyLobsterRunResult({
    task,
    status: String(params.status || 'done'),
    result: resultRow,
    error: params.error_code,
  })
  const hasPayload = Boolean(answer) || sources.length > 0 || stepCount > 0 || data.length > 0
  const ok =
    String(params.status || '').toLowerCase() !== 'error' &&
    !params.error_code &&
    !semanticBlock &&
    verify.ok &&
    hasPayload
  const failureType =
    semanticBlock?.failureType ||
    verify.failureType ||
    String(params.failureType || '').trim() ||
    (!verify.ok ? verify.reason : undefined) ||
    undefined
  return {
    ok,
    agent: 'gui',
    trace_id: params.trace_id,
    answer: answer || undefined,
    sources: sources.length ? sources : undefined,
    structured: {
      content_trust: 'untrusted',
      content_trust_source: 'gui',
      finalUrl: finalUrl || undefined,
      stepCount,
      dataChunks: data.length,
      stats,
      ...(failureType ? { failureType } : {}),
    },
    error_code: ok ? undefined : semanticBlock?.failureType || params.error_code || 'empty_result',
    needs_clarify: !ok && (failureType === 'captcha' || failureType === 'need_human' || failureType === 'need_login'),
    latency_ms: params.latency_ms
  }
}
