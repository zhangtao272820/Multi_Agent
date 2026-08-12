import fs from 'node:fs/promises'
import path from 'node:path'
import { textLooksLikeDbEmptyOrRefusal } from '#agent-shared/dbEmptyText'
import type { Intent } from '../../../utils/shared/taskPlan'
import { readHistoryEntries } from '../shared'

const UNIT_MARKERS = ['次', '条', '人', '天', '%', '㎡', 'mg', 'mmhg', 'bpm', '℃'] as const

export function isDbNoData(text: string) {
  const raw = String(text || '')
  const s = raw.toLowerCase()
  const trimmed = s.trim()
  if (!trimmed) return true
  if (trimmed.length < 3) return true
  if (textLooksLikeDbEmptyOrRefusal(raw)) return true
  const hasJson = raw.includes('{') && raw.includes('}')
  const hasFieldColon = raw.includes(':') || raw.includes('：')
  const hasLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0).length >= 3
  const hasNumbers = /\d+/.test(s)
  const hasUnits = UNIT_MARKERS.some((u) => raw.includes(u))
  const looksStructured = hasJson || (hasFieldColon && hasNumbers) || (hasLines && hasNumbers)
  if (!looksStructured && !(hasNumbers && hasUnits)) return true
  return false
}

import { appendManagerMemory, hydrateManagerMemoryCache, readManagerMemorySync } from '../../../utils/session/managerMemoryStore'
import { normalizeManagerMetricEntry, type ManagerMetricEntryInput } from './observabilitySchema'
import { redactForPersistence } from '#agent-shared/redact'

export async function appendMemory(entry: { user: string } & Record<string, any>) {
  await appendManagerMemory(entry)
}

export async function readManagerExperienceHistory(policyDir: string, maxLines = 520, tenantId?: string) {
  await hydrateManagerMemoryCache(maxLines, tenantId)
  return readManagerMemorySync(maxLines, tenantId)
}

export async function appendMetrics(entry: ManagerMetricEntryInput) {
  try {
    const dir = path.join(process.cwd(), '.data')
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    const p = path.join(dir, 'manager-metrics.jsonl')
    const normalized = normalizeManagerMetricEntry(entry)
    const { extra, ...core } = normalized
    const payload = redactForPersistence({
      ...core,
      ...(extra && typeof extra === 'object' ? extra : {})
    }) as Record<string, unknown>
    await fs.appendFile(p, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {}
}

export async function appendNluMetrics(entry: {
  runId: string
  intent: Intent
  routeConfidence: number
  finalConfidence: number
  needsClarify: boolean
  firstPassSuccess: boolean
  clarificationCount: number
  probeDbMatched: boolean
  probeRagHits: number
  experienceReplayCount?: number
  experienceReplayScenarioKey?: string
  /** 与 .data/manager-policy.json version 对齐，供策略灰度/自动回滚统计 */
  policyVersion?: number
  policyCanary?: boolean
  policySource?: string
  promptCanary?: boolean
  promptPatchSource?: string
  plannerRulesCanary?: boolean
  plannerRulesSource?: string
  bundleCanary?: boolean
  bundleId?: string
}) {
  try {
    const dir = path.join(process.cwd(), '.data')
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    const p = path.join(dir, 'manager-nlu-metrics.jsonl')
    await fs.appendFile(
      p,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        runId: entry.runId,
        intent: entry.intent,
        routeConfidence: entry.routeConfidence,
        finalConfidence: entry.finalConfidence,
        needsClarify: entry.needsClarify,
        firstPassSuccess: entry.firstPassSuccess,
        clarificationCount: entry.clarificationCount,
        probeDbMatched: entry.probeDbMatched,
        probeRagHits: entry.probeRagHits,
        ...(typeof entry.experienceReplayCount === 'number' ? { experienceReplayCount: entry.experienceReplayCount } : {}),
        ...(typeof entry.experienceReplayScenarioKey === 'string' && entry.experienceReplayScenarioKey.trim()
          ? { experienceReplayScenarioKey: entry.experienceReplayScenarioKey.trim() }
          : {}),
        ...(typeof entry.policyVersion === 'number' && Number.isFinite(entry.policyVersion)
          ? { policyVersion: Math.floor(entry.policyVersion) }
          : {}),
        ...(typeof entry.policyCanary === 'boolean' ? { policyCanary: entry.policyCanary } : {}),
        ...(typeof entry.policySource === 'string' && entry.policySource.trim()
          ? { policySource: entry.policySource.trim() }
          : {}),
        ...(typeof entry.promptCanary === 'boolean' ? { promptCanary: entry.promptCanary } : {}),
        ...(typeof entry.promptPatchSource === 'string' && entry.promptPatchSource.trim()
          ? { promptPatchSource: entry.promptPatchSource.trim() }
          : {}),
        ...(typeof entry.plannerRulesCanary === 'boolean' ? { plannerRulesCanary: entry.plannerRulesCanary } : {}),
        ...(typeof entry.plannerRulesSource === 'string' && entry.plannerRulesSource.trim()
          ? { plannerRulesSource: entry.plannerRulesSource.trim() }
          : {}),
        ...(typeof entry.bundleCanary === 'boolean' ? { bundleCanary: entry.bundleCanary } : {}),
        ...(typeof entry.bundleId === 'string' && entry.bundleId.trim()
          ? { bundleId: entry.bundleId.trim() }
          : {})
      })}\n`,
      'utf8'
    )
  } catch {}
}

/** 每 run 记录「生效策略 vs manager-policy.shadow.json」差异（需 MANAGER_POLICY_SHADOW_LOG=1） */
export async function appendPolicyShadowObserve(entry: {
  runId: string
  sessionId?: string
  activeVersion: number
  shadowVersion: number
  diffPathCount: number
  paths: string[]
}) {
  try {
    const dir = path.join(process.cwd(), '.data')
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    const p = path.join(dir, 'manager-policy-shadow-observe.jsonl')
    await fs.appendFile(
      p,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        runId: entry.runId,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        activeVersion: entry.activeVersion,
        shadowVersion: entry.shadowVersion,
        diffPathCount: entry.diffPathCount,
        paths: entry.paths.slice(0, 16)
      })}\n`,
      'utf8'
    )
  } catch {}
}

export async function readFeedbackForRun(dir: string, runId: string) {
  const rid = String(runId || '').trim()
  if (!rid) return null
  const jsonlPath = path.join(dir, 'manager-memory.jsonl')
  const jsonPath = path.join(dir, 'manager-memory.json')
  const history = await readHistoryEntries(jsonlPath, jsonPath, 320)
  for (const h of [...history].reverse()) {
    if (h?.type !== 'feedback') continue
    if (String(h?.runId || '').trim() !== rid) continue
    const score = normalizeFeedbackScore(h?.score ?? h?.rating ?? h?.value)
    if (typeof score === 'number') return { score, raw: h }
  }
  return null
}

export function normalizeFeedbackScore(input: any) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input >= 0 && input <= 1) return input
    if (input >= 1 && input <= 5) return (input - 1) / 4
    if (input >= -1 && input <= 1) return (input + 1) / 2
    return null
  }
  const s = String(input ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'up' || s === 'like' || s === 'good' || s === 'yes') return 1
  if (s === 'down' || s === 'dislike' || s === 'bad' || s === 'no') return 0
  const n = Number(s)
  if (Number.isFinite(n)) return normalizeFeedbackScore(n)
  return null
}
