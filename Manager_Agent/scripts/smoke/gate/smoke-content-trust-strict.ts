/**
 * 企业档 contentTrust 严档 + 指标契约（不调 LLM）。
 */
import {
  prepareUntrustedForSynth,
  isUntrustedWrapped
} from '../../../agent-repo-shared/contentTrust'
import {
  isContentTrustStrictEnabled,
  CONTENT_TRUST_STRICT_MAX_CHARS
} from '../../../agent-repo-shared/contentTrustStrict'
import {
  getContentTrustMetricsSnapshot,
  resetContentTrustMetricsForTests
} from '../../../agent-repo-shared/contentTrustMetrics'
import { resolveUntrustedMaxChars } from '../../../agent-repo-shared/contentTrustStrict'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-content-trust-strict] ${msg}`)
}

console.log('smoke-content-trust-strict: start')

assert(!isContentTrustStrictEnabled({ AGENT_SECURITY_PROFILE: 'lan' } as NodeJS.ProcessEnv), 'lan off')
assert(isContentTrustStrictEnabled({ AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv), 'enterprise on')
assert(
  isContentTrustStrictEnabled({ MANAGER_CONTENT_TRUST_STRICT: '1' } as NodeJS.ProcessEnv),
  'explicit on'
)

const long = 'x'.repeat(2000)
resetContentTrustMetricsForTests()
const wrapped = prepareUntrustedForSynth(
  'crawler',
  long,
  (s) => s,
  1200,
  { AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv
)
assert(isUntrustedWrapped(wrapped), 'wrapped')
assert(wrapped.length < long.length + 200, 'enterprise caps length')
assert(
  resolveUntrustedMaxChars(1200, { AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv) ===
    CONTENT_TRUST_STRICT_MAX_CHARS,
  'cap constant'
)

const snap = getContentTrustMetricsSnapshot()
assert(snap.wrapTotal >= 1, 'wrap metric')
assert(snap.strictModeTotal >= 1, 'strict metric')

console.log('smoke-content-trust-strict: OK')
