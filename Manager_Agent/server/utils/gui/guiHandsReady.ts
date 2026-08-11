/**
 * 总管侧 Hands / Lobster desktop 健康探针与 WS 分流
 */
export type LobsterReadyProbe = {
  ok: boolean
  ready?: boolean
  handsOnly?: boolean
  service?: string
  engines?: {
    desktop?: { ok?: boolean; error?: string; toolCount?: number }
    stagehand?: { ok?: boolean; error?: string }
  }
  desktop?: { ok?: boolean; error?: string; enabled?: boolean }
  error?: string
}

export function resolveLobsterHandsWsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.LOBSTER_HANDS_WS_URL || '').trim()
}

/** Hands HTTP base：显式 URL，或从 WS 推导，默认 :13109 */
export function resolveLobsterHandsHttpBase(
  env: NodeJS.ProcessEnv = process.env,
  lobsterAgentWsUrl?: string,
): string {
  const fromEnv = String(env.LOBSTER_HANDS_HTTP_URL || '').trim().replace(/\/$/, '')
  if (fromEnv) return fromEnv
  const handsWs = resolveLobsterHandsWsUrl(env)
  if (handsWs) {
    try {
      const u = new URL(handsWs.replace(/^ws/i, 'http'))
      return `${u.protocol}//${u.host}`
    } catch {
      /* ignore */
    }
  }
  // 若未配置 Hands，回退到主 Lobster WS 推导（开发同机 desktop）
  const mainWs = String(lobsterAgentWsUrl || env.LOBSTER_AGENT_WS_URL || '').trim()
  if (mainWs) {
    try {
      const u = new URL(mainWs.replace(/^ws/i, 'http'))
      return `${u.protocol}//${u.host}`
    } catch {
      /* ignore */
    }
  }
  return 'http://127.0.0.1:13109'
}

export function httpBaseFromLobsterWsUrl(wsUrl: string): string {
  const s = String(wsUrl || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s.replace(/^ws/i, 'http'))
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/** 桌面任务应使用的 WS：优先 Hands 侧车 */
export function resolveGuiDesktopWsUrl(input: {
  lobsterAgentWsUrl?: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = input.env || process.env
  const hands = resolveLobsterHandsWsUrl(env)
  if (hands) return hands
  return String(input.lobsterAgentWsUrl || env.LOBSTER_AGENT_WS_URL || '').trim()
}

export async function probeLobsterReady(input: {
  httpBase: string
  timeoutMs?: number
  token?: string
}): Promise<LobsterReadyProbe> {
  const base = String(input.httpBase || '').replace(/\/$/, '')
  if (!base) return { ok: false, error: 'missing_http_base' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), Math.max(800, Number(input.timeoutMs || 2500)))
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = String(
      input.token || process.env.LOBSTER_ADMIN_TOKEN || process.env.CLAWHIVE_INTERNAL_TOKEN || '',
    ).trim()
    if (token) {
      headers.Authorization = `Bearer ${token}`
      headers['x-lobster-token'] = token
    }
    const res = await fetch(`${base}/api/ready`, { signal: ctrl.signal, headers })
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` }
    }
    const json = (await res.json()) as LobsterReadyProbe
    return {
      ok: true,
      ready: Boolean(json.ready),
      handsOnly: Boolean(json.handsOnly),
      service: json.service,
      engines: json.engines,
      desktop: json.desktop,
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'probe_failed').slice(0, 160) }
  } finally {
    clearTimeout(t)
  }
}

export function isDesktopEngineReady(probe: LobsterReadyProbe): boolean {
  if (!probe.ok) return false
  if (probe.engines?.desktop?.ok) return true
  if (probe.desktop?.ok) return true
  // Hands 侧车 HTTP 可达即可尝试桌面任务（MCP 可在任务内暖机）
  if (probe.handsOnly && /hands/i.test(String(probe.service || ''))) return true
  return false
}

export const HANDS_NOT_READY_MESSAGE =
  '桌面 Hands 未就绪。请在 Windows 宿主启动 Hands 侧车（LOBSTER_HANDS_ONLY=1 + LOBSTER_DESKTOP_MCP_ENABLED=1），或配置 LOBSTER_HANDS_WS_URL 后重试。'

export const HANDS_NOT_READY_ERROR_CODE = 'hands_not_ready'
