/**
 * W2：release-bundle sticky canary — 同 session 三制品抽桶一致
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  computeReleaseBundleId,
  resolveBundleCanaryDecision,
  stickyBucketForSession,
  isStickyCanaryBundleEnabled,
} from '../../../server/graph/core/evolution/releaseBundleCanary'
import { resolveEffectivePromptPatches, resolveEffectivePlannerRules } from '../../../server/graph/core/evolution/artifactCanary'
import { resolveEffectiveManagerPolicy } from '../../../server/graph/core/evolution/policyCanary'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-sticky-canary-bundle] ${msg}`)
}

async function main() {
  console.log('smoke-sticky-canary-bundle: start')
  assert(isStickyCanaryBundleEnabled({ MANAGER_STICKY_CANARY_BUNDLE: '1' } as NodeJS.ProcessEnv), 'sticky on')

  const sid = 'sess-sticky-canary-1'
  const bid = 'bundledeadbeef0123456789'
  const a = stickyBucketForSession(sid, bid, 100)
  const b = stickyBucketForSession(sid, bid, 100)
  const c = stickyBucketForSession(sid, bid, 100)
  assert(a === b && b === c && a === true, 'percent 100 always in')
  const z = stickyBucketForSession(sid, bid, 0)
  assert(z === false, 'percent 0 never in')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sticky-canary-'))
  const prevSticky = process.env.MANAGER_STICKY_CANARY_BUNDLE
  const prevPct = process.env.MANAGER_POLICY_CANARY_PERCENT
  process.env.MANAGER_STICKY_CANARY_BUNDLE = '1'
  process.env.MANAGER_POLICY_CANARY_PERCENT = '100'
  process.env.MANAGER_PROMPT_PATCHES = '1'

  await fs.writeFile(path.join(tmp, 'manager-policy.json'), JSON.stringify({ version: 1 }), 'utf8')
  await fs.writeFile(path.join(tmp, 'manager-policy.shadow.json'), JSON.stringify({ version: 2 }), 'utf8')
  await fs.writeFile(
    path.join(tmp, 'manager-prompt-patches.shadow.json'),
    JSON.stringify({
      version: 1,
      active: true,
      router: { append: ['sticky canary router hint'] },
      planner: { append: ['sticky canary planner hint'] },
    }),
    'utf8'
  )
  await fs.writeFile(
    path.join(tmp, 'manager-planner-rules.shadow.json'),
    JSON.stringify({
      version: 1,
      active: true,
      rules: [{ id: 'r1', message: 'sticky canary rule' }],
    }),
    'utf8'
  )

  const bundleId = await computeReleaseBundleId(tmp)
  assert(Boolean(bundleId), 'bundleId from shadows')

  const d1 = await resolveBundleCanaryDecision(tmp, sid, { env: process.env })
  const d2 = await resolveBundleCanaryDecision(tmp, sid, { env: process.env })
  const d3 = await resolveBundleCanaryDecision(tmp, sid, { env: process.env })
  assert(d1.inCanary === d2.inCanary && d2.inCanary === d3.inCanary, 'decision stable')
  assert(d1.bundleId === bundleId, 'bundleId match')
  assert(d1.inCanary === true, '100% canary in')

  const pol = await resolveEffectiveManagerPolicy(tmp, sid)
  const prompt = await resolveEffectivePromptPatches(tmp, sid)
  const rules = await resolveEffectivePlannerRules(tmp, sid)
  assert(pol.canary === prompt.canary && prompt.canary === rules.canary, 'three artifacts same canary flag')
  assert(pol.bundleCanary === prompt.bundleCanary && prompt.bundleCanary === rules.bundleCanary, 'bundleCanary aligned')
  assert(pol.canary === true, 'all in treatment at 100%')

  // suppress
  const polOff = await resolveEffectiveManagerPolicy(tmp, sid, { suppressCanary: true })
  assert(polOff.canary === false && polOff.bundleCanary === false, 'suppress clears canary')

  // no shadow → no canary
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sticky-empty-'))
  await fs.writeFile(path.join(empty, 'manager-policy.json'), JSON.stringify({ version: 1 }), 'utf8')
  const noShadow = await resolveBundleCanaryDecision(empty, sid, { env: process.env })
  assert(noShadow.bundleId === null && noShadow.inCanary === false, 'no shadow no canary')

  if (prevSticky === undefined) delete process.env.MANAGER_STICKY_CANARY_BUNDLE
  else process.env.MANAGER_STICKY_CANARY_BUNDLE = prevSticky
  if (prevPct === undefined) delete process.env.MANAGER_POLICY_CANARY_PERCENT
  else process.env.MANAGER_POLICY_CANARY_PERCENT = prevPct

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(empty, { recursive: true, force: true }).catch(() => undefined)

  console.log('smoke-sticky-canary-bundle: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
