import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPgQuery } from '#agent-shared/agentPgClient'
import {
  isConfirmedExperienceRow,
  isExperienceRecallConfirmedOnly,
  shouldRecallExperienceForPlane
} from '#agent-shared/experienceRecallPolicy'
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres
} from '#agent-shared/storageBackend'
import { normalizeTenantId, tenantPolicyDir } from '#agent-shared/tenantScope'

export type RagLearningSignalRow = {
  question: string
  question_norm?: string
  score: number
  comment?: string
  path?: string
  source?: string
  source_plane?: string
  at: string
  tenantId?: string
  /** 会话内打标：撤回/重生作废用（对齐总管） */
  sessionId?: string
  userMessageIndex?: number
  runId?: string
  superseded?: boolean
  supersededReason?: 'regenerate' | 'edit_resend' | 'withdraw' | string
  supersededAt?: string
  learnEligible?: boolean
}

const signalsCacheByTenant = new Map<string, RagLearningSignalRow[]>()

function dataDir(tenantId?: string) {
  const base = join(process.cwd(), '.data')
  const dir = tenantPolicyDir(base, normalizeTenantId(tenantId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function signalsFilePath(tenantId?: string) {
  return join(dataDir(tenantId), 'rag-learning-signals.jsonl')
}

export function resolveRagStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.RAG_AGENT_STORAGE_BACKEND, 'file')
}

function readJsonlLines<T>(file: string, maxLines = 500): T[] {
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const slice = lines.slice(-maxLines)
    const out: T[] = []
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        /* skip */
      }
    }
    return out
  } catch {
    return []
  }
}

function writeJsonlLines(file: string, rows: RagLearningSignalRow[]): void {
  const dir = join(file, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

/** 无 schema 迁移时把 session/umidx 编进 comment，便于 PG 侧作废匹配 */
export function encodeSignalMetaComment(
  comment: string | undefined,
  meta: { sessionId?: string; userMessageIndex?: number; runId?: string; superseded?: boolean }
): string {
  const base = String(comment || '').replace(/\n?__ragmeta__:[^\n]*/g, '').trim()
  const payload = JSON.stringify({
    sid: meta.sessionId || undefined,
    umidx: typeof meta.userMessageIndex === 'number' ? meta.userMessageIndex : undefined,
    runId: meta.runId || undefined,
    superseded: meta.superseded === true ? true : undefined
  })
  if (!meta.sessionId && meta.userMessageIndex == null && !meta.runId && !meta.superseded) return base
  return base ? `${base}\n__ragmeta__:${payload}` : `__ragmeta__:${payload}`
}

export function parseSignalMetaComment(comment?: string): {
  sessionId?: string
  userMessageIndex?: number
  runId?: string
  superseded?: boolean
} {
  const m = String(comment || '').match(/__ragmeta__:(\{[^}]+\})/)
  if (!m?.[1]) return {}
  try {
    const o = JSON.parse(m[1]) as Record<string, unknown>
    const umidx = o.umidx
    return {
      sessionId: typeof o.sid === 'string' ? o.sid : undefined,
      userMessageIndex:
        typeof umidx === 'number' && Number.isFinite(umidx) ? Math.floor(umidx) : undefined,
      runId: typeof o.runId === 'string' ? o.runId : undefined,
      superseded: o.superseded === true
    }
  } catch {
    return {}
  }
}

function hydrateRowMeta(row: RagLearningSignalRow): RagLearningSignalRow {
  const meta = parseSignalMetaComment(row.comment)
  return {
    ...row,
    sessionId: row.sessionId || meta.sessionId,
    userMessageIndex:
      typeof row.userMessageIndex === 'number' ? row.userMessageIndex : meta.userMessageIndex,
    runId: row.runId || meta.runId,
    superseded: row.superseded === true || meta.superseded === true
  }
}

function appendSignalToFile(row: RagLearningSignalRow): void {
  try {
    appendFileSync(signalsFilePath(row.tenantId), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

async function appendSignalToPg(row: RagLearningSignalRow): Promise<boolean> {
  const tid = normalizeTenantId(row.tenantId)
  const comment = encodeSignalMetaComment(row.comment, {
    sessionId: row.sessionId,
    userMessageIndex: row.userMessageIndex,
    runId: row.runId,
    superseded: row.superseded
  })
  const res = await agentPgQuery(
    `INSERT INTO rag_learning_signals
      (at, question, question_norm, score, comment, path, source, tenant_id, source_plane)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.at,
      row.question,
      row.question_norm ?? null,
      row.score,
      comment || null,
      row.path ?? null,
      row.source ?? null,
      tid,
      row.source_plane ?? 'standalone'
    ]
  )
  return Boolean(res)
}

async function readSignalsFromPg(maxLines = 500, tenantId?: string): Promise<RagLearningSignalRow[] | null> {
  const tid = normalizeTenantId(tenantId)
  const res = await agentPgQuery<{
    id: number
    at: string
    question: string
    question_norm: string | null
    score: number
    comment: string | null
    path: string | null
    source: string | null
    source_plane: string | null
  }>(
    `SELECT id, at, question, question_norm, score, comment, path, source, source_plane
     FROM rag_learning_signals
     WHERE tenant_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [tid, maxLines]
  )
  if (!res) return null
  return res.rows.reverse().map((r) =>
    hydrateRowMeta({
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      question: r.question,
      question_norm: r.question_norm ?? undefined,
      score: Number(r.score),
      comment: r.comment ?? undefined,
      path: r.path ?? undefined,
      source: r.source ?? undefined,
      source_plane: r.source_plane ?? undefined,
      tenantId: tid
    })
  )
}

export function activeRagLearningSignals(rows: RagLearningSignalRow[]): RagLearningSignalRow[] {
  return rows.filter((r) => !r.superseded && r.learnEligible !== false)
}

/** 仅「有用/无用」显式反馈或联邦 👍 确认可进偏好；finalize 自动同步排除 */
export function mayUseRagLearningSignalForRecall(
  row: RagLearningSignalRow,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (row.superseded || row.learnEligible === false) return false
  if (!shouldRecallExperienceForPlane('standalone', row, env)) return false
  if (!isExperienceRecallConfirmedOnly(env)) return true
  const src = String(row.source || '')
  if (isConfirmedExperienceRow({ source: src, status: undefined, userConfirmed: false })) return true
  const score = Number(row.score)
  if (
    (score === 1 || score === -1) &&
    !src.includes('manager_finalize_sync') &&
    !src.toLowerCase().includes('federation')
  ) {
    return true
  }
  return false
}

export async function readRagLearningSignalsAsync(maxLines = 500, tenantId?: string): Promise<RagLearningSignalRow[]> {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveRagStorageBackend()
  if (isPostgresStorageEnabled(backend)) {
    const pg = await readSignalsFromPg(maxLines, tid)
    if (pg?.length) return pg
    if (backend === 'postgres' && pg) return pg
  }
  return readJsonlLines<RagLearningSignalRow>(signalsFilePath(tid), maxLines).map(hydrateRowMeta)
}

export async function hydrateRagSignalsCache(maxLines = 600, tenantId?: string): Promise<void> {
  const tid = normalizeTenantId(tenantId)
  signalsCacheByTenant.set(tid, await readRagLearningSignalsAsync(maxLines, tid))
}

export function invalidateRagSignalsCache(tenantId?: string): void {
  if (tenantId) signalsCacheByTenant.delete(normalizeTenantId(tenantId))
  else signalsCacheByTenant.clear()
}

export function readRagLearningSignalsSync(maxLines = 500, tenantId?: string): RagLearningSignalRow[] {
  const tid = normalizeTenantId(tenantId)
  const backend = resolveRagStorageBackend()
  const cache = signalsCacheByTenant.get(tid)
  const rows =
    isPostgresStorageEnabled(backend) && cache?.length
      ? cache.slice(-maxLines)
      : readJsonlLines<RagLearningSignalRow>(signalsFilePath(tid), maxLines).map(hydrateRowMeta)
  return activeRagLearningSignals(rows.filter((r) => mayUseRagLearningSignalForRecall(r)))
}

export async function persistRagLearningSignal(row: RagLearningSignalRow): Promise<void> {
  const tid = normalizeTenantId(row.tenantId)
  const withTenant: RagLearningSignalRow = {
    ...row,
    tenantId: tid,
    learnEligible: row.learnEligible !== false,
    superseded: row.superseded === true
  }
  const backend = resolveRagStorageBackend()
  if (shouldWritePostgres(backend)) {
    try {
      await appendSignalToPg(withTenant)
    } catch {
      /* fallback */
    }
  }
  if (shouldWriteFile(backend)) {
    appendSignalToFile(withTenant)
  }
  let cache = signalsCacheByTenant.get(tid)
  if (!cache) cache = []
  cache.push(withTenant)
  if (cache.length > 800) cache = cache.slice(-600)
  signalsCacheByTenant.set(tid, cache)
}

/**
 * 重新生成 / 编辑重发 / 撤回：作废同会话学习信号，对齐总管 supersedeLearningSignalsForRevision。
 * withdraw：userMessageIndex >= from；regen/edit：仅同轮。
 */
export async function supersedeRagLearningSignalsForRevision(input: {
  sessionId: string
  userMessageIndex?: number | null
  fromUserMessageIndex?: number | null
  reason: 'regenerate' | 'edit_resend' | 'withdraw'
  tenantId?: string
}): Promise<{ superseded: number }> {
  const sid = String(input.sessionId || '').trim()
  if (!sid) return { superseded: 0 }
  const tid = normalizeTenantId(input.tenantId)
  const uidx =
    typeof input.userMessageIndex === 'number' && Number.isFinite(input.userMessageIndex)
      ? Math.floor(input.userMessageIndex)
      : null
  const fromIdx =
    typeof input.fromUserMessageIndex === 'number' && Number.isFinite(input.fromUserMessageIndex)
      ? Math.floor(input.fromUserMessageIndex)
      : input.reason === 'withdraw' && uidx != null
        ? uidx
        : null

  const file = signalsFilePath(tid)
  const rows = readJsonlLines<RagLearningSignalRow>(file, 2000).map(hydrateRowMeta)
  const now = new Date().toISOString()
  let superseded = 0
  const next = rows.map((o) => {
    if (o.superseded) return o
    if (String(o.sessionId || '').trim() !== sid) return o
    const sigIdx =
      typeof o.userMessageIndex === 'number' && Number.isFinite(o.userMessageIndex)
        ? Math.floor(o.userMessageIndex)
        : null
    const sameTurn = uidx != null && sigIdx === uidx
    const fromTurn = fromIdx != null && sigIdx != null && sigIdx >= fromIdx
    const withdrawLegacy = input.reason === 'withdraw' && fromIdx != null && sigIdx == null
    if (!sameTurn && !fromTurn && !withdrawLegacy) return o
    superseded += 1
    return {
      ...o,
      superseded: true,
      supersededReason: input.reason,
      supersededAt: now,
      learnEligible: false,
      comment: encodeSignalMetaComment(o.comment, {
        sessionId: o.sessionId,
        userMessageIndex: o.userMessageIndex,
        runId: o.runId,
        superseded: true
      })
    }
  })
  if (superseded > 0 && shouldWriteFile(resolveRagStorageBackend())) {
    writeJsonlLines(file, next)
  }
  invalidateRagSignalsCache(tid)
  signalsCacheByTenant.set(tid, next.slice(-600))

  // PG：按 comment 内 __ragmeta__ 匹配后重写 comment（无额外列）
  if (shouldWritePostgres(resolveRagStorageBackend()) || isPostgresStorageEnabled(resolveRagStorageBackend())) {
    try {
      const pg = await agentPgQuery<{ id: number; comment: string | null }>(
        `SELECT id, comment FROM rag_learning_signals WHERE tenant_id = $1 ORDER BY id DESC LIMIT 800`,
        [tid]
      )
      if (pg?.rows?.length) {
        for (const r of pg.rows) {
          const meta = parseSignalMetaComment(r.comment || undefined)
          if (meta.superseded) continue
          if (String(meta.sessionId || '') !== sid) continue
          const sigIdx =
            typeof meta.userMessageIndex === 'number' && Number.isFinite(meta.userMessageIndex)
              ? Math.floor(meta.userMessageIndex)
              : null
          const sameTurn = uidx != null && sigIdx === uidx
          const fromTurn = fromIdx != null && sigIdx != null && sigIdx >= fromIdx
          const withdrawLegacy = input.reason === 'withdraw' && fromIdx != null && sigIdx == null
          if (!sameTurn && !fromTurn && !withdrawLegacy) continue
          const newComment = encodeSignalMetaComment(r.comment || undefined, {
            sessionId: meta.sessionId,
            userMessageIndex: meta.userMessageIndex,
            runId: meta.runId,
            superseded: true
          })
          await agentPgQuery(`UPDATE rag_learning_signals SET comment = $1 WHERE id = $2`, [
            newComment,
            r.id
          ])
        }
      }
    } catch {
      /* optional PG */
    }
  }

  return { superseded }
}

export async function getRagMemoryStatus(): Promise<{
  backend: ReturnType<typeof resolveRagStorageBackend>
  pgConfigured: boolean
  pgReachable: boolean
}> {
  const backend = resolveRagStorageBackend()
  const { isAgentPgConfigured, pingAgentPg } = await import('#agent-shared/agentPgClient')
  const pgConfigured = isAgentPgConfigured()
  let pgReachable = false
  if (pgConfigured && isPostgresStorageEnabled(backend)) {
    pgReachable = await pingAgentPg()
  }
  return { backend, pgConfigured, pgReachable }
}
