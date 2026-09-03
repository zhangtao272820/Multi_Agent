/**
 * 自我进化 P0/P1 smoke：经验写入门控 + confirmed 召回 + version lift
 */
import { qualifiesHighQualityExperience, refineExperienceWrite } from '../../../server/graph/core/memory/experienceWritePolicy'
import { buildEvolutionVersionLift } from '../../../server/graph/core/evolution/evolutionVersionLift'
import { isConfirmedExperienceRow } from '#agent-shared/experienceRecallPolicy'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const base = {
  successScore: 0.9,
  failureCategory: 'success',
  needsClarify: false,
  retryCount: 0,
  routeConfidence: 0.9,
  finalConfidence: 0.88,
  evidenceSupportedClaimRate: 0.75,
  evidenceGatePassed: true,
  hasSubstantialFinal: true
}

assert(qualifiesHighQualityExperience(base), 'evidence gate pass qualifies')
assert(!qualifiesHighQualityExperience({ ...base, needsClarify: true }), 'clarify blocks')
assert(qualifiesHighQualityExperience({ ...base, evidenceGatePassed: false, feedbackScore: 1 }), 'feedback qualifies')

const capped = refineExperienceWrite({
  ...base,
  evidenceGatePassed: false,
  evidenceSupportedClaimRate: 0.2,
  routeConfidence: 0.7,
  finalConfidence: 0.68
})
assert(capped.cappedForLearning && capped.successScore < 0.72, 'unqualified high score capped')

assert(isConfirmedExperienceRow({ source: 'manager_feedback_confirmed' }), 'confirmed source')
assert(isConfirmedExperienceRow({ source: 'vanna_feedback|useful' }), 'vanna useful')
assert(!isConfirmedExperienceRow({ source: 'manager_shadow' }), 'shadow excluded')
assert(!isConfirmedExperienceRow({ source: 'manager_finalize_sync', status: 'confirmed' }), 'finalize not useful')
assert(!isConfirmedExperienceRow({ source: 'voided|vanna_feedback|useful' }), 'voided excluded')

const lift = buildEvolutionVersionLift([
  {
    ts: new Date().toISOString(),
    runId: 'r1',
    intent: 'rag',
    compositeScore: 0.8,
    finalConfidence: 0.8,
    routeConfidence: 0.7,
    successScore: 0.85,
    durationMs: 1,
    usedTokens: 1,
    usedUsd: 0,
    firstPassSuccess: true,
    needsClarify: false,
    policyVersion: 2,
    promptCanary: false
  }
])
assert(lift.policy.length >= 1, 'version lift buckets')

console.log('smoke: evolution upgrades ok')
