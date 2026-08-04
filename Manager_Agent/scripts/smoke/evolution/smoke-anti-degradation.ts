/**
 * 防退化进化 smoke：信号准入 + intent 分片对照
 */
import {
  evaluateLearnEligibility,
  filterInsightsForEvolution,
  isFailureCategoryEvolutionEligible
} from '../../../server/graph/core/evolution/learnEligibility'
import { compareArmsByIntent } from '../../../server/graph/core/evolution/evolutionExperiments'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

// --- 门 1：准入 ---
const cancel = evaluateLearnEligibility({
  signalSource: 'implicit',
  implicitKind: 'user_cancel',
  intent: 'rag'
})
assert(!cancel.eligibleForEvolution && !cancel.eligibleForBandit, 'cancel blocked')

const chitchat = evaluateLearnEligibility({ intent: 'chitchat', failureCategory: 'route_error' })
assert(!chitchat.eligibleForEvolution && !chitchat.eligibleForBandit, 'chitchat blocked')

const timeout = evaluateLearnEligibility({ failureCategory: 'timeout', intent: 'db' })
assert(!timeout.eligibleForHypothesis && !timeout.eligibleForEvolution, 'timeout ops-only')

const routeFail = evaluateLearnEligibility({ failureCategory: 'route_error', intent: 'rag' })
assert(routeFail.eligibleForEvolution && routeFail.eligibleForHypothesis, 'route_error eligible')

const reject = evaluateLearnEligibility({
  signalSource: 'implicit',
  implicitKind: 'human_reject',
  intent: 'rag'
})
assert(!reject.eligibleForEvolution && reject.eligibleForBandit, 'implicit penalty only')

const positive = evaluateLearnEligibility({
  signalSource: 'explicit_feedback',
  feedbackScore: 0.9,
  firstPassSuccess: true,
  compositeScore: 0.85,
  failureCategory: 'success',
  intent: 'rag'
})
assert(positive.eligibleForEvolution && positive.weight > 0.8, 'positive weighted')

assert(isFailureCategoryEvolutionEligible('clarify_needed', { clarifyConcentration: 0.5 }), 'clarify high conc')
assert(!isFailureCategoryEvolutionEligible('clarify_needed', { clarifyConcentration: 0.1 }), 'clarify low conc')

const filtered = filterInsightsForEvolution({
  samples: 20,
  failures: [
    { category: 'timeout', count: 5 },
    { category: 'route_error', count: 8 },
    { category: 'clarify_needed', count: 2 }
  ],
  fixSuggestions: [
    { category: 'timeout' },
    { category: 'route_error' },
    { category: 'clarify_needed' }
  ]
} as any)
assert(
  filtered.failures.every((f: any) => f.category === 'route_error'),
  'filter keeps route_error only'
)

// --- 门 3：intent 分片 ---
process.env.MANAGER_EVOLUTION_MIN_SAMPLES = '4'
process.env.MANAGER_EVOLUTION_ROLLBACK_DROP = '0.06'

const rows = []
for (let i = 0; i < 6; i++) {
  rows.push({ intent: 'rag', policyCanary: false, finalConfidence: 0.8 })
  rows.push({ intent: 'rag', policyCanary: true, finalConfidence: 0.5 }) // regress
  rows.push({ intent: 'db', policyCanary: false, finalConfidence: 0.7 })
  rows.push({ intent: 'db', policyCanary: true, finalConfidence: 0.75 }) // slight lift
}

const sliced = compareArmsByIntent(rows, [], 'policyCanary')
assert(sliced.forcedRollback, 'rag regression forces rollback')
assert(sliced.slices.some((s) => s.intent === 'rag' && s.regressing), 'rag marked regressing')
assert(sliced.reason?.includes('rag'), 'reason names rag')

console.log('smoke: anti-degradation evolution ok')
