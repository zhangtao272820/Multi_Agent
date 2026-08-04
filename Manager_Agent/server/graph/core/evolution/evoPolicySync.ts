/**
 * 文件侧 shadow/active 与 evo_policy_versions（PG）对齐。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  promoteEvoPolicy,
  rollbackEvoPolicy,
  upsertEvoPolicyVersion,
  writeEvoShadowPolicy
} from '#agent-shared/evoPolicyStore'
import { tenantIdFromPolicyDir } from '../../../utils/session/managerPolicyDir'
import type { EvolutionArtifact } from './evolutionExperiments'

export function stageForArtifact(artifact: EvolutionArtifact): string {
  if (artifact === 'policy') return 'policy'
  if (artifact === 'planner_rules') return 'planner_rules'
  return 'prompt_patches'
}

export async function syncEvoPolicyShadowWrite(
  policyDir: string,
  artifact: EvolutionArtifact,
  payload: Record<string, unknown>
) {
  const tenantId = tenantIdFromPolicyDir(policyDir)
  await writeEvoShadowPolicy('manager', stageForArtifact(artifact), payload, process.env, tenantId).catch(
    () => undefined
  )
}

export async function syncEvoPolicyPromote(
  policyDir: string,
  artifact: EvolutionArtifact,
  payload: Record<string, unknown>,
  opts?: { verifyOk?: boolean }
) {
  const tenantId = tenantIdFromPolicyDir(policyDir)
  return promoteEvoPolicy(
    'manager',
    stageForArtifact(artifact),
    { shadowPayload: payload, verifyOk: opts?.verifyOk !== false, tenantId },
    process.env
  ).catch(() => ({ ok: false as const, reason: 'pg_promote_failed' }))
}

export async function syncEvoPolicyRollback(policyDir: string, artifact: EvolutionArtifact) {
  const tenantId = tenantIdFromPolicyDir(policyDir)
  return rollbackEvoPolicy('manager', stageForArtifact(artifact), process.env, tenantId).catch(() => ({
    ok: false as const,
    reason: 'pg_rollback_failed'
  }))
}

/** 持平或不晋升时丢弃 shadow，并标记 PG discarded */
export async function discardEvoShadowArtifact(
  policyDir: string,
  artifact: EvolutionArtifact,
  payload?: Record<string, unknown>
): Promise<{ discarded: boolean }> {
  const files =
    artifact === 'policy'
      ? ['manager-policy.shadow.json']
      : artifact === 'prompt_patches'
        ? ['manager-prompt-patches.shadow.json']
        : ['manager-planner-rules.shadow.json']

  for (const f of files) {
    await fs.unlink(path.join(policyDir, f)).catch(() => undefined)
  }

  const tenantId = tenantIdFromPolicyDir(policyDir)
  const stage = stageForArtifact(artifact)
  await upsertEvoPolicyVersion(
    {
      tenantId,
      agent: 'manager',
      stage,
      version: Date.now() % 1_000_000_000,
      status: 'discarded',
      payload: { ...(payload || {}), discardedAt: new Date().toISOString(), reason: 'experiment_tie_or_reject' }
    },
    process.env
  ).catch(() => undefined)

  return { discarded: true }
}
