/**
 * P1 Phase14：Process/SOP 记忆 — 成功 multi-agent 路径可召回（租户隔离）
 */
import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import { normalizeDbQuestionKey } from './dbExperienceBridge'
import { requireTenantId, ScopeRequiredError } from './tenantScope'

export type ProcessMemoryRow = {
  id: number
  tenantId: string
  scenarioKey: string
  questionNorm: string
  toolChain: string[]
  hint: string
  successScore: number
  hits: number
}

export function isProcessMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_PROCESS_MEMORY ?? '1').trim() !== '0'
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeDbQuestionKey(a).match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g) ?? [])
  const tb = new Set(normalizeDbQuestionKey(b).match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g) ?? [])
  if (!ta.size || !tb.size) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++
  return hit / Math.max(ta.size, tb.size)
}

function resolveProcessTenantId(raw: unknown, env: NodeJS.ProcessEnv): string | null {
  try {
    return requireTenantId(raw, env)
  } catch (e) {
    if (e instanceof ScopeRequiredError) return null
    throw e
  }
}

export async function upsertProcessMemory(
  input: {
    tenantId?: string
    scenarioKey?: string
    question: string
    toolChain: string[]
    hint: string
    successScore?: number
    source?: string
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isProcessMemoryEnabled(env) || !isAgentPgConfigured(env)) return false
  const tenantId = resolveProcessTenantId(input.tenantId, env)
  if (!tenantId) return false
  const questionNorm = normalizeDbQuestionKey(input.question)
  if (!questionNorm || !input.toolChain?.length) return false
  const scenarioKey = String(input.scenarioKey || '__global__').slice(0, 128)
  const hint = String(input.hint || '').slice(0, 2000)
  const score = Number(input.successScore ?? 0.8)
  const res = await agentPgQuery(
    `INSERT INTO mgr_process_memory
       (tenant_id, scenario_key, question_norm, tool_chain, hint, success_score, hits, source, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 1, $7, NOW())
     ON CONFLICT (tenant_id, scenario_key, question_norm) DO UPDATE SET
       tool_chain = EXCLUDED.tool_chain,
       hint = EXCLUDED.hint,
       success_score = GREATEST(mgr_process_memory.success_score, EXCLUDED.success_score),
       hits = mgr_process_memory.hits + 1,
       updated_at = NOW()`,
    [
      tenantId,
      scenarioKey,
      questionNorm,
      JSON.stringify(input.toolChain.map((a) => String(a).slice(0, 32))),
      hint,
      Number.isFinite(score) ? score : 0.8,
      String(input.source || 'manager_finalize').slice(0, 32)
    ],
    env
  )
  return Boolean(res)
}

export async function recallProcessMemory(
  question: string,
  opts?: { tenantId?: string; scenarioKey?: string; limit?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<ProcessMemoryRow[]> {
  if (!isProcessMemoryEnabled(env) || !isAgentPgConfigured(env)) return []
  const tenantId = resolveProcessTenantId(opts?.tenantId, env)
  if (!tenantId) return []
  const limit = Math.max(1, Math.min(8, opts?.limit ?? 3))
  const scenarioKey = opts?.scenarioKey ? String(opts.scenarioKey).slice(0, 128) : null
  const res = await agentPgQuery<{
    id: number
    tenant_id: string
    scenario_key: string
    question_norm: string
    tool_chain: unknown
    hint: string
    success_score: number
    hits: number
  }>(
    scenarioKey
      ? `SELECT id, tenant_id, scenario_key, question_norm, tool_chain, hint, success_score, hits
         FROM mgr_process_memory
         WHERE status = 'active' AND tenant_id = $1 AND scenario_key = $2
         ORDER BY hits DESC, success_score DESC LIMIT 40`
      : `SELECT id, tenant_id, scenario_key, question_norm, tool_chain, hint, success_score, hits
         FROM mgr_process_memory
         WHERE status = 'active' AND tenant_id = $1
         ORDER BY hits DESC, success_score DESC LIMIT 80`,
    scenarioKey ? [tenantId, scenarioKey] : [tenantId],
    env
  )
  const rows = (res?.rows ?? []).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    scenarioKey: r.scenario_key,
    questionNorm: r.question_norm,
    toolChain: Array.isArray(r.tool_chain) ? r.tool_chain.map(String) : [],
    hint: r.hint,
    successScore: r.success_score,
    hits: r.hits
  }))
  const scored = rows
    .map((r) => ({ r, s: tokenOverlap(question, r.questionNorm) }))
    .filter((x) => x.s >= 0.28)
    .sort((a, b) => b.s - a.s || b.r.hits - a.r.hits)
  return scored.slice(0, limit).map((x) => x.r)
}

export function formatProcessMemoryBlock(rows: ProcessMemoryRow[]): string {
  if (!rows.length) return ''
  const lines = ['### 流程记忆（历史成功 multi-agent 路径参考；与本轮用户意图冲突时以本轮为准）']
  for (const r of rows.slice(0, 4)) {
    lines.push(`- 路径=${r.toolChain.join('→')}；命中=${r.hits}；${r.hint.slice(0, 160)}`)
  }
  return lines.join('\n')
}
