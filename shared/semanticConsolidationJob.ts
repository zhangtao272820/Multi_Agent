/**
 * 语义升华：同 scenario 多条高分 experience → shadow semantic（须人审，禁止 silent 晋级）
 */

import { agentPgQuery } from './agentPgClient'
import { AMP_EXPERIENCE_SUCCESS_THRESHOLD } from './agentMemoryPolicy'
import { recordMemory } from './agentMemoryApi'

export function isSemanticConsolidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_SEMANTIC_CONSOLIDATION_JOB ?? '1').trim() !== '0'
}

function minClusterSize(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MGR_SEMANTIC_CONSOLIDATION_MIN_CLUSTER ?? 3)
  return Number.isFinite(n) && n >= 2 ? Math.min(10, Math.floor(n)) : 3
}

/** 同 scenario 意图过于分散则视为冲突，拒绝合并 */
function maxUniqueIntents(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MGR_SEMANTIC_CONSOLIDATION_MAX_UNIQUE_INTENTS ?? 3)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 3
}

type ExperienceRow = { payload: Record<string, unknown> }

function scenarioKey(payload: Record<string, unknown>): string {
  return String(payload.scenarioKey || payload.scenario_key || 'general').slice(0, 120)
}

function intentOf(payload: Record<string, unknown>): string {
  return String(payload.intent || payload.userSummary || payload.question || '').slice(0, 200)
}

function successScore(payload: Record<string, unknown>): number {
  const n = Number(payload.successScore ?? payload.success_score)
  return Number.isFinite(n) ? n : 0
}

/** 纯函数：集群是否可合并（供 smoke） */
export function evaluateSemanticClusterGate(
  cluster: ExperienceRow[],
  opts?: { minCluster?: number; maxUniqueIntents?: number; minAvgSuccess?: number }
): { ok: true; uniqueIntents: string[]; avgSuccess: number } | { ok: false; reason: string } {
  const minCluster = opts?.minCluster ?? 3
  const maxUnique = opts?.maxUniqueIntents ?? 3
  const minAvg = opts?.minAvgSuccess ?? AMP_EXPERIENCE_SUCCESS_THRESHOLD
  if (cluster.length < minCluster) {
    return { ok: false, reason: 'cluster_too_small' }
  }
  const scores = cluster.map((r) => successScore(r.payload))
  const avgSuccess = scores.reduce((a, b) => a + b, 0) / scores.length
  if (avgSuccess < minAvg) {
    return { ok: false, reason: 'avg_success_too_low' }
  }
  const intents = cluster.map((r) => intentOf(r.payload)).filter(Boolean)
  const uniqueIntents = [...new Set(intents)]
  if (uniqueIntents.length > maxUnique) {
    return { ok: false, reason: 'intent_conflict' }
  }
  // 两两意图字符重叠极低也视为冲突（避免 silently 拼无关路径）
  if (uniqueIntents.length >= 2) {
    const tokens = (s: string) => {
      const lower = s.toLowerCase()
      const words = lower.match(/[\p{L}\p{N}]{2,}/gu) || []
      const out = new Set(words.slice(0, 40))
      // CJK：补 2-gram，避免整句被当成一个 token 后零重叠
      const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
      for (let i = 0; i < Math.min(cjk.length - 1, 48); i++) {
        out.add(cjk.slice(i, i + 2))
      }
      return out
    }
    let lowOverlapPairs = 0
    let compared = 0
    for (let i = 0; i < uniqueIntents.length; i++) {
      for (let j = i + 1; j < uniqueIntents.length; j++) {
        const a = tokens(uniqueIntents[i]!)
        const b = tokens(uniqueIntents[j]!)
        if (!a.size || !b.size) continue
        compared += 1
        let inter = 0
        for (const t of a) if (b.has(t)) inter += 1
        const jac = inter / (a.size + b.size - inter)
        if (jac < 0.08) lowOverlapPairs += 1
      }
    }
    if (compared > 0 && lowOverlapPairs >= Math.max(1, compared - 0)) {
      // 全部两两低重叠 → 冲突；若至少一对有重叠则放行（由 maxUnique 兜底）
      if (lowOverlapPairs === compared) {
        return { ok: false, reason: 'intent_conflict' }
      }
    }
  }
  return { ok: true, uniqueIntents: uniqueIntents.slice(0, 5), avgSuccess }
}

export async function runSemanticConsolidationJob(env: NodeJS.ProcessEnv = process.env): Promise<{
  scanned: number
  consolidated: number
  skipped: number
  shadowed?: number
  rejected?: number
}> {
  if (!isSemanticConsolidationEnabled(env)) {
    return { scanned: 0, consolidated: 0, skipped: 0, shadowed: 0, rejected: 0 }
  }

  const threshold = AMP_EXPERIENCE_SUCCESS_THRESHOLD
  const res = await agentPgQuery<ExperienceRow>(
    `SELECT payload FROM mgr_memory_entries
     WHERE entry_type = 'experience'
       AND COALESCE((payload->>'successScore')::float, (payload->>'success_score')::float, 0) >= $1
     ORDER BY ts DESC
     LIMIT 800`,
    [threshold],
    env
  )
  const rows = res?.rows ?? []
  const byScenario = new Map<string, ExperienceRow[]>()
  for (const row of rows) {
    const key = scenarioKey(row.payload)
    const list = byScenario.get(key) ?? []
    list.push(row)
    byScenario.set(key, list)
  }

  const existing = await agentPgQuery<{ scenario: string }>(
    `SELECT DISTINCT payload->>'scenarioKey' AS scenario
     FROM mgr_memory_entries
     WHERE entry_type = 'semantic'`,
    [],
    env
  )
  const hasSemantic = new Set((existing?.rows ?? []).map((r) => String(r.scenario || '')))

  let consolidated = 0
  let skipped = 0
  let shadowed = 0
  let rejected = 0
  const minCluster = minClusterSize(env)
  const maxUnique = maxUniqueIntents(env)

  for (const [scenario, cluster] of byScenario) {
    if (hasSemantic.has(scenario)) {
      skipped += 1
      continue
    }

    const gate = evaluateSemanticClusterGate(cluster, {
      minCluster,
      maxUniqueIntents: maxUnique,
      minAvgSuccess: threshold,
    })
    if (!gate.ok) {
      if (gate.reason === 'cluster_too_small') skipped += 1
      else rejected += 1
      continue
    }

    const fact = `场景「${scenario}」已验证 ${cluster.length} 次成功路径；常见意图：${gate.uniqueIntents.join('；')}`
    const confidence = Math.min(0.95, 0.55 + cluster.length * 0.08)

    // S1.3：写入 shadow，禁止 silent 正式 semantic 晋级
    await recordMemory(
      {
        type: 'semantic',
        agent: 'manager',
        successScore: confidence,
        payload: {
          scenarioKey: scenario,
          intent: gate.uniqueIntents[0] || scenario,
          fact,
          confidence,
          source: 'semantic_consolidation_job',
          clusterSize: cluster.length,
          status: 'shadow',
          needsHumanReview: true,
          avgSuccess: Number(gate.avgSuccess.toFixed(4)),
        },
      },
      env
    )
    hasSemantic.add(scenario)
    consolidated += 1
    shadowed += 1
  }

  return { scanned: rows.length, consolidated, skipped, shadowed, rejected }
}
