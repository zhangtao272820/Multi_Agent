/**
 * 集群运行时「Agent 形态」日志：每一轮协同的形状快照（谁被派、DAG、taskForm、证据门）。
 * 与 metrics.jsonl（耗时）/ tool_call_audit（工具）/ Langfuse（LLM trace）互补，不替代。
 *
 * 双写：.data/agent-morphology.jsonl 始终可查；PG 配置时 upsert mgr_agent_morphology。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import { redactForPersistence, redactSecrets, truncateText } from './redact'
import { normalizeTenantId } from './tenantScope'
import { maxBlastRadius, resolveBlastRadius, type BlastRadius } from './blastRadius.ts'

export const AGENT_MORPHOLOGY_VERSION = 1 as const

export type AgentMorphologyKind = 'planned' | 'final'

export type AgentMorphologyPlanStep = {
  id?: string
  agent: string
  queryFocusPreview?: string
  dependsOn?: string[]
  parallelGroup?: string
  taskForm?: string
  blast_radius?: BlastRadius
}

export type AgentMorphologyClause = {
  layer?: string
  agents?: string[]
  taskForm?: string
  textPreview?: string
}

export type AgentMorphologyExpert = {
  agent: string
  ok?: boolean
  error_code?: string
  status?: string
}

export type AgentMorphologyRecord = {
  v: typeof AGENT_MORPHOLOGY_VERSION
  kind: AgentMorphologyKind
  run_id: string
  trace_id: string
  session_id?: string
  tenant_id?: string
  ts: string
  intent?: string
  taskIntent?: string
  taskForm?: string
  sourceCommitment?: string
  committedPlanes?: string[]
  webFetchKind?: string
  turnKind?: string
  turnScopeMode?: string
  allowedAgents: string[]
  suggestedAgents?: string[]
  isMulti?: boolean
  clauses?: AgentMorphologyClause[]
  plan: AgentMorphologyPlanStep[]
  probe?: {
    db?: { pingOk?: boolean; matched?: boolean; tableCount?: number }
    rag?: { hasDocs?: boolean; hits?: number }
  }
  experts?: AgentMorphologyExpert[]
  evidenceGate?: { pass?: boolean; reason?: string }
  critic?: { verdict?: string }
  flags?: {
    needsClarify?: boolean
    needsHumanConfirm?: boolean
  }
  outcome?: 'completed' | 'failed' | 'needs_human' | 'clarify' | 'chitchat'
  /** E1：本轮计划步的最大爆炸半径 */
  blast_radius?: BlastRadius
}

function preview(text: unknown, max = 80): string | undefined {
  const s = redactSecrets(truncateText(String(text ?? '').trim(), max))
  return s || undefined
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x || '').trim()).filter(Boolean)
}

export function isAgentMorphologyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.MANAGER_AGENT_MORPHOLOGY ?? '1').trim().toLowerCase()
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no')
}

export function agentMorphologyJsonlPath(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const custom = String(env.MANAGER_MORPHOLOGY_LOG_PATH || '').trim()
  if (custom) return custom
  return path.join(cwd, '.data', 'agent-morphology.jsonl')
}

export function inferMorphologyOutcome(input: {
  kind: AgentMorphologyKind
  needsClarify?: boolean
  needsHumanConfirm?: boolean
  evidenceGatePass?: boolean
  experts?: AgentMorphologyExpert[]
  turnScopeMode?: string
  intent?: string
}): AgentMorphologyRecord['outcome'] {
  if (input.kind === 'planned') {
    if (input.needsClarify) return 'clarify'
    if (input.turnScopeMode === 'chitchat' || input.intent === 'chat') return 'chitchat'
    return undefined
  }
  if (input.needsClarify) return 'clarify'
  if (input.needsHumanConfirm) return 'needs_human'
  if (input.evidenceGatePass === false) return 'failed'
  const failed = (input.experts || []).some((e) => e.ok === false || e.status === 'error' || e.status === 'failed')
  if (failed) return 'failed'
  return 'completed'
}

/** 从 Manager graph state（或同形对象）抽出形态；不写入。 */
export function buildAgentMorphologyFromState(
  state: Record<string, unknown>,
  opts: {
    kind: AgentMorphologyKind
    runId: string
    sessionId?: string | null
    tenantId?: string | null
    ts?: string
  }
): AgentMorphologyRecord | null {
  const runId = String(opts.runId || '').trim()
  if (!runId) return null
  const meta = (state.meta && typeof state.meta === 'object' ? state.meta : {}) as Record<string, unknown>
  const chain =
    meta.routeAuthorityChain && typeof meta.routeAuthorityChain === 'object'
      ? (meta.routeAuthorityChain as Record<string, unknown>)
      : {}
  const raw =
    meta.orchestratorRaw && typeof meta.orchestratorRaw === 'object'
      ? (meta.orchestratorRaw as Record<string, unknown>)
      : meta

  const allowedAgents = strList(state.allowedAgents).length
    ? strList(state.allowedAgents)
    : strList(chain.allowedAgents)

  const planSrc = Array.isArray((state.taskPlan as { steps?: unknown[] } | undefined)?.steps)
    ? ((state.taskPlan as { steps: unknown[] }).steps as unknown[])
    : Array.isArray(state.plan)
      ? (state.plan as unknown[])
      : Array.isArray((raw.planBlueprint as { steps?: unknown[] } | undefined)?.steps)
        ? (((raw.planBlueprint as { steps: unknown[] }).steps) as unknown[])
        : []

  const plan: AgentMorphologyPlanStep[] = planSrc.slice(0, 16).map((s, i) => {
    const row = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
    const agent = String(row.agent || '').trim()
    const depends = strList(row.dependsOn ?? row.dependsOnAgents)
    const step: AgentMorphologyPlanStep = {
      id: String(row.id || `step_${i + 1}`).slice(0, 40),
      agent: agent || 'unknown'
    }
    const qf = preview(row.queryFocus ?? row.query, 80)
    if (qf) step.queryFocusPreview = qf
    if (depends.length) step.dependsOn = depends.slice(0, 8)
    const pg = String(row.parallelGroup || '').trim()
    if (pg) step.parallelGroup = pg.slice(0, 32)
    const tf = String(row.taskForm || '').trim()
    if (tf) step.taskForm = tf.slice(0, 40)
    const actionKind =
      agent === 'admin' ? 'admin_write' : agent === 'gui' ? 'gui_write' : agent === 'code' ? 'code_edit' : 'readonly'
    step.blast_radius = resolveBlastRadius({ agent, actionKind })
    return step
  })

  const clauseSrc = Array.isArray(raw.clauses)
    ? (raw.clauses as unknown[])
    : Array.isArray(meta.clauses)
      ? (meta.clauses as unknown[])
      : []
  const clauses: AgentMorphologyClause[] = clauseSrc.slice(0, 12).map((c) => {
    const row = c && typeof c === 'object' ? (c as Record<string, unknown>) : {}
    const out: AgentMorphologyClause = {}
    const layer = String(row.layer || '').trim()
    if (layer) out.layer = layer.slice(0, 24)
    const agents = strList(row.agents)
    if (agents.length) out.agents = agents.slice(0, 8)
    const tf = String(row.taskForm || '').trim()
    if (tf) out.taskForm = tf.slice(0, 40)
    const tp = preview(row.text, 60)
    if (tp) out.textPreview = tp
    return out
  })

  const probe = state.probe && typeof state.probe === 'object' ? (state.probe as Record<string, unknown>) : {}
  const dbP = probe.db && typeof probe.db === 'object' ? (probe.db as Record<string, unknown>) : null
  const ragP = probe.rag && typeof probe.rag === 'object' ? (probe.rag as Record<string, unknown>) : null

  const stepRecords = Array.isArray(meta.lastStepRecords)
    ? (meta.lastStepRecords as unknown[])
    : Array.isArray(meta.stepRecords)
      ? (meta.stepRecords as unknown[])
      : []
  const expertsFromSteps: AgentMorphologyExpert[] = stepRecords.slice(0, 16).map((s) => {
    const row = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
    const expert: AgentMorphologyExpert = { agent: String(row.agent || 'unknown').slice(0, 24) }
    const status = String(row.status || '').trim()
    if (status) expert.status = status.slice(0, 32)
    if (status === 'error' || status === 'failed') expert.ok = false
    else if (status === 'ok' || status === 'success' || status === 'done') expert.ok = true
    const err = String(row.error_code || '').trim()
    if (err) expert.error_code = err.slice(0, 40)
    return expert
  })

  const evidence = Array.isArray(state.evidence) ? (state.evidence as unknown[]) : []
  const expertsFromEvidence: AgentMorphologyExpert[] = []
  for (const e of evidence.slice(0, 16)) {
    const ev = e && typeof e === 'object' ? (e as Record<string, unknown>) : {}
    const ar = ev.agentResult && typeof ev.agentResult === 'object' ? (ev.agentResult as Record<string, unknown>) : null
    const agent = String(ar?.agent || ev.kind || '').trim()
    if (!agent) continue
    if (expertsFromSteps.some((x) => x.agent === agent) || expertsFromEvidence.some((x) => x.agent === agent)) continue
    const expert: AgentMorphologyExpert = { agent: agent.slice(0, 24) }
    if (typeof ar?.ok === 'boolean') expert.ok = ar.ok
    const code = String(ar?.error_code || '').trim()
    if (code) expert.error_code = code.slice(0, 40)
    expertsFromEvidence.push(expert)
  }

  const experts = expertsFromSteps.length ? expertsFromSteps : expertsFromEvidence
  const needsClarify = Boolean(meta.needsClarify)
  const needsHumanConfirm = Boolean(meta.needsHumanConfirm || meta.needs_human_confirm)
  const eg = meta.evidenceGate && typeof meta.evidenceGate === 'object' ? (meta.evidenceGate as Record<string, unknown>) : null
  const critic = meta.criticVerdict && typeof meta.criticVerdict === 'object'
    ? (meta.criticVerdict as Record<string, unknown>)
    : typeof meta.critic === 'string'
      ? { verdict: meta.critic }
      : null

  const taskIntent = String(raw.taskIntent ?? meta.taskIntent ?? '').trim()
  const taskForm = String(raw.taskForm ?? meta.taskForm ?? '').trim()
  const sourceCommitment = String(chain.sourceCommitment ?? raw.sourceCommitment ?? '').trim()
  const turnScopeMode = String(chain.turnScopeMode ?? meta.turnScopeMode ?? '').trim()
  const turnKind = String(chain.turnKind ?? meta.turnKind ?? '').trim()
  const intent = String(state.intent || '').trim()

  const record: AgentMorphologyRecord = {
    v: AGENT_MORPHOLOGY_VERSION,
    kind: opts.kind,
    run_id: runId.slice(0, 80),
    trace_id: String(meta.trace_id || opts.runId).slice(0, 80),
    ts: opts.ts || new Date().toISOString(),
    allowedAgents: allowedAgents.slice(0, 16),
    plan
  }
  if (opts.sessionId) record.session_id = String(opts.sessionId).slice(0, 120)
  if (opts.tenantId) record.tenant_id = normalizeTenantId(opts.tenantId)
  if (intent) record.intent = intent.slice(0, 32)
  if (taskIntent) record.taskIntent = taskIntent.slice(0, 40)
  if (taskForm) record.taskForm = taskForm.slice(0, 40)
  if (sourceCommitment) record.sourceCommitment = sourceCommitment.slice(0, 24)
  const planes = strList(chain.committedPlanes ?? raw.committedPlanes)
  if (planes.length) record.committedPlanes = planes.slice(0, 8)
  const web = String(chain.webFetchKind ?? raw.webFetchKind ?? '').trim()
  if (web) record.webFetchKind = web.slice(0, 24)
  if (turnKind) record.turnKind = turnKind.slice(0, 24)
  if (turnScopeMode) record.turnScopeMode = turnScopeMode.slice(0, 24)
  const suggested = strList(raw.suggestedAgents)
  if (suggested.length) record.suggestedAgents = suggested.slice(0, 12)
  if (typeof raw.isMulti === 'boolean') record.isMulti = raw.isMulti
  else if (plan.length > 1 || allowedAgents.length > 1) record.isMulti = true
  if (clauses.some((c) => Object.keys(c).length)) record.clauses = clauses

  if (dbP || ragP) {
    record.probe = {}
    if (dbP) {
      record.probe.db = {
        pingOk: dbP.pingOk === true || dbP.ping_ok === true,
        matched: dbP.matched === true,
        tableCount: Array.isArray(dbP.tables) ? dbP.tables.length : Array.isArray(dbP.businessTables) ? dbP.businessTables.length : undefined
      }
    }
    if (ragP) {
      record.probe.rag = {
        hasDocs: ragP.hasDocs === true || ragP.has_docs === true,
        hits: typeof ragP.hits === 'number' ? ragP.hits : undefined
      }
    }
  }

  if (experts.length) record.experts = experts
  if (eg && typeof eg.pass === 'boolean') {
    record.evidenceGate = {
      pass: eg.pass,
      reason: preview(eg.reason, 120)
    }
  }
  const verdict = String(critic?.verdict || critic?.decision || '').trim()
  if (verdict) record.critic = { verdict: verdict.slice(0, 32) }
  if (needsClarify || needsHumanConfirm) {
    record.flags = {
      ...(needsClarify ? { needsClarify: true } : {}),
      ...(needsHumanConfirm ? { needsHumanConfirm: true } : {})
    }
  }
  const outcome = inferMorphologyOutcome({
    kind: opts.kind,
    needsClarify,
    needsHumanConfirm,
    evidenceGatePass: typeof eg?.pass === 'boolean' ? eg.pass : undefined,
    experts,
    turnScopeMode,
    intent
  })
  if (outcome) record.outcome = outcome
  if (plan.length) {
    record.blast_radius = plan.reduce<BlastRadius>(
      (acc, s) => maxBlastRadius(acc, s.blast_radius || 't0'),
      't0'
    )
  }
  return record
}

export function morphologyLogFields(record: AgentMorphologyRecord): Record<string, string | number | boolean> {
  return {
    msg: `manager.morphology.${record.kind}`,
    agent: 'manager',
    run_id: record.run_id,
    trace_id: record.trace_id,
    kind: record.kind,
    intent: record.intent || '',
    taskForm: record.taskForm || '',
    taskIntent: record.taskIntent || '',
    agents: record.allowedAgents.join(','),
    steps: record.plan.length,
    outcome: record.outcome || '',
    blast_radius: record.blast_radius || '',
    isMulti: Boolean(record.isMulti)
  }
}

async function appendJsonl(record: AgentMorphologyRecord, env: NodeJS.ProcessEnv): Promise<void> {
  const file = agentMorphologyJsonlPath(process.cwd(), env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const payload = redactForPersistence(record, { maxFieldChars: 240 }) as AgentMorphologyRecord
  await fs.appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8')
}

async function upsertPg(record: AgentMorphologyRecord, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!isAgentPgConfigured(env)) return false
  const payload = redactForPersistence(record, { maxFieldChars: 240 })
  const res = await agentPgQuery(
    `INSERT INTO mgr_agent_morphology (run_id, session_id, tenant_id, kind, payload, ts)
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, NOW()))
     ON CONFLICT (run_id, kind) DO UPDATE SET
       session_id = COALESCE(EXCLUDED.session_id, mgr_agent_morphology.session_id),
       payload = EXCLUDED.payload,
       ts = EXCLUDED.ts`,
    [
      record.run_id,
      record.session_id ?? null,
      normalizeTenantId(record.tenant_id, env),
      record.kind,
      JSON.stringify(payload),
      record.ts
    ],
    env
  )
  return Boolean(res)
}

export async function recordAgentMorphology(
  record: AgentMorphologyRecord,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isAgentMorphologyEnabled(env)) return false
  if (!record.run_id || !record.kind) return false
  try {
    await appendJsonl(record, env)
  } catch {
    /* jsonl 失败不阻断 */
  }
  try {
    await upsertPg(record, env)
  } catch {
    /* PG 可选 */
  }
  return true
}

function parseJsonlLine(line: string): AgentMorphologyRecord | null {
  try {
    const row = JSON.parse(line) as AgentMorphologyRecord
    if (!row || row.v !== 1 || !row.run_id || !row.kind) return null
    return row
  } catch {
    return null
  }
}

export async function listAgentMorphology(opts?: {
  limit?: number
  runId?: string
  kind?: AgentMorphologyKind
  cwd?: string
}): Promise<AgentMorphologyRecord[]> {
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 40))
  const file = agentMorphologyJsonlPath(opts?.cwd || process.cwd())
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const rows: AgentMorphologyRecord[] = []
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0 && rows.length < limit * 3; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    const row = parseJsonlLine(line)
    if (!row) continue
    if (opts?.runId && row.run_id !== opts.runId) continue
    if (opts?.kind && row.kind !== opts.kind) continue
    rows.push(row)
  }
  return rows.slice(0, limit)
}

export async function getAgentMorphologyForRun(
  runId: string,
  opts?: { cwd?: string }
): Promise<AgentMorphologyRecord[]> {
  const rid = String(runId || '').trim()
  if (!rid) return []
  return listAgentMorphology({ limit: 8, runId: rid, cwd: opts?.cwd })
}
