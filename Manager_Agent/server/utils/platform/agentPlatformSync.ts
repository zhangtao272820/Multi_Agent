import { agentWsUrlToHttpOrigin, resolveAgentEndpoints, resolveAgentUrl, type ResolvedAgentEndpoints } from './agentEndpoints'
import { platformSyncTimeoutMs } from '../../graph/core/probe/probeConfig'
import { isPlatformEndpointSyncEnabledByMode, resolveManagerEnvBool } from './managerEnvModes'

export type PlatformAgentRow = {
  name: string
  category?: string
  endpoint: string
  status?: string
}

type PlatformEndpointsPayload = {
  ok?: boolean
  agents?: PlatformAgentRow[]
  specs?: Array<{ name: string; endpoint: string; category?: string }>
}

const NAME_TO_ENV: Record<string, Partial<Record<keyof ResolvedAgentEndpoints, 'http' | 'ws'>>> = {
  DB_Agent: { dbAgentHttpUrl: 'http', dbAgentWsUrl: 'ws' },
  RAG_Agent: { ragAgentHttpUrl: 'http' },
  code_assistent_Agent: { codeAgentWsUrl: 'ws' },
  CodePy_Agent: { codeAgentWsUrl: 'ws' },
  Extractor_Agent: { crawlerAgentWsUrl: 'ws' },
  ExtractorPy_Agent: { crawlerAgentWsUrl: 'ws' },
  Lobster_Agent: { lobsterAgentWsUrl: 'ws' },
  LobsterPy_Agent: { lobsterAgentWsUrl: 'ws' },
  AI_admin_Agent: { aiAdminAgentWsUrl: 'ws' },
  Multimodal_Agent: { multimodalAgentHttpUrl: 'http' },
  Music_Agent: { musicAgentHttpUrl: 'http', musicAgentWsUrl: 'ws' },
  Video_Agent: { videoAgentHttpUrl: 'http', videoAgentWsUrl: 'ws' }
}

function wsFromHttp(httpBase: string, suffix: string) {
  const base = String(httpBase || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  try {
    const u = new URL(base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = suffix.startsWith('/') ? suffix : `/${suffix}`
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return ''
  }
}

function deriveWsUrl(name: string, httpBase: string) {
  if (name === 'DB_Agent') return wsFromHttp(httpBase, '/api/chat.ws')
  if (
    name === 'code_assistent_Agent' ||
    name === 'CodePy_Agent' ||
    name === 'Extractor_Agent' ||
    name === 'ExtractorPy_Agent' ||
    name === 'Lobster_Agent' ||
    name === 'LobsterPy_Agent'
  ) {
    return wsFromHttp(httpBase, '/_ws')
  }
  if (name === 'AI_admin_Agent') return wsFromHttp(httpBase, '/api/chat/ws')
  if (name === 'Music_Agent') return wsFromHttp(httpBase, '/ws')
  if (name === 'Video_Agent') return wsFromHttp(httpBase, '/ws/video')
  return ''
}

const PLATFORM_OFFLINE_TO_CAPABILITY: Record<string, string[]> = {
  DB_Agent: ['db'],
  RAG_Agent: ['rag'],
  code_assistent_Agent: ['code'],
  CodePy_Agent: ['code'],
  Extractor_Agent: ['crawler'],
  ExtractorPy_Agent: ['crawler'],
  Lobster_Agent: ['gui'],
  LobsterPy_Agent: ['gui'],
  AI_admin_Agent: ['admin'],
  Multimodal_Agent: ['multimodal'],
  Music_Agent: ['music'],
  Video_Agent: ['video']
}

export function filterAgentsByPlatformOffline<T extends string>(
  agents: T[],
  offlinePlatformNames?: Iterable<string>
): T[] {
  if (!offlinePlatformNames) return agents
  const down = new Set<string>()
  for (const name of offlinePlatformNames) {
    for (const cap of PLATFORM_OFFLINE_TO_CAPABILITY[String(name)] || []) down.add(cap)
  }
  if (!down.size) return agents
  const filtered = agents.filter((a) => !down.has(String(a)))
  return filtered.length ? filtered : agents
}

let cache: { at: number; overrides: Partial<ResolvedAgentEndpoints>; offline: Set<string> } | null = null

function cacheTtlMs() {
  const n = Number(process.env.MANAGER_PLATFORM_SYNC_TTL_MS ?? 60_000)
  return Number.isFinite(n) && n >= 5_000 ? Math.min(600_000, Math.floor(n)) : 60_000
}

export function isPlatformEndpointSyncEnabled(env: NodeJS.ProcessEnv = process.env) {
  const url = String(env.CLAWHIVE_BACKEND_URL || '').trim()
  const token = String(env.CLAWHIVE_INTERNAL_TOKEN || env.MANAGER_OPS_TOKEN || '').trim()
  if (!url || !token) return false
  const byMode = isPlatformEndpointSyncEnabledByMode(env)
  if (byMode !== null) return byMode
  return resolveManagerEnvBool('MANAGER_PLATFORM_SYNC', env)
}

export async function fetchPlatformAgentEndpoints(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ overrides: Partial<ResolvedAgentEndpoints>; offline: Set<string> }> {
  const base = String(env.CLAWHIVE_BACKEND_URL || '').trim().replace(/\/+$/, '')
  const token = String(env.CLAWHIVE_INTERNAL_TOKEN || env.MANAGER_OPS_TOKEN || '').trim()
  if (!base || !token) return { overrides: {}, offline: new Set() }

  const url = `${base}/api/internal/agent-endpoints`
  const res = await fetch(url, {
    headers: { 'x-clawhive-internal-token': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(platformSyncTimeoutMs())
  })
  if (!res.ok) throw new Error(`platform endpoints ${res.status}`)
  const data = (await res.json()) as PlatformEndpointsPayload
  const rows = Array.isArray(data.agents) ? data.agents : []
  const overrides: Partial<ResolvedAgentEndpoints> = {}
  const offline = new Set<string>()

  for (const row of rows) {
    const name = String(row?.name || '').trim()
    const endpoint = resolveAgentUrl(String(row?.endpoint || '').trim(), env)
    if (!name || !endpoint) continue
    const status = String(row?.status || 'online').trim().toLowerCase()
    if (status === 'offline' || status === 'down') offline.add(name)

    const map = NAME_TO_ENV[name]
    if (!map) continue
    for (const [key, kind] of Object.entries(map) as Array<[keyof ResolvedAgentEndpoints, 'http' | 'ws']>) {
      if (kind === 'http') {
        ;(overrides as Record<string, string>)[key] = endpoint
      } else {
        const ws = deriveWsUrl(name, endpoint)
        if (ws) (overrides as Record<string, string>)[key] = resolveAgentUrl(ws, env)
      }
    }
    if (name === 'Extractor_Agent') {
      overrides.crawlerAgentWsUrl =
        overrides.crawlerAgentWsUrl || resolveAgentUrl(deriveWsUrl(name, endpoint), env)
      const httpOrigin = agentWsUrlToHttpOrigin(overrides.crawlerAgentWsUrl || deriveWsUrl(name, endpoint))
      if (httpOrigin) (overrides as any).crawlerAgentHttpUrl = httpOrigin
    }
    if (name === 'Lobster_Agent' || name === 'LobsterPy_Agent') {
      overrides.lobsterAgentWsUrl =
        overrides.lobsterAgentWsUrl || resolveAgentUrl(deriveWsUrl(name, endpoint), env)
    }
  }

  return { overrides, offline }
}

export async function getPlatformEndpointOverrides(env: NodeJS.ProcessEnv = process.env) {
  if (!isPlatformEndpointSyncEnabled()) return { overrides: {} as Partial<ResolvedAgentEndpoints>, offline: new Set<string>() }
  const now = Date.now()
  if (cache && now - cache.at < cacheTtlMs()) return { overrides: cache.overrides, offline: cache.offline }
  try {
    const fresh = await fetchPlatformAgentEndpoints(env)
    cache = { at: now, ...fresh }
    return fresh
  } catch {
    return cache ? { overrides: cache.overrides, offline: cache.offline } : { overrides: {}, offline: new Set() }
  }
}

export async function resolveAgentEndpointsWithPlatform(
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedAgentEndpoints & { platformOffline?: string[] }> {
  const base = resolveAgentEndpoints(env)
  const { overrides, offline } = await getPlatformEndpointOverrides(env)
  const merged = { ...base, ...overrides } as ResolvedAgentEndpoints
  return {
    ...merged,
    platformOffline: offline.size ? Array.from(offline) : undefined
  }
}
