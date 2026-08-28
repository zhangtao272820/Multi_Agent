/**
 * Wave 8+：用户显式记忆（记住答案 / 👍）候选队列。
 * 默认须人审 promote 后才写入 experience 并参与召回；自我进化高危路径。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathKeyFromAgents } from '#agent-shared/agentMemoryRecall'
import { deriveScenarioKey } from '../text'
import { readManagerExperienceHistory } from '../runtime/runtimePersistence'

export type ExperienceCandidateSource = 'explicit_user_request' | 'explicit_feedback'

export type ExperienceCandidateRecord = {
  id: string
  userText: string
  scenarioKey: string
  intent: string
  path: string[]
  successScore: number
  feedbackScore?: number
  source: ExperienceCandidateSource
  sourceRunId?: string
  sessionId?: string
  userId?: string
  tenantId?: string
  status: 'draft' | 'promoted' | 'rejected'
  conflictNote?: string
  updatedAt: string
}

export function isExperienceReviewRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_EXPERIENCE_REVIEW_REQUIRED ?? '1').trim() !== '0'
}

function candidatesDir(policyDir: string) {
  return path.join(policyDir, 'experience-candidates')
}

function indexPath(policyDir: string) {
  return path.join(candidatesDir(policyDir), 'index.jsonl')
}

async function readAllIndex(policyDir: string): Promise<ExperienceCandidateRecord[]> {
  const raw = await fs.readFile(indexPath(policyDir), 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const rows: ExperienceCandidateRecord[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      rows.push(JSON.parse(line) as ExperienceCandidateRecord)
    } catch {
      /* skip */
    }
  }
  return rows
}

function dedupeLatest(rows: ExperienceCandidateRecord[]): ExperienceCandidateRecord[] {
  const map = new Map<string, ExperienceCandidateRecord>()
  for (const r of rows) {
    if (r?.id) map.set(r.id, r)
  }
  return Array.from(map.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

async function writeIndex(policyDir: string, rows: ExperienceCandidateRecord[]): Promise<void> {
  const dir = candidatesDir(policyDir)
  await fs.mkdir(dir, { recursive: true })
  const body = rows.map((r) => JSON.stringify(r)).join('\n')
  await fs.writeFile(indexPath(policyDir), body ? `${body}\n` : '', 'utf8')
}

export function detectExperienceConflictNote(
  existing: Array<{ scenarioKey: string; pathKey: string; source?: string; status?: string }>,
  incoming: { scenarioKey: string; pathKey: string }
): string | undefined {
  const notes: string[] = []
  const sk = String(incoming.scenarioKey || '').trim()
  const pk = String(incoming.pathKey || '—').trim()
  if (!sk) return undefined
  for (const row of existing) {
    if (String(row.scenarioKey || '').trim() !== sk) continue
    const ep = String(row.pathKey || '—').trim()
    if (ep !== pk) {
      notes.push(`同场景 path 冲突：已有=${ep}；新提议=${pk}`)
    }
  }
  return notes.length ? [...new Set(notes)].join('；') : undefined
}

async function collectConflictContext(
  policyDir: string,
  scenarioKey: string,
  pathKey: string
): Promise<Array<{ scenarioKey: string; pathKey: string; source?: string; status?: string }>> {
  const ctx: Array<{ scenarioKey: string; pathKey: string; source?: string; status?: string }> = []
  const drafts = dedupeLatest(await readAllIndex(policyDir)).filter((r) => r.status === 'draft')
  for (const d of drafts) {
    ctx.push({
      scenarioKey: d.scenarioKey,
      pathKey: pathKeyFromAgents(d.path),
      source: d.source,
      status: d.status,
    })
  }
  const history = await readManagerExperienceHistory(policyDir, 320).catch(() => [])
  for (const h of history) {
    if (h?.type !== 'experience') continue
    const user = String(h.user || '').trim()
    if (user.length < 4) continue
    const hSk =
      typeof h.scenarioKey === 'string' && h.scenarioKey.trim()
        ? String(h.scenarioKey).trim()
        : deriveScenarioKey(user)
    const pathArr = Array.isArray(h.path) ? h.path.map((x: unknown) => String(x ?? '').trim()).filter(Boolean) : []
    ctx.push({
      scenarioKey: hSk,
      pathKey: pathKeyFromAgents(pathArr),
      source: typeof h.source === 'string' ? h.source : undefined,
      status: 'promoted',
    })
  }
  return ctx
}

export async function upsertExperienceCandidate(
  policyDir: string,
  input: {
    userText: string
    intent: string
    path: string[]
    successScore: number
    feedbackScore?: number
    source: ExperienceCandidateSource
    sourceRunId?: string
    sessionId?: string
    userId?: string
    tenantId?: string
  }
): Promise<{ id: string; conflictNote?: string } | null> {
  const userText = String(input.userText || '').trim()
  if (userText.length < 4) return null
  const scenarioKey = deriveScenarioKey(userText)
  const pathKey = pathKeyFromAgents(input.path)
  const conflictCtx = await collectConflictContext(policyDir, scenarioKey, pathKey)
  const conflictNote = detectExperienceConflictNote(conflictCtx, { scenarioKey, pathKey })

  const existingDraft = dedupeLatest(await readAllIndex(policyDir)).find(
    (r) =>
      r.status === 'draft' &&
      r.sourceRunId &&
      input.sourceRunId &&
      r.sourceRunId === input.sourceRunId
  )
  if (existingDraft) {
    const next: ExperienceCandidateRecord = {
      ...existingDraft,
      userText,
      scenarioKey,
      intent: input.intent,
      path: input.path,
      successScore: input.successScore,
      feedbackScore: input.feedbackScore,
      conflictNote: conflictNote || existingDraft.conflictNote,
      updatedAt: new Date().toISOString(),
    }
    const all = dedupeLatest(await readAllIndex(policyDir))
    const idx = all.findIndex((r) => r.id === existingDraft.id)
    if (idx >= 0) all[idx] = next
    await writeIndex(policyDir, all)
    return { id: existingDraft.id, conflictNote: next.conflictNote }
  }

  const id = `exp_${randomUUID().slice(0, 12)}`
  const row: ExperienceCandidateRecord = {
    id,
    userText,
    scenarioKey,
    intent: String(input.intent || 'unknown').slice(0, 64),
    path: input.path,
    successScore: input.successScore,
    feedbackScore: input.feedbackScore,
    source: input.source,
    sourceRunId: input.sourceRunId,
    sessionId: input.sessionId,
    userId: input.userId,
    tenantId: input.tenantId,
    status: 'draft',
    conflictNote,
    updatedAt: new Date().toISOString(),
  }
  const all = dedupeLatest(await readAllIndex(policyDir))
  all.unshift(row)
  await writeIndex(policyDir, dedupeLatest(all))
  return { id, conflictNote }
}

export async function listExperienceCandidates(
  policyDir: string,
  opts?: { limit?: number; status?: ExperienceCandidateRecord['status'] }
): Promise<ExperienceCandidateRecord[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
  const all = dedupeLatest(await readAllIndex(policyDir))
  const st = opts?.status
  const filtered = st ? all.filter((r) => r.status === st) : all
  return filtered
    .sort((a, b) => {
      const ac = a.conflictNote ? 1 : 0
      const bc = b.conflictNote ? 1 : 0
      if (ac !== bc) return bc - ac
      return String(b.updatedAt).localeCompare(String(a.updatedAt))
    })
    .slice(0, limit)
}

export async function getExperienceCandidate(
  policyDir: string,
  id: string
): Promise<ExperienceCandidateRecord | null> {
  const rid = String(id || '').trim()
  if (!rid) return null
  return (await listExperienceCandidates(policyDir, { limit: 200 })).find((r) => r.id === rid) || null
}

export async function setExperienceCandidateStatus(
  policyDir: string,
  id: string,
  status: 'draft' | 'promoted' | 'rejected'
): Promise<{ ok: boolean; reason?: string; record?: ExperienceCandidateRecord }> {
  const rid = String(id || '').trim()
  if (!rid) return { ok: false, reason: 'missing_id' }
  const all = dedupeLatest(await readAllIndex(policyDir))
  const idx = all.findIndex((r) => r.id === rid)
  if (idx < 0) return { ok: false, reason: 'not_found' }
  const next: ExperienceCandidateRecord = {
    ...all[idx]!,
    status,
    updatedAt: new Date().toISOString(),
  }
  all[idx] = next
  await writeIndex(policyDir, all)
  return { ok: true, record: next }
}
