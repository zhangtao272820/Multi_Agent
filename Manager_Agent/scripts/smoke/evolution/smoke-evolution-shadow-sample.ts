/**
 * Wave6：进化 shadow 对照采样 — 只记录不晋级
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendEvolutionShadowSample,
  isEvolutionShadowSampleEnabled,
  listEvolutionShadowSamples,
  recordEvolutionShadowSampleIfNeeded,
  shouldSampleEvolutionShadow,
} from '../../../server/graph/core/evolution/evolutionShadowSample'
import { isOnlineEvalPromoteGateEnabled } from '../../../agent-repo-shared/onlineEvalStore'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-evolution-shadow-sample] ${msg}`)
}

async function main() {
  console.log('smoke-evolution-shadow-sample: start')
  assert(isEvolutionShadowSampleEnabled({ MANAGER_EVOLUTION_SHADOW_SAMPLE: '1' } as NodeJS.ProcessEnv), 'enabled')
  assert(shouldSampleEvolutionShadow('k', 100), '100% samples')
  assert(!shouldSampleEvolutionShadow('k', 0), '0% skips')
  assert(isOnlineEvalPromoteGateEnabled({ EVO_ONLINE_EVAL_GATE: '1' } as NodeJS.ProcessEnv), 'eval gate default on')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-shadow-'))
  process.env.MANAGER_EVOLUTION_SHADOW_SAMPLE = '1'
  process.env.MANAGER_EVOLUTION_SHADOW_SAMPLE_PERCENT = '100'

  const r = await recordEvolutionShadowSampleIfNeeded({
    policyDir: tmp,
    runId: 'run-shadow-1',
    sessionId: 'sess-1',
    bundleId: 'bundleabc',
    inCanary: false,
    activeDecision: { sourceCommitment: 'clear', allowedAgents: ['db'] },
    candidateDecision: { sourceCommitment: 'clear', allowedAgents: ['rag'], note: 'shadow_hypothesis' },
  })
  assert(r.sampled, 'sampled')

  await appendEvolutionShadowSample(tmp, {
    ts: new Date().toISOString(),
    runId: 'run-2',
    activeDecision: { a: 1 },
    candidateDecision: { a: 2 },
  })

  const listed = await listEvolutionShadowSamples(tmp, 10)
  assert(listed.length >= 2, `listed=${listed.length}`)
  assert(listed.some((x) => x.note?.includes('no_auto_promote') || x.runId === 'run-2'), 'samples readable')
  assert(String(process.env.MANAGER_PROMPT_AUTO_PROMOTE ?? '0') !== '1', 'auto promote still off by default')

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log('smoke-evolution-shadow-sample: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
