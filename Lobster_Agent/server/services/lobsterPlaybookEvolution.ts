/**
 * Lobster playbook 门禁进化：成功轨迹 → shadow → verify → 人审 promote → active cache。
 * 默认 LOBSTER_PLAYBOOK_AUTO_PROMOTE=0（禁止无人值守）。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  playbookCacheKey,
  type PlaybookRecord,
} from './lobsterPlaybookCache'
import type { LobsterPlanStep, LobsterTaskGoals, LobsterTaskKind } from './lobsterTaskUnderstandSchema'

export type PlaybookShadowRecord = PlaybookRecord & {
  status: 'shadow' | 'active' | 'rejected'
  promotedAt?: number
  previousActive?: PlaybookRecord | null
}

function evoEnabled(): boolean {
  return String(process.env.LOBSTER_PLAYBOOK_EVOLUTION ?? '1').trim() !== '0'
}

function autoPromoteAllowed(): boolean {
  if (String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1') return false
  return String(process.env.LOBSTER_PLAYBOOK_AUTO_PROMOTE ?? '0').trim() === '1'
}

function dataDir(): string {
  const fromEnv = String(process.env.LOBSTER_PLAYBOOK_DIR || '').trim()
  if (fromEnv) return fromEnv
  return path.join(process.cwd(), '.data', 'lobster')
}

function shadowPath(): string {
  return path.join(dataDir(), 'playbook-shadow.jsonl')
}

function activePath(): string {
  return path.join(dataDir(), 'playbook-active.jsonl')
}

function readJsonl(file: string): PlaybookShadowRecord[] {
  if (!fs.existsSync(file)) return []
  try {
    const out: PlaybookShadowRecord[] = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try {
        const row = JSON.parse(s) as PlaybookShadowRecord
        if (row?.key && Array.isArray(row.plan_steps)) out.push(row)
      } catch {
        /* skip */
      }
    }
    return out
  } catch {
    return []
  }
}

function writeJsonl(file: string, rows: PlaybookShadowRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = rows
    .slice(-200)
    .map((r) => JSON.stringify(r))
    .join('\n')
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8')
}

function hostFromUrl(url?: string): string {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function normalizeSteps(steps: LobsterPlanStep[]): LobsterPlanStep[] {
  return (steps || [])
    .filter((s) => s && s.op)
    .slice(0, 8)
    .map((s) => ({
      op: s.op,
      ...(s.target ? { target: String(s.target).slice(0, 240) } : {}),
      ...(s.done_when ? { done_when: String(s.done_when).slice(0, 240) } : {}),
    }))
}

/** 结构门禁：步数、禁空、含 success 语义字段 */
export function verifyLobsterPlaybookStructure(rec: {
  plan_steps?: LobsterPlanStep[]
  host?: string
}): { ok: boolean; checks: Array<{ id: string; ok: boolean; detail?: string }> } {
  const checks: Array<{ id: string; ok: boolean; detail?: string }> = []
  const steps = rec.plan_steps || []
  checks.push({ id: 'has_steps', ok: steps.length > 0 && steps.length <= 8, detail: `n=${steps.length}` })
  checks.push({ id: 'has_host', ok: Boolean(String(rec.host || '').trim()) })
  checks.push({
    id: 'ops_valid',
    ok: steps.every((s) => Boolean(s?.op) && String(s.op).length < 40),
  })
  checks.push({
    id: 'no_mcp_engine_hint',
    ok: !JSON.stringify(steps).toLowerCase().includes('"engine":"mcp"'),
  })
  return { ok: checks.every((c) => c.ok), checks }
}

/** 成功 AVR 后写入 shadow（默认）；仅当允许自动晋级时写 active */
export function savePlaybookEvolved(input: {
  startUrl?: string
  taskKind?: LobsterTaskKind | string | null
  goals?: LobsterTaskGoals | null
  plan_steps: LobsterPlanStep[]
}): PlaybookShadowRecord | null {
  if (!evoEnabled()) return null
  const host = hostFromUrl(input.startUrl)
  const steps = normalizeSteps(input.plan_steps)
  if (!host || !steps.length) return null
  const key = playbookCacheKey(input)
  const base: PlaybookShadowRecord = {
    key,
    host,
    taskKind: String(input.taskKind || 'unknown'),
    goalsFp: '',
    plan_steps: steps,
    savedAt: Date.now(),
    hits: 0,
    status: 'shadow',
  }
  // goalsFp 与 cache 一致：复用 lookup 键
  const keyed = { ...base, key }

  const gate = verifyLobsterPlaybookStructure(keyed)
  if (!gate.ok) return null

  if (autoPromoteAllowed()) {
    const actives = readJsonl(activePath()).filter((r) => r.key !== key)
    const active: PlaybookShadowRecord = {
      ...keyed,
      status: 'active',
      promotedAt: Date.now(),
    }
    actives.push(active)
    writeJsonl(activePath(), actives)
    return active
  }

  const shadows = readJsonl(shadowPath()).filter((r) => r.key !== key)
  shadows.push(keyed)
  writeJsonl(shadowPath(), shadows)
  return keyed
}

export function listPlaybookShadows(status: 'shadow' | 'active' | 'all' = 'shadow'): PlaybookShadowRecord[] {
  if (status === 'active') return readJsonl(activePath()).filter((r) => r.status !== 'rejected')
  if (status === 'all') return [...readJsonl(shadowPath()), ...readJsonl(activePath())]
  return readJsonl(shadowPath()).filter((r) => r.status === 'shadow' || !r.status)
}

export async function promotePlaybookShadow(key: string): Promise<{
  ok: boolean
  reason?: string
  record?: PlaybookShadowRecord
  verify?: { ok: boolean; reason?: string; gate?: string }
}> {
  const k = String(key || '').trim()
  if (!k) return { ok: false, reason: 'missing_key' }
  const shadows = readJsonl(shadowPath())
  const hit = shadows.find((r) => r.key === k)
  if (!hit) return { ok: false, reason: 'shadow_not_found' }
  const gate = verifyLobsterPlaybookStructure(hit)
  if (!gate.ok) return { ok: false, reason: 'verify_failed', verify: { ok: false, reason: 'structure', gate: 'structure' } }

  try {
    const { verifyBeforePromoteLobster } = await import('#agent-shared/evolutionVerifyLobster')
    const shared = await verifyBeforePromoteLobster()
    if (!shared.ok) {
      return {
        ok: false,
        reason: shared.reason || 'shared_verify_failed',
        verify: { ok: false, reason: shared.reason, gate: shared.gate },
      }
    }
  } catch (e) {
    return { ok: false, reason: `verify_import:${String((e as Error)?.message || e)}` }
  }

  const actives = readJsonl(activePath())
  const prev = actives.find((r) => r.key === k) || null
  const next: PlaybookShadowRecord = {
    ...hit,
    status: 'active',
    promotedAt: Date.now(),
    previousActive: prev,
  }
  writeJsonl(
    activePath(),
    [...actives.filter((r) => r.key !== k), next]
  )
  writeJsonl(
    shadowPath(),
    shadows.filter((r) => r.key !== k)
  )
  return { ok: true, record: next, verify: { ok: true, gate: 'lobster_playbook_structure' } }
}

export function rollbackPlaybookActive(key: string): { ok: boolean; reason?: string } {
  const k = String(key || '').trim()
  if (!k) return { ok: false, reason: 'missing_key' }
  const actives = readJsonl(activePath())
  const hit = actives.find((r) => r.key === k)
  if (!hit) return { ok: false, reason: 'active_not_found' }
  const prev = hit.previousActive
  const rest = actives.filter((r) => r.key !== k)
  if (prev && prev.plan_steps?.length) {
    rest.push({ ...prev, status: 'active', promotedAt: Date.now(), previousActive: null })
  }
  writeJsonl(activePath(), rest)
  // 退回 shadow 便于再审
  const shadows = readJsonl(shadowPath()).filter((r) => r.key !== k)
  shadows.push({ ...hit, status: 'shadow', promotedAt: undefined, previousActive: undefined })
  writeJsonl(shadowPath(), shadows)
  return { ok: true }
}

export function rejectPlaybookShadow(key: string): { ok: boolean; reason?: string } {
  const k = String(key || '').trim()
  if (!k) return { ok: false, reason: 'missing_key' }
  const shadows = readJsonl(shadowPath())
  const hit = shadows.find((r) => r.key === k)
  if (!hit) return { ok: false, reason: 'shadow_not_found' }
  writeJsonl(
    shadowPath(),
    shadows.filter((r) => r.key !== k)
  )
  return { ok: true }
}

/** 运行时优先用已人审 active；否则回落旧 cache */
export function lookupEvolvedOrCache(input: {
  startUrl?: string
  taskKind?: LobsterTaskKind | string | null
  goals?: LobsterTaskGoals | null
  legacyLookup: () => PlaybookRecord | null
}): PlaybookRecord | null {
  if (evoEnabled()) {
    const key = playbookCacheKey(input)
    const active = readJsonl(activePath()).find((r) => r.key === key && r.status === 'active')
    if (active?.plan_steps?.length) return active
  }
  return input.legacyLookup()
}
