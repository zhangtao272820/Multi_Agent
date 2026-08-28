/**
 * P0：产物 PG 存储与 shadow → confirmed / revoked 状态机
 */
import { createHash } from 'node:crypto'
import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import type { ArtifactStatus, FeedbackArtifact } from './artifactFeedbackPolicy'

export function hashSql(sql: string): string {
  return createHash('sha256')
    .update(String(sql ?? '').replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex')
    .slice(0, 64)
}

export type MgrRunArtifactRow = {
  runId: string
  sessionId?: string | null
  question?: string | null
  toolChain: string[]
  subArtifacts: Record<string, FeedbackArtifact>
  federationPayload: Record<string, unknown>
  status: ArtifactStatus
  feedbackScore?: number | null
}

export async function upsertMgrRunArtifact(
  input: Omit<MgrRunArtifactRow, 'status' | 'feedbackScore'> & {
    status?: ArtifactStatus
    feedbackScore?: number | null
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const runId = String(input.runId || '').slice(0, 80)
  if (!runId) return false
  const res = await agentPgQuery(
    `INSERT INTO mgr_run_artifacts
       (run_id, session_id, question, tool_chain, sub_artifacts, federation_payload, status, feedback_score, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, NOW())
     ON CONFLICT (run_id) DO UPDATE SET
       session_id = COALESCE(EXCLUDED.session_id, mgr_run_artifacts.session_id),
       question = COALESCE(EXCLUDED.question, mgr_run_artifacts.question),
       tool_chain = CASE WHEN EXCLUDED.tool_chain = '[]'::jsonb THEN mgr_run_artifacts.tool_chain ELSE EXCLUDED.tool_chain END,
       sub_artifacts = CASE WHEN EXCLUDED.sub_artifacts = '{}'::jsonb THEN mgr_run_artifacts.sub_artifacts ELSE EXCLUDED.sub_artifacts END,
       federation_payload = CASE WHEN EXCLUDED.federation_payload = '{}'::jsonb THEN mgr_run_artifacts.federation_payload ELSE EXCLUDED.federation_payload END,
       status = EXCLUDED.status,
       feedback_score = COALESCE(EXCLUDED.feedback_score, mgr_run_artifacts.feedback_score),
       updated_at = NOW()`,
    [
      runId,
      input.sessionId ? String(input.sessionId).slice(0, 120) : null,
      input.question ? String(input.question).slice(0, 4000) : null,
      JSON.stringify(input.toolChain ?? []),
      JSON.stringify(input.subArtifacts ?? {}),
      JSON.stringify(input.federationPayload ?? {}),
      input.status ?? 'shadow',
      input.feedbackScore ?? null
    ],
    env
  )
  return Boolean(res)
}

/** Wave 8c：显式保存 / 👍 后标记联邦 shadow 来源（仅 metadata，不改 cap） */
export async function tagMgrRunArtifactCaptureSource(
  runId: string,
  captureSource: 'explicit_user_request' | 'explicit_feedback',
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const rid = String(runId || '').slice(0, 80)
  if (!rid) return false
  const res = await agentPgQuery(
    `UPDATE mgr_run_artifacts
     SET federation_payload = COALESCE(federation_payload, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE run_id = $1`,
    [rid, JSON.stringify({ captureSource })],
    env
  )
  return (res?.rowCount ?? 0) > 0
}

export async function getMgrRunArtifact(
  runId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<MgrRunArtifactRow | null> {
  if (!isAgentPgConfigured(env)) return null
  const rid = String(runId || '').slice(0, 80)
  if (!rid) return null
  const res = await agentPgQuery<{
    run_id: string
    session_id: string | null
    question: string | null
    tool_chain: unknown
    sub_artifacts: unknown
    federation_payload: unknown
    status: ArtifactStatus
    feedback_score: number | null
  }>(
    `SELECT run_id, session_id, question, tool_chain, sub_artifacts, federation_payload, status, feedback_score
     FROM mgr_run_artifacts WHERE run_id = $1 LIMIT 1`,
    [rid],
    env
  )
  const row = res?.rows?.[0]
  if (!row) return null
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    question: row.question,
    toolChain: Array.isArray(row.tool_chain) ? row.tool_chain.map(String) : [],
    subArtifacts: (row.sub_artifacts && typeof row.sub_artifacts === 'object' ? row.sub_artifacts : {}) as Record<
      string,
      FeedbackArtifact
    >,
    federationPayload: (row.federation_payload && typeof row.federation_payload === 'object'
      ? row.federation_payload
      : {}) as Record<string, unknown>,
    status: row.status,
    feedbackScore: row.feedback_score
  }
}

export async function setMgrRunArtifactStatus(
  runId: string,
  status: ArtifactStatus,
  feedbackScore?: number | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const rid = String(runId || '').slice(0, 80)
  if (!rid) return false
  const res = await agentPgQuery(
    `UPDATE mgr_run_artifacts SET status = $2, feedback_score = COALESCE($3, feedback_score), updated_at = NOW()
     WHERE run_id = $1`,
    [rid, status, feedbackScore ?? null],
    env
  )
  return (res?.rowCount ?? 0) > 0
}

export async function upsertDbQueryTemplateShadow(
  input: {
    id: string
    questionNorm: string
    sql: string
    dataDomain?: string
    tables?: string[]
    runId?: string
    hits?: number
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const sql = String(input.sql || '').trim()
  if (!sql) return false
  const sqlHash = hashSql(sql)
  const res = await agentPgQuery(
    `INSERT INTO db_query_templates
       (id, ts, question_norm, data_domain, tables, sql, sql_hash, hits, status, run_id, updated_at)
     VALUES ($1, NOW(), $2, $3, $4::jsonb, $5, $6, $7, 'shadow', $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       hits = db_query_templates.hits + 1,
       sql = EXCLUDED.sql,
       sql_hash = EXCLUDED.sql_hash,
       tables = EXCLUDED.tables,
       run_id = COALESCE(EXCLUDED.run_id, db_query_templates.run_id),
       updated_at = NOW()
     WHERE db_query_templates.status != 'revoked'`,
    [
      String(input.id).slice(0, 80),
      String(input.questionNorm).slice(0, 120),
      input.dataDomain ? String(input.dataDomain).slice(0, 64) : null,
      JSON.stringify(input.tables ?? []),
      sql,
      sqlHash,
      Math.max(1, Number(input.hits ?? 1) || 1),
      input.runId ? String(input.runId).slice(0, 80) : null
    ],
    env
  )
  return Boolean(res)
}

export async function setDbTemplateStatus(
  opts: { runId?: string; sqlHash?: string; questionNorm?: string },
  status: ArtifactStatus,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (!isAgentPgConfigured(env)) return 0
  if (opts.runId) {
    const res = await agentPgQuery(
      `UPDATE db_query_templates SET status = $2, updated_at = NOW()
       WHERE run_id = $1 AND ($2 = 'revoked' OR status != 'revoked')`,
      [String(opts.runId).slice(0, 80), status],
      env
    )
    if ((res?.rowCount ?? 0) > 0) return res!.rowCount!
  }
  if (opts.sqlHash) {
    const res = await agentPgQuery(
      `UPDATE db_query_templates SET status = $2, updated_at = NOW() WHERE sql_hash = $1`,
      [String(opts.sqlHash).slice(0, 64), status],
      env
    )
    return res?.rowCount ?? 0
  }
  if (opts.questionNorm) {
    const res = await agentPgQuery(
      `UPDATE db_query_templates SET status = $2, updated_at = NOW() WHERE question_norm = $1`,
      [String(opts.questionNorm).slice(0, 120), status],
      env
    )
    return res?.rowCount ?? 0
  }
  return 0
}

export async function isDbSqlHashRevoked(sqlHash: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const res = await agentPgQuery<{ status: string }>(
    `SELECT status FROM db_query_templates WHERE sql_hash = $1 AND status = 'revoked' LIMIT 1`,
    [String(sqlHash).slice(0, 64)],
    env
  )
  return Boolean(res?.rows?.length)
}

export async function upsertRagRetrievalArtifactShadow(
  input: {
    runId?: string
    questionNorm: string
    sourceLabels?: string[]
    chunkIds?: string[]
    path?: string
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const res = await agentPgQuery(
    `INSERT INTO rag_retrieval_artifacts
       (run_id, question_norm, source_labels, chunk_ids, path, status, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'shadow', NOW())`,
    [
      input.runId ? String(input.runId).slice(0, 80) : null,
      String(input.questionNorm).slice(0, 120),
      JSON.stringify(input.sourceLabels ?? []),
      JSON.stringify(input.chunkIds ?? []),
      input.path ? String(input.path).slice(0, 64) : null
    ],
    env
  )
  return Boolean(res)
}

export async function setRagArtifactStatus(
  opts: { runId?: string; questionNorm?: string },
  status: ArtifactStatus,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (!isAgentPgConfigured(env)) return 0
  if (opts.runId) {
    const res = await agentPgQuery(
      `UPDATE rag_retrieval_artifacts SET status = $2, updated_at = NOW() WHERE run_id = $1`,
      [String(opts.runId).slice(0, 80), status],
      env
    )
    return res?.rowCount ?? 0
  }
  if (opts.questionNorm) {
    const res = await agentPgQuery(
      `UPDATE rag_retrieval_artifacts SET status = $2, updated_at = NOW()
       WHERE question_norm = $1 AND id = (
         SELECT id FROM rag_retrieval_artifacts WHERE question_norm = $1 ORDER BY id DESC LIMIT 1
       )`,
      [String(opts.questionNorm).slice(0, 120), status],
      env
    )
    return res?.rowCount ?? 0
  }
  return 0
}

export async function loadRagArtifactPrefs(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ confirmedSources: Set<string>; revokedSources: Set<string>; confirmedChunks: Set<string> }> {
  const empty = { confirmedSources: new Set<string>(), revokedSources: new Set<string>(), confirmedChunks: new Set<string>() }
  if (!isAgentPgConfigured(env)) return empty
  const res = await agentPgQuery<{ source_labels: unknown; chunk_ids: unknown; status: string }>(
    `SELECT source_labels, chunk_ids, status FROM rag_retrieval_artifacts
     WHERE status IN ('confirmed', 'revoked') ORDER BY id DESC LIMIT 400`,
    [],
    env
  )
  const confirmedSources = new Set<string>()
  const revokedSources = new Set<string>()
  const confirmedChunks = new Set<string>()
  for (const row of res?.rows ?? []) {
    const labels = Array.isArray(row.source_labels) ? row.source_labels.map(String) : []
    const chunks = Array.isArray(row.chunk_ids) ? row.chunk_ids.map(String) : []
    if (row.status === 'confirmed') {
      for (const l of labels) if (l) confirmedSources.add(l)
      for (const c of chunks) if (c) confirmedChunks.add(c)
    } else if (row.status === 'revoked') {
      for (const l of labels) if (l) revokedSources.add(l)
    }
  }
  return { confirmedSources, revokedSources, confirmedChunks }
}

export async function upsertAdminToolExperienceShadow(
  input: {
    questionNorm: string
    toolName?: string
    scenario?: string
    hint: string
    runId?: string
    tools?: string[]
    source?: string
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const res = await agentPgQuery(
    `INSERT INTO adm_tool_experience (ts, question_norm, tool_name, scenario, hint, source, status, run_id, tools_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'shadow', $7, $8::jsonb)`,
    [
      new Date().toISOString(),
      String(input.questionNorm).slice(0, 120),
      input.toolName ? String(input.toolName).slice(0, 64) : null,
      input.scenario ? String(input.scenario).slice(0, 64) : null,
      String(input.hint).slice(0, 2000),
      String(input.source || 'manager_finalize_sync').slice(0, 32),
      input.runId ? String(input.runId).slice(0, 80) : null,
      JSON.stringify(input.tools ?? [])
    ],
    env
  )
  return Boolean(res)
}

export async function setAdminToolExperienceStatus(
  opts: { runId?: string; questionNorm?: string },
  status: ArtifactStatus,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (!isAgentPgConfigured(env)) return 0
  if (opts.runId) {
    const res = await agentPgQuery(
      `UPDATE adm_tool_experience SET status = $2 WHERE run_id = $1`,
      [String(opts.runId).slice(0, 80), status],
      env
    )
    return res?.rowCount ?? 0
  }
  if (opts.questionNorm) {
    const res = await agentPgQuery(
      `UPDATE adm_tool_experience SET status = $2
       WHERE question_norm = $1 AND id = (
         SELECT id FROM adm_tool_experience WHERE question_norm = $1 ORDER BY id DESC LIMIT 1
       )`,
      [String(opts.questionNorm).slice(0, 120), status],
      env
    )
    return res?.rowCount ?? 0
  }
  return 0
}

export async function confirmAdminToolExperienceForFederation(
  runId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (!isAgentPgConfigured(env)) return 0
  const res = await agentPgQuery(
    `UPDATE adm_tool_experience SET status = 'confirmed', source = 'feedback_confirmed'
     WHERE run_id = $1 AND status = 'shadow'`,
    [String(runId).slice(0, 80)],
    env
  )
  return res?.rowCount ?? 0
}
