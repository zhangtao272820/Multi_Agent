/** Lobster_Agent 平台模型 runtime sync（能力层 + Agent 模型） */

const AGENT_NAME = 'Lobster_Agent'

type PlatformAgentConfigRow = {
  agent_name?: string
  name?: string
  model_planner?: string
  model_executor?: string
  platform_configured?: boolean
  updated_by?: string
  resolved_env_models?: Record<string, string>
}

function isPlatformModelOverrideActive(row?: PlatformAgentConfigRow | null): boolean {
  if (!row) return false
  if (row.platform_configured === true) return true
  const by = String(row.updated_by || '').trim()
  return Boolean(by) && by !== 'seed' && by !== 'system'
}

type PlatformConfigPayload = {
  ok?: boolean
  capability_configured?: boolean
  agents?: PlatformAgentConfigRow[]
}

const ENV_TO_LOBSTER: Record<string, string> = {
  LOBSTER_PLANNER_MODEL: 'plannerModel',
  LOBSTER_DECISION_MODEL: 'decisionModel',
  LOBSTER_VISION_MODEL: 'visionModel',
  LOBSTER_GUI_MODEL: 'guiModel',
  LOBSTER_STAGEHAND_MODEL: 'stagehandModel',
}

let cache: { at: number; payload: PlatformConfigPayload | null } | null = null

function cacheTtlMs() {
  const n = Number(process.env.CLAWHIVE_CONFIG_SYNC_TTL_MS ?? 60_000)
  return Number.isFinite(n) && n >= 5_000 ? Math.min(600_000, Math.floor(n)) : 60_000
}

function isEnabled() {
  const url = String(process.env.CLAWHIVE_BACKEND_URL || '').trim()
  const token = String(process.env.CLAWHIVE_INTERNAL_TOKEN || process.env.AGENT_INTERNAL_TOKEN || '').trim()
  return Boolean(url && token) && String(process.env.CLAWHIVE_CONFIG_SYNC ?? '1').trim() !== '0'
}

async function getPayload(): Promise<PlatformConfigPayload | null> {
  if (!isEnabled()) return null
  const now = Date.now()
  if (cache && now - cache.at < cacheTtlMs()) return cache.payload

  const base = String(process.env.CLAWHIVE_BACKEND_URL || '').trim().replace(/\/+$/, '')
  const token = String(process.env.CLAWHIVE_INTERNAL_TOKEN || process.env.AGENT_INTERNAL_TOKEN || '').trim()
  try {
    const res = await fetch(`${base}/api/internal/agent-config`, {
      headers: { 'x-clawhive-internal-token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(String(res.status))
    const data = (await res.json()) as PlatformConfigPayload
    cache = { at: now, payload: data }
    return data
  } catch {
    return cache?.payload ?? null
  }
}

export async function getLobsterPlatformConfig(): Promise<PlatformAgentConfigRow | null> {
  const payload = await getPayload()
  return (payload?.agents || []).find((a) => String(a?.agent_name || a?.name || '') === AGENT_NAME) || null
}

export async function mergeLobsterRuntimeConfig<T extends { lobster?: Record<string, unknown> }>(cfg: T): Promise<T> {
  const payload = await getPayload()
  const row = (payload?.agents || []).find((a) => String(a?.agent_name || a?.name || '') === AGENT_NAME) || null

  if (payload?.capability_configured && row?.resolved_env_models) {
    const lobster = { ...(cfg.lobster || {}) }
    for (const [envKey, val] of Object.entries(row.resolved_env_models)) {
      const field = ENV_TO_LOBSTER[envKey]
      if (field && String(val || '').trim()) lobster[field] = String(val).trim()
    }
    return { ...cfg, lobster }
  }

  if (!row || !isPlatformModelOverrideActive(row)) return cfg
  const planner = String(row.model_planner || '').trim()
  const executor = String(row.model_executor || '').trim()
  const lobster = { ...(cfg.lobster || {}) }
  if (planner) lobster.plannerModel = planner
  if (executor) lobster.decisionModel = executor
  return { ...cfg, lobster }
}
