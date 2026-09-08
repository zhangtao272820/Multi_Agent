/**
 * P0：反馈门控 — confirm / revoke 编排（总管 + DB/RAG/Admin 联邦）
 */
import {
  isAdminToolExperienceFeedbackGated,
  isDbTemplateFeedbackGated,
  isDbTemplateRevokeOnDislike,
  isFederationFeedbackGated,
  normalizeArtifact,
  type FeedbackArtifact
} from './artifactFeedbackPolicy'
import {
  confirmAdminToolExperienceForFederation,
  getMgrRunArtifact,
  setAdminToolExperienceStatus,
  setDbTemplateStatus,
  setMgrRunArtifactStatus,
  setRagArtifactStatus,
  upsertAdminToolExperienceShadow,
  upsertDbQueryTemplateShadow,
  upsertMgrRunArtifact,
  upsertRagRetrievalArtifactShadow,
  hashSql
} from './artifactStore'
import { syncDbExperienceFromManagerRun } from './dbExperienceBridge'
import { syncRagExperienceFromManagerRun } from './ragExperienceBridge'
import { syncAdminExperienceFromManagerRun } from './adminExperienceBridge'
import { syncCodeExperienceFromManagerRun } from './codeExperienceBridge'
import { syncCrawlerExperienceFromManagerRun } from './crawlerExperienceBridge'
import { syncGuiExperienceFromManagerRun } from './guiExperienceBridge'
import { recordToolMemoryEvent } from './toolMemoryStore'
import type { RunOutcomeInput } from './agentOutcomePolicy'
import { normalizeDbQuestionKey } from './dbExperienceBridge'

export type ShadowArtifactInput = {
  runId: string
  sessionId?: string
  tenantId?: string
  question: string
  planAgents: string[]
  subArtifacts: Record<string, FeedbackArtifact>
  runOutcome: RunOutcomeInput & {
    question: string
    dataDomain?: string
    dbPath?: string
    dbSql?: string
    dbTables?: string[]
    ragPath?: string
    ragSources?: string[]
    scenarioKey?: string
    intent?: string
    adminTools?: string[]
    codeTaskKind?: string
    codeHintFiles?: string[]
    crawlerTargetSite?: string
    crawlerChannel?: string
    crawlerSeedUrl?: string
    guiScenario?: string
    guiExecutionMode?: string
  }
}

export async function saveShadowRunArtifacts(input: ShadowArtifactInput, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const questionNorm = normalizeDbQuestionKey(input.question)
  await upsertMgrRunArtifact(
    {
      runId: input.runId,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      question: input.question,
      toolChain: input.planAgents,
      subArtifacts: input.subArtifacts,
      federationPayload: input.runOutcome as unknown as Record<string, unknown>,
      status: 'shadow'
    },
    env
  )

  const gated = isFederationFeedbackGated(env)

  if (input.planAgents.map((a) => a.toLowerCase()).includes('db') && input.runOutcome.dbSql) {
    const tplId = `t_${input.runId.slice(0, 12)}_${hashSql(input.runOutcome.dbSql).slice(0, 8)}`
    await upsertDbQueryTemplateShadow(
      {
        id: tplId,
        questionNorm,
        sql: input.runOutcome.dbSql,
        dataDomain: input.runOutcome.dataDomain,
        tables: input.runOutcome.dbTables,
        runId: input.runId
      },
      env
    )
  }

  if (input.planAgents.map((a) => a.toLowerCase()).includes('rag')) {
    const ragArt = input.subArtifacts.rag
    await upsertRagRetrievalArtifactShadow(
      {
        runId: input.runId,
        questionNorm,
        sourceLabels: ragArt?.source_labels ?? input.runOutcome.ragSources,
        chunkIds: ragArt?.chunk_ids,
        path: input.runOutcome.ragPath
      },
      env
    )
  }

  if (input.planAgents.map((a) => a.toLowerCase()).includes('admin')) {
    const adminArt = input.subArtifacts.admin
    await upsertAdminToolExperienceShadow(
      {
        questionNorm,
        toolName: adminArt?.tools?.[0] || input.runOutcome.scenarioKey,
        scenario: input.runOutcome.scenarioKey,
        hint: `场景=${input.runOutcome.scenarioKey || 'general'}；工具=${(adminArt?.tools ?? []).join('→') || 'admin'}`,
        runId: input.runId,
        tools: adminArt?.tools ?? input.runOutcome.adminTools,
        source: gated ? 'manager_shadow' : 'manager_finalize_sync'
      },
      env
    )
  }
}

export async function promoteFederationFromRun(runId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ promoted: string[] }> {
  const row = await getMgrRunArtifact(runId, env)
  if (!row) return { promoted: [] }
  const payload = row.federationPayload as ShadowArtifactInput['runOutcome']
  if (!payload || !payload.planAgents?.length) return { promoted: [] }

  const promoted: string[] = []
  const outcome: RunOutcomeInput = {
    successScore: Number(payload.successScore ?? 0.85),
    needsClarify: Boolean(payload.needsClarify),
    failureCategory: payload.failureCategory,
    planAgents: payload.planAgents,
    results: (payload.results ?? {}) as Record<string, unknown>,
    probeDbMatched: payload.probeDbMatched,
    probeRagHits: payload.probeRagHits
  }

  if (outcome.planAgents.map((a) => a.toLowerCase()).includes('db')) {
    const r = await syncDbExperienceFromManagerRun(
      {
        ...outcome,
        question: String(payload.question || row.question || ''),
        dataDomain: payload.dataDomain,
        dbPath: payload.dbPath || 'sql_direct',
        tables: payload.dbTables
      },
      env,
      { force: true }
    )
    if (r.synced) promoted.push('db')
  }
  if (outcome.planAgents.map((a) => a.toLowerCase()).includes('rag')) {
    const r = await syncRagExperienceFromManagerRun(
      {
        ...outcome,
        question: String(payload.question || row.question || ''),
        ragPath: payload.ragPath || 'document_query',
        ragSources: payload.ragSources
      },
      env,
      { force: true }
    )
    if (r.synced) promoted.push('rag')
  }
  if (outcome.planAgents.map((a) => a.toLowerCase()).includes('admin')) {
    const r = await syncAdminExperienceFromManagerRun(
      {
        ...outcome,
        question: String(payload.question || row.question || ''),
        scenarioKey: payload.scenarioKey,
        intent: payload.intent
      },
      env,
      { force: true }
    )
    if (r.synced) promoted.push('admin')
    await confirmAdminToolExperienceForFederation(runId, env)
  }
  if (outcome.planAgents.map((a) => a.toLowerCase()).includes('code')) {
    const r = await syncCodeExperienceFromManagerRun(
      {
        ...outcome,
        question: String(payload.question || row.question || ''),
        taskKind: payload.codeTaskKind,
        hintFiles: payload.codeHintFiles
      },
      env,
      { force: true }
    )
    if (r.synced) promoted.push('code')
  }
  if (outcome.planAgents.map((a) => a.toLowerCase()).includes('crawler')) {
    const r = await syncCrawlerExperienceFromManagerRun(
      {
        ...outcome,
        question: String(payload.question || row.question || ''),
        targetSite: payload.crawlerTargetSite,
        channel: payload.crawlerChannel,
        seedUrl: payload.crawlerSeedUrl
      },
      env,
      { force: true }
    )
    if (r.synced) promoted.push('crawler')
  }
  if (outcome.planAgents.map((a) => a.toLowerCase()).includes('gui')) {
    const r = await syncGuiExperienceFromManagerRun(
      {
        ...outcome,
        question: String(payload.question || row.question || ''),
        scenario: payload.guiScenario,
        executionMode: payload.guiExecutionMode
      },
      env,
      { force: true }
    )
    if (r.synced) promoted.push('gui')
  }

  return { promoted }
}

export async function confirmRunArtifacts(
  runId: string,
  artifact?: FeedbackArtifact | null,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { tenantId?: string }
): Promise<{ ok: boolean; promoted: string[] }> {
  const row = await getMgrRunArtifact(runId, env)
  const art = normalizeArtifact(artifact)
  await setMgrRunArtifactStatus(runId, 'confirmed', 1, env)

  const sqlHash = art?.sql_hash ?? row?.subArtifacts?.db?.sql_hash
  if (sqlHash || runId) {
    await setDbTemplateStatus({ runId, sqlHash }, 'confirmed', env)
  }

  await setRagArtifactStatus({ runId }, 'confirmed', env)
  await setAdminToolExperienceStatus({ runId }, 'confirmed', env)

  const promoted = isFederationFeedbackGated(env) ? (await promoteFederationFromRun(runId, env)).promoted : []

  const chain = row?.toolChain ?? art?.tool_chain ?? []
  for (const agentName of chain) {
    await recordToolMemoryEvent(
      {
        tenantId: opts?.tenantId,
        agent: 'manager',
        toolName: agentName,
        contextKey: `feedback_confirmed:${runId.slice(0, 16)}`,
        ok: true,
        metadata: { feedbackConfirmed: true, runId }
      },
      env
    ).catch(() => undefined)
  }

  return { ok: true, promoted }
}

export async function revokeRunArtifacts(
  runId: string,
  artifact?: FeedbackArtifact | null,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { tenantId?: string }
): Promise<{ ok: boolean; revoked: string[] }> {
  const row = await getMgrRunArtifact(runId, env)
  const art = normalizeArtifact(artifact)
  await setMgrRunArtifactStatus(runId, 'revoked', 0, env)

  const revoked: string[] = []
  const sqlHash = art?.sql_hash ?? row?.subArtifacts?.db?.sql_hash

  if (isDbTemplateRevokeOnDislike(env)) {
    const n = await setDbTemplateStatus({ runId, sqlHash }, 'revoked', env)
    if (n > 0) revoked.push('db_sql')
  }

  const rn = await setRagArtifactStatus({ runId }, 'revoked', env)
  if (rn > 0) revoked.push('rag_retrieval')

  const an = await setAdminToolExperienceStatus({ runId }, 'revoked', env)
  if (an > 0) revoked.push('admin_tool')

  const chain = row?.toolChain ?? art?.tool_chain ?? []
  for (const agentName of chain) {
    await recordToolMemoryEvent(
      {
        tenantId: opts?.tenantId,
        agent: 'manager',
        toolName: agentName,
        contextKey: `feedback_revoked:${runId.slice(0, 16)}`,
        ok: false,
        error: 'user_dislike',
        metadata: { feedbackRevoked: true, runId }
      },
      env
    ).catch(() => undefined)
  }

  return { ok: true, revoked }
}

/** DB Agent 独立反馈：确认/吊销 SQL 模板 */
export async function handleDbAgentFeedback(
  input: {
    score: number
    question: string
    runId?: string | null
    artifact?: FeedbackArtifact | null
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ action: 'confirmed' | 'revoked' | 'skipped' }> {
  if (!isDbTemplateFeedbackGated(env) && input.score > 0) return { action: 'skipped' }
  const art = normalizeArtifact(input.artifact)
  const questionNorm = normalizeDbQuestionKey(input.question)
  if (input.score > 0) {
    await setDbTemplateStatus(
      { runId: input.runId ?? undefined, sqlHash: art?.sql_hash, questionNorm },
      'confirmed',
      env
    )
    if (input.runId && isFederationFeedbackGated(env)) {
      await promoteFederationFromRun(input.runId, env).catch(() => undefined)
    }
    return { action: 'confirmed' }
  }
  if (isDbTemplateRevokeOnDislike(env)) {
    await setDbTemplateStatus(
      { runId: input.runId ?? undefined, sqlHash: art?.sql_hash, questionNorm },
      'revoked',
      env
    )
    return { action: 'revoked' }
  }
  return { action: 'skipped' }
}

/** RAG Agent 独立反馈 */
export async function handleRagAgentFeedback(
  input: {
    score: number
    question: string
    runId?: string | null
    artifact?: FeedbackArtifact | null
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ action: 'confirmed' | 'revoked' | 'skipped' }> {
  const questionNorm = normalizeDbQuestionKey(input.question)
  if (input.score > 0) {
    await setRagArtifactStatus({ runId: input.runId ?? undefined, questionNorm }, 'confirmed', env)
    if (input.runId && isFederationFeedbackGated(env)) {
      await promoteFederationFromRun(input.runId, env).catch(() => undefined)
    }
    return { action: 'confirmed' }
  }
  await setRagArtifactStatus({ runId: input.runId ?? undefined, questionNorm }, 'revoked', env)
  return { action: 'revoked' }
}

/** Admin Agent 独立反馈 */
export async function handleAdminAgentFeedback(
  input: {
    score: number
    question: string
    runId?: string | null
    artifact?: FeedbackArtifact | null
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ action: 'confirmed' | 'revoked' | 'skipped' }> {
  const questionNorm = normalizeDbQuestionKey(input.question)
  if (input.score > 0) {
    if (isAdminToolExperienceFeedbackGated(env)) {
      await setAdminToolExperienceStatus({ runId: input.runId ?? undefined, questionNorm }, 'confirmed', env)
      if (input.runId) await confirmAdminToolExperienceForFederation(input.runId, env)
    }
    if (input.runId && isFederationFeedbackGated(env)) {
      await promoteFederationFromRun(input.runId, env).catch(() => undefined)
    }
    return { action: 'confirmed' }
  }
  await setAdminToolExperienceStatus({ runId: input.runId ?? undefined, questionNorm }, 'revoked', env)
  return { action: 'revoked' }
}

export async function dispatchArtifactRevokeToSubAgents(
  runId: string,
  artifact?: FeedbackArtifact | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ revoked: string[] }> {
  return revokeRunArtifacts(runId, artifact, env)
}
