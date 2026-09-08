/**
 * 编排前轻量看图：短 caption 喂编排 LLM（不传像素）。
 * 超时/失败 → 仅路径 hint，不阻塞编排。
 */
import { callMultimodalCaption } from '../../utils/agents/mediaClient'
import type { MediaAttachment } from '../../utils/media/mediaAttachment'
import { clipRouteCaption, withAttachmentCaption } from '../../utils/media/mediaAttachment'

export const ROUTE_CAPTION_TIMEOUT_MS = 8_000
export const ROUTE_CAPTION_MAX_CHARS = 80

export type RouteCaptionResult = {
  caption: string
  ocrSnippet?: string
  captionMs?: number
  captionSource: 'vl' | 'reuse' | 'skip' | 'timeout' | 'error'
}

export function shouldFetchRouteImageCaption(
  attachment?: { filePath?: string; mediaType?: string; caption?: string } | null
): boolean {
  if (!attachment?.filePath) return false
  if (String(attachment.mediaType || '').toLowerCase() !== 'image') return false
  if (String(attachment.caption || '').trim()) return false
  return true
}

/** 纯函数：归一化 caption 结果 */
export function normalizeRouteCaptionResult(raw: {
  caption?: string
  ocrSnippet?: string
  ocr_snippet?: string
  latencyMs?: number
  latency_ms?: number
  source?: RouteCaptionResult['captionSource']
}): RouteCaptionResult {
  const caption = clipRouteCaption(raw.caption || '', ROUTE_CAPTION_MAX_CHARS)
  const ocr = String(raw.ocrSnippet || raw.ocr_snippet || '')
    .trim()
    .slice(0, 120)
  const ms = Number(raw.latencyMs ?? raw.latency_ms)
  return {
    caption,
    ...(ocr ? { ocrSnippet: ocr } : {}),
    ...(Number.isFinite(ms) && ms >= 0 ? { captionMs: Math.floor(ms) } : {}),
    captionSource: raw.source || (caption ? 'vl' : 'error')
  }
}

export function mergeCaptionIntoAttachment(
  attachment: MediaAttachment,
  result: RouteCaptionResult
): MediaAttachment {
  if (!result.caption) {
    return withAttachmentCaption(attachment, {
      captionSource: result.captionSource,
      captionMs: result.captionMs
    })
  }
  return withAttachmentCaption(attachment, {
    caption: result.caption,
    ocrSnippet: result.ocrSnippet,
    captionMs: result.captionMs,
    captionSource: result.captionSource
  })
}

/**
 * 拉取路由 caption；永不抛错阻塞编排。
 */
export async function fetchRouteImageCaption(params: {
  multimodalAgentHttpUrl: string
  attachment: MediaAttachment
  userQuery?: string
  timeoutMs?: number
  traceId?: string
  signal?: AbortSignal
}): Promise<RouteCaptionResult> {
  if (!shouldFetchRouteImageCaption(params.attachment)) {
    const existing = String(params.attachment.caption || '').trim()
    if (existing) {
      return {
        caption: clipRouteCaption(existing),
        ocrSnippet: params.attachment.ocrSnippet,
        captionMs: params.attachment.captionMs,
        captionSource: 'reuse'
      }
    }
    return { caption: '', captionSource: 'skip' }
  }
  const base = String(params.multimodalAgentHttpUrl || '').trim()
  if (!base) return { caption: '', captionSource: 'skip' }

  const timeoutMs = Math.min(
    Math.max(1_500, Number(params.timeoutMs) || ROUTE_CAPTION_TIMEOUT_MS),
    15_000
  )
  const t0 = Date.now()
  try {
    const data = await callMultimodalCaption({
      multimodalAgentHttpUrl: base,
      timeoutMs,
      filePath: params.attachment.filePath,
      query: String(params.userQuery || '').slice(0, 200),
      traceId: params.traceId,
      signal: params.signal
    })
    return normalizeRouteCaptionResult({
      caption: data.caption,
      ocrSnippet: data.ocrSnippet,
      latencyMs: data.latencyMs ?? Date.now() - t0,
      source: 'vl'
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    const timedOut = /timeout|aborted|AbortError/i.test(msg)
    return {
      caption: '',
      captionMs: Date.now() - t0,
      captionSource: timedOut ? 'timeout' : 'error'
    }
  }
}

/** multimodal 执行步：短问+已有 caption → 复用，避免二次长 VL */
export function shouldReuseRouteCaptionForMultimodal(query: string, caption: string): boolean {
  const cap = String(caption || '').trim()
  if (cap.length < 4) return false
  const q = String(query || '').trim()
  if (!q || q.length <= 24) return true
  const generic =
    /^(请分析附件并回答|分析(一下)?(这张)?图|描述画面|识别图片|看看这张图|图里有什么)/.test(q) ||
    q === '请理解附件'
  return generic && q.length < 80
}

/** 注入下游 DB/RAG query 的图意块 */
export function formatCaptionUpstreamBlock(attachment?: {
  caption?: string
  ocrSnippet?: string
} | null): string {
  const cap = String(attachment?.caption || '').trim()
  if (!cap) return ''
  const ocr = String(attachment?.ocrSnippet || '').trim()
  const lines = [`【附件画面摘要】${cap}`]
  if (ocr) lines.push(`【画面文字】${ocr.slice(0, 80)}`)
  return lines.join('\n')
}
