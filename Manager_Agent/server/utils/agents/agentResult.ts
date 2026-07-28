import type { AgentResult, AgentSource, CodeAgentMeta, DbResult } from './types'
import { detectLobsterSemanticBlock } from '#agent-shared/lobsterRunVerifyLite'
import { enforceAgentResultContract } from '#agent-shared/agentResultContract'
import { isAdminResultProtocolGarbage } from '../route/managerSubAgentHelpers'

/** E2：统一子 Agent 调用返回值（文本 + 可选结构化契约） */
export type AgentCallResult = {
  answer: string
  agentResult?: AgentResult
}

export function unwrapAgentCall(res: string | AgentCallResult): AgentCallResult {
  if (typeof res === 'string') return { answer: res }
  return {
    answer: String(res?.answer ?? ''),
    agentResult: res?.agentResult
  }
}

/** P2-1：优先采用子 Agent 服务端 agentResult，总管 wrap 仅作 fallback；G1 执法 */
export function coalesceAgentResult(server: AgentResult | null | undefined, fallback: AgentResult): AgentResult {
  let merged: AgentResult
  if (server && typeof server === 'object' && String(server.agent || '').trim()) {
    merged = {
      ...fallback,
      ...server,
      trace_id: String(server.trace_id || fallback.trace_id || '').trim() || undefined,
      answer: String(server.answer || fallback.answer || '').trim() || undefined,
      sources: server.sources?.length ? server.sources : fallback.sources,
      structured: { ...(fallback.structured || {}), ...(server.structured || {}) },
      usage: server.usage || fallback.usage
    }
  } else {
    merged = fallback
  }
  return enforceAgentResultContract(merged, { defaultFailureCode: 'business' })
}

export function agentResultFromPayload(data: unknown, fallback: AgentResult): AgentResult {
  if (!data || typeof data !== 'object') return fallback
  const row = data as Record<string, unknown>
  const server = row.agentResult
  if (server && typeof server === 'object') {
    return coalesceAgentResult(server as AgentResult, fallback)
  }
  return fallback
}

function urlsFromText(text: string): AgentSource[] {
  const sources: AgentSource[] = []
  const seen = new Set<string>()
  for (const m of String(text ?? '').match(/https?:\/\/[^\s)\]>"']+/gi) || []) {
    const ref = m.replace(/[.,;:!?)]+$/, '').trim()
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    sources.push({ type: 'url', ref })
  }
  return sources
}

export function wrapAdminResult(answer: string, traceId?: string): AgentResult {
  const tid = String(traceId || '').trim()
  if (isAdminResultProtocolGarbage(answer)) {
    return {
      ok: false,
      agent: 'admin',
      trace_id: tid,
      answer: '个人助手协议异常：未返回可执行结果。',
      structured: { transport: 'ws' },
      error_code: 'admin_protocol_garbage'
    }
  }
  const head = answer.slice(0, 120).toLowerCase()
  const pending = /【待确认】/.test(answer)
  const cancelled = /未确认，未写入/.test(answer)
  const writeFail = /未能完成写操作|工具未成功|遇到.{0,4}小问题|缺少具体内容|无法成功设置/.test(answer)
  const needsClarify = /请问.*(会议|内容|标题|时间|城市)|请补充|请提供|请指定|请确认.*(时间|标题|会议)|需补充|后重试/.test(
    answer
  )
  const ok =
    Boolean(answer?.trim()) &&
    !head.includes('失败') &&
    !head.includes('error') &&
    !pending &&
    !writeFail &&
    !cancelled &&
    !needsClarify
  const clarifyQuestions = needsClarify
    ? [String(answer || '').trim()].filter((q) => q.length >= 4).slice(0, 3)
    : undefined
  return {
    ok,
    agent: 'admin',
    trace_id: tid,
    answer,
    sources: urlsFromText(answer).length ? urlsFromText(answer) : undefined,
    structured: pending ? { needs_human_confirm: true, transport: 'ws' } : { transport: 'ws' },
    needs_clarify: needsClarify || undefined,
    clarify_questions: clarifyQuestions,
    error_code: needsClarify
      ? 'needs_clarify'
      : cancelled
        ? 'user_cancelled_admin_write'
        : writeFail
          ? 'admin_write_failed'
          : pending
            ? 'needs_human_confirm'
            : undefined
  }
}

export function wrapMultimodalResult(answer: string, raw?: unknown, traceId?: string): AgentResult {
  const tid = String(traceId || '').trim()
  return {
    ok: Boolean(answer?.trim()),
    agent: 'multimodal',
    trace_id: tid,
    answer,
    sources: urlsFromText(answer).length ? urlsFromText(answer) : undefined,
    structured: raw && typeof raw === 'object' ? { raw: raw as Record<string, unknown> } : undefined
  }
}

function mediaArtifactUrlLines(payload?: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const r = (payload as Record<string, unknown>).result ?? payload
  const row = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
  const lines: string[] = []
  const push = (label: string, raw: unknown, kind: 'video' | 'audio' | 'file') => {
    const u = toManagerProxyMediaUrl(String(raw ?? '').trim(), kind)
    if (u) lines.push(`${label}：${u}`)
  }
  push('视频', row.final_video_url || row.video_url, 'video')
  push('MIDI', row.midi_url, 'audio')
  push('试听', row.wav_url || row.instrumental_wav_url || row.remix_wav_url || row.bgm_url || row.audio_url, 'audio')
  push('MP3', row.mp3_url, 'audio')
  push('文件', row.file_url, 'file')
  return lines
}

export function wrapMediaAgentResult(
  agent: 'music' | 'video',
  answer: string,
  payload?: unknown,
  traceId?: string
): AgentResult {
  const tid = String(traceId || '').trim()
  const artifactLines = mediaArtifactUrlLines(payload)
  let mergedAnswer = String(answer ?? '').trim()
  if (artifactLines.length) {
    const missing = artifactLines.filter((line) => !mergedAnswer.includes(line.split('：')[1] || ''))
    if (missing.length) mergedAnswer = [mergedAnswer, ...missing].filter(Boolean).join('\n')
  }
  const sources = urlsFromText(mergedAnswer)
  const jobId =
    payload && typeof payload === 'object'
      ? String((payload as Record<string, unknown>).job_id || (payload as Record<string, unknown>).id || '').trim()
      : ''
  if (jobId) sources.unshift({ type: 'doc', ref: `job:${jobId}` })
  return {
    ok: Boolean(mergedAnswer) && !mergedAnswer.startsWith('错误：'),
    agent,
    trace_id: tid,
    answer: mergedAnswer,
    sources: sources.length ? sources : undefined,
    structured:
      payload && typeof payload === 'object' ? { artifact: payload as Record<string, unknown> } : undefined
  }
}

export function wrapCrawlerResult(answer: string, items: unknown[], traceId?: string): AgentResult {
  const tid = String(traceId || '').trim()
  const sources: AgentSource[] = []
  if (Array.isArray(items)) {
    for (const it of items.slice(0, 12)) {
      const row = it as Record<string, unknown>
      const url = String(row?.url ?? '').trim()
      if (url) sources.push({ type: 'url', ref: url })
    }
  }
  return {
    ok: Boolean(answer?.trim()) || sources.length > 0,
    agent: 'crawler',
    trace_id: tid,
    answer,
    sources: sources.length ? sources : urlsFromText(answer),
    structured: { itemCount: Array.isArray(items) ? items.length : 0 }
  }
}

export function wrapGuiResult(answer: string, raw?: unknown, traceId?: string): AgentResult {
  const tid = String(traceId || '').trim()
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const finalUrl = String(row.finalUrl || '').trim()
  const data = Array.isArray(row.data) ? row.data : []
  const stats = row.stats && typeof row.stats === 'object' ? (row.stats as Record<string, unknown>) : {}
  const sources: AgentSource[] = []
  if (finalUrl) sources.push({ type: 'url', ref: finalUrl })
  for (const chunk of data) {
    if (!chunk || typeof chunk !== 'object') continue
    const items = Array.isArray((chunk as Record<string, unknown>).items)
      ? ((chunk as Record<string, unknown>).items as unknown[])
      : []
    for (const it of items.slice(0, 12)) {
      const r = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const url = String(r.url || r.href || '').trim()
      if (url) sources.push({ type: 'url', ref: url })
    }
  }
  const stepCount = Number(stats.stepCount || 0)
  const text = String(answer || '').trim()
  const semanticBlock = detectLobsterSemanticBlock({
    task: String(row.task || ''),
    result: raw,
    text,
  })
  const failureType =
    semanticBlock?.failureType || String(row.failureType || '').trim() || undefined
  const hasPayload = Boolean(text) || sources.length > 0 || stepCount > 0 || data.length > 0
  return {
    ok: !semanticBlock && hasPayload,
    agent: 'gui',
    trace_id: tid,
    answer: text || undefined,
    sources: sources.length ? sources : urlsFromText(text),
    structured: {
      finalUrl: finalUrl || undefined,
      stepCount,
      dataChunks: data.length,
      stats,
      ...(failureType ? { failureType } : {}),
    },
    error_code: semanticBlock ? semanticBlock.failureType : undefined,
    needs_clarify:
      Boolean(semanticBlock) &&
      (failureType === 'captcha' || failureType === 'need_human' || failureType === 'need_login'),
  }
}

/** 供 synth/critic 注入可追溯来源行 */
export function formatAgentResultSourcesForSynth(
  evidences: Array<Record<string, unknown>>
): string {
  const lines: string[] = []
  for (const ev of evidences) {
    const ar = ev?.agentResult as AgentResult | undefined
    if (!ar?.sources?.length) continue
    const agent = String(ar.agent || ev?.agent || '').trim()
    const refs = ar.sources
      .slice(0, 6)
      .map((s) => `${s.type}:${s.ref}`)
      .join('；')
    if (refs) lines.push(`- ${agent}: ${refs}`)
  }
  if (!lines.length) return ''
  return ['[CTX:agent_result]', ...lines, '[/CTX]'].join('\n')
}

export function dbSourcesFromResult(raw: DbResult): AgentSource[] | undefined {
  const sources: AgentSource[] = []
  if (raw.run_id) sources.push({ type: 'sql', ref: raw.run_id })
  if (raw.transport) sources.push({ type: 'table', ref: `transport:${raw.transport}` })
  return sources.length ? sources : undefined
}

export function wrapDbResult(raw: DbResult, traceId?: string, explainPreflight?: string[]): AgentResult {
  const tid = String(traceId || raw.trace_id || '').trim()
  const explain = Array.isArray(explainPreflight)
    ? explainPreflight.map((x) => String(x ?? '').trim()).filter(Boolean)
    : []
  return {
    ok: !raw.empty,
    agent: 'db',
    trace_id: tid,
    answer: raw.answer,
    sources: dbSourcesFromResult(raw),
    structured: {
      empty: raw.empty,
      reason: raw.reason,
      transport: raw.transport,
      run_id: raw.run_id,
      ...(explain.length ? { explain_preflight: explain } : {})
    },
    error_code: raw.empty ? 'empty_result' : undefined
  }
}

export function wrapRagAnswer(answer: string, traceId?: string, evidence?: unknown): AgentResult {
  const tid = String(traceId || '').trim()
  const ev = evidence as { citations?: Array<{ source?: string; title?: string; url?: string }> } | null
  const sources: AgentSource[] = []
  if (Array.isArray(ev?.citations)) {
    for (const c of ev.citations.slice(0, 12)) {
      const ref = String(c?.source || c?.title || c?.url || '').trim()
      if (ref) sources.push({ type: 'doc', ref })
    }
  }
  const needsClarify = answer.includes('<RAG_NEEDS_CLARIFY>')
  return {
    ok: !needsClarify && !answer.includes('未找到相关背景信息'),
    agent: 'rag',
    trace_id: tid,
    answer,
    sources: sources.length ? sources : undefined,
    structured: evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : undefined,
    needs_clarify: needsClarify,
    error_code: needsClarify ? 'needs_clarify' : undefined
  }
}

export function wrapCodeResult(answer: string, meta?: CodeAgentMeta, traceId?: string): AgentResult {
  const tid = String(traceId || '').trim()
  const needs =
    Boolean(meta?.needsClarify || meta?.needs_clarification) ||
    (Array.isArray(meta?.clarifyQuestions) && meta!.clarifyQuestions!.length > 0)
  const sources: AgentSource[] = []
  for (const p of meta?.files_touched || []) {
    const ref = String(p || '').trim()
    if (ref) sources.push({ type: 'doc', ref })
  }
  const explicit = String((meta as { error_code?: unknown } | undefined)?.error_code || '').trim()
  const trimmed = Boolean(answer?.trim())
  let error_code: string | undefined
  if (needs) error_code = 'needs_clarify'
  else if (explicit) error_code = explicit
  else if (!trimmed) error_code = 'empty_result'
  return {
    ok: trimmed && !needs && !error_code,
    agent: 'code',
    trace_id: tid,
    answer,
    sources: sources.length ? sources : undefined,
    structured: meta ? { ...meta } : undefined,
    needs_clarify: needs,
    clarify_questions: meta?.clarifyQuestions || meta?.questions,
    error_code
  }
}
