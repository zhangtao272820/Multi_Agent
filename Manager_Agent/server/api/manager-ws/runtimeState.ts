import type { SessionMessage } from '../../utils/session/managerSessionStore'

export type WsSession = { messages: SessionMessage[] }

export const sessions = new Map<string, WsSession>()
export const runs = new Map<string, AbortController>()
export const sessionMeta = new Map<string, { lastActiveMs: number; activeRunId?: string }>()
export const runMeta = new Map<string, { startedAtMs: number; sessionId: string; tenantId?: string }>()
export const peerUnregister = new Map<object, () => void>()

const rate = new Map<string, number[]>()

export function nowMs() {
  return Date.now()
}

export function isRunAbortError(ctrl: AbortController, err: unknown) {
  const msg = String((err as { message?: string })?.message || err || '')
  return ctrl.signal.aborted || /abort(ed)?/i.test(msg)
}

export function touchSession(sessionId: string) {
  const prev = sessionMeta.get(sessionId)
  sessionMeta.set(sessionId, { lastActiveMs: nowMs(), activeRunId: prev?.activeRunId })
}

export function cleanupMaps() {
  const now = nowMs()
  const sessionTtlMs = 30 * 60_000
  for (const [sid, meta] of sessionMeta.entries()) {
    if (now - meta.lastActiveMs > sessionTtlMs) {
      sessionMeta.delete(sid)
      sessions.delete(sid)
    }
  }
  const runTtlMs = 12 * 60_000
  for (const [rid, meta] of runMeta.entries()) {
    if (now - meta.startedAtMs > runTtlMs) {
      runMeta.delete(rid)
      const ctrl = runs.get(rid)
      if (ctrl) {
        ctrl.abort()
        runs.delete(rid)
      }
      const sid = meta.sessionId
      const sMeta = sessionMeta.get(sid)
      if (sMeta?.activeRunId === rid) sessionMeta.set(sid, { ...sMeta, activeRunId: undefined })
    }
  }
  const maxSessions = 220
  if (sessionMeta.size > maxSessions) {
    const items = Array.from(sessionMeta.entries()).sort((a, b) => a[1].lastActiveMs - b[1].lastActiveMs)
    for (let i = 0; i < items.length - maxSessions; i++) {
      const sid = items[i]?.[0]
      if (sid) {
        sessionMeta.delete(sid)
        sessions.delete(sid)
      }
    }
  }
}

export function allowRate(key: string, limit: number, windowMs: number) {
  const now = nowMs()
  const arr = rate.get(key) || []
  const kept = arr.filter((t) => now - t < windowMs)
  kept.push(now)
  rate.set(key, kept)
  return kept.length <= limit
}
