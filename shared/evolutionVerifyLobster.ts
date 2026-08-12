/**
 * Lobster 专用进化 verify（不依赖 onlineEvalStore / PG）。
 * 供 Lobster Docker 镜像窄白名单同步；Manager 侧仍走 evolutionVerify.verifyBeforePromote('lobster')。
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { resolveEvolutionEnvBool } from './agentEvolutionMode'

export type LobsterEvolutionVerifyResult = {
  ok: boolean
  agent: 'lobster'
  gate: string
  reason?: string
  checks: Array<{ id: string; ok: boolean; detail?: string }>
}

export function isLobsterEvolutionVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEvolutionEnvBool('EVO_VERIFY_BEFORE_PROMOTE', true, env)
}

export async function verifyLobsterEvolutionPromote(): Promise<LobsterEvolutionVerifyResult> {
  const checks: LobsterEvolutionVerifyResult['checks'] = []
  try {
    const cwd = process.cwd()
    const lobsterRoot =
      path.basename(cwd) === 'Lobster_Agent'
        ? cwd
        : existsSync(path.join(cwd, 'Lobster_Agent', 'package.json'))
          ? path.join(cwd, 'Lobster_Agent')
          : path.resolve(cwd, '..', 'Lobster_Agent')
    const fs = await import('node:fs/promises')
    for (const rel of [
      'server/services/lobsterPlaybookEvolution.ts',
      'server/services/lobsterPlaybookCache.ts',
      'server/api/lobster/playbook-evolution.post.ts',
    ]) {
      const st = await fs.stat(path.join(lobsterRoot, rel)).catch(() => null)
      checks.push({ id: rel, ok: Boolean(st?.isFile()) })
    }
    checks.push({
      id: 'auto_promote_off',
      ok:
        String(process.env.LOBSTER_PLAYBOOK_AUTO_PROMOTE ?? '0').trim() !== '1' ||
        String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1',
      detail: 'default no unattended promote',
    })
  } catch (e) {
    checks.push({ id: 'lobster_smoke_exception', ok: false, detail: String((e as Error)?.message || e) })
  }
  const ok = checks.every((c) => c.ok)
  return {
    ok,
    agent: 'lobster',
    gate: 'lobster_playbook_structure',
    reason: ok ? undefined : 'lobster_smoke_failed',
    checks,
  }
}

/** Lobster promote 前门禁（与 verifyBeforePromote('lobster') 等价，无 PG 依赖） */
export async function verifyBeforePromoteLobster(
  env: NodeJS.ProcessEnv = process.env
): Promise<LobsterEvolutionVerifyResult> {
  if (!isLobsterEvolutionVerifyEnabled(env)) {
    return {
      ok: true,
      agent: 'lobster',
      gate: 'disabled',
      checks: [{ id: 'verify_disabled', ok: true }],
    }
  }
  return verifyLobsterEvolutionPromote()
}
