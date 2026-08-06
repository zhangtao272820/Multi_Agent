/**
 * 按 runId 累积用户可见过程事件，供 assistant 轮 ui_meta 持久化。
 */

export type SessionProcessEvent = {
  kind: string
  text: string
  from?: string
  ts?: string
  extra?: Record<string, unknown>
}

export type SessionUiMeta = {
  process?: SessionProcessEvent[]
}

const PROCESS_EVENT_KINDS = new Set([
  'thinking',
  'thought_delta',
  'phase',
  'status',
  'route_cap',
  'route_plan_card',
  'plan_outline',
  'db_explain',
  'search_sources',
  'run_report',
  'trace'
])

const MAX_EVENTS_PER_RUN = 80
const MAX_TEXT_CHARS = 800
const MAX_EXTRA_JSON = 1200

const byRun = new Map<string, SessionProcessEvent[]>()

function clipText(s: string, max = MAX_TEXT_CHARS): string {
  const t = String(s ?? '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

function clipExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra || typeof extra !== 'object') return undefined
  try {
    const json = JSON.stringify(extra)
    if (json.length <= MAX_EXTRA_JSON) return extra
    return { clipped: json.slice(0, MAX_EXTRA_JSON) }
  } catch {
    return undefined
  }
}

function eventText(event: string, data: unknown): string {
  if (typeof data === 'string') return data
  if (data == null) return ''
  if (typeof data === 'number' || typeof data === 'boolean') return String(data)
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (typeof o.summary === 'string') return o.summary
    if (typeof o.message === 'string') return o.message
    if (event === 'phase') {
      const name = String(o.name ?? o.phase ?? '').trim()
      const runPhase = Number(o.runPhase)
      if (name && Number.isFinite(runPhase) && runPhase > 0) return `${name}:phase${runPhase}`
      if (name) return name
      return String(o.phase ?? o.data ?? '')
    }
    try {
      return JSON.stringify(data)
    } catch {
      return String(data)
    }
  }
  return String(data)
}

function eventExtra(event: string, data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const o = data as Record<string, unknown>
  if (event === 'route_cap') return { routeCap: o }
  if (event === 'route_plan_card') return { routePlanCard: o }
  if (event === 'plan_outline') return { planOutline: o }
  if (event === 'search_sources') return { searchSources: o }
  if (event === 'run_report') return { runReport: o }
  return undefined
}

export function isPersistableProcessEvent(event: string): boolean {
  return PROCESS_EVENT_KINDS.has(String(event || '').toLowerCase())
}

export function noteRunProcessEvent(
  runId: string | undefined,
  event: string,
  data?: unknown,
  from?: string
): void {
  const rid = String(runId || '').trim()
  if (!rid) return
  const kind = String(event || '').toLowerCase()
  if (!isPersistableProcessEvent(kind)) return
  const text = clipText(eventText(kind, data))
  if (!text && kind !== 'route_cap' && kind !== 'route_plan_card' && kind !== 'plan_outline') return

  const list = byRun.get(rid) || []
  if (list.length >= MAX_EVENTS_PER_RUN) return
  const extra = clipExtra(eventExtra(kind, data))
  list.push({
    kind,
    text: text || kind,
    from: from ? String(from).slice(0, 24) : undefined,
    ts: new Date().toISOString(),
    ...(extra ? { extra } : {})
  })
  byRun.set(rid, list)
}

export function takeRunProcessUiMeta(runId: string | undefined): SessionUiMeta | undefined {
  const rid = String(runId || '').trim()
  if (!rid) return undefined
  const process = byRun.get(rid)
  byRun.delete(rid)
  if (!process?.length) return undefined
  return { process }
}

export function peekRunProcessUiMeta(runId: string | undefined): SessionUiMeta | undefined {
  const rid = String(runId || '').trim()
  if (!rid) return undefined
  const process = byRun.get(rid)
  if (!process?.length) return undefined
  return { process: [...process] }
}

export function clearRunProcess(runId: string | undefined): void {
  const rid = String(runId || '').trim()
  if (rid) byRun.delete(rid)
}

/** 测试用：清空全部累积 */
export function resetRunProcessAccumulatorForTests(): void {
  byRun.clear()
}
