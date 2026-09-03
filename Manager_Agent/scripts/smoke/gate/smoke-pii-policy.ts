/**
 * PII 策略 SSOT smoke（不调 LLM）。
 */
import { redactForLogs, redactToolObservation, resolvePiiPolicyProfile } from '../../../agent-repo-shared/piiPolicy'
import { containsPlainSecretPatterns } from '../../../agent-repo-shared/redact'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-pii-policy] ${msg}`)
}

console.log('smoke-pii-policy: start')

assert(resolvePiiPolicyProfile({ AGENT_SECURITY_PROFILE: 'lan' } as NodeJS.ProcessEnv) === 'lan', 'lan')
assert(
  resolvePiiPolicyProfile({ AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv) === 'enterprise',
  'enterprise'
)

const sample = 'contact user@example.com sk-abcdefghijklmnopqrstuvwxyz'
const lanLog = String(redactForLogs({ msg: sample }, { AGENT_SECURITY_PROFILE: 'lan' } as NodeJS.ProcessEnv))
assert(!containsPlainSecretPatterns(lanLog), 'lan redact secrets')

const entObs = redactToolObservation(sample, { AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv)
assert(!containsPlainSecretPatterns(entObs), 'enterprise obs redact')
assert(entObs.length <= 3100, 'enterprise shorter obs cap')

console.log('smoke-pii-policy: OK')
