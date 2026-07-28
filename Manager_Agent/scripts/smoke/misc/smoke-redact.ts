/**
 * G3：日志 / metrics 脱敏 smoke。
 */
import {
  redactSecrets,
  redactForPersistence,
  redactObservation,
  containsPlainSecretPatterns
} from '../../../agent-repo-shared/redact'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const sample = [
  'api_key=sk-abcdefghijklmnopqrstuvwxyz',
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xxxxxxxx',
  'contact user@example.com',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'
].join('\n')

const scrubbed = redactSecrets(sample)
assert(!containsPlainSecretPatterns(scrubbed), 'redactSecrets removes patterns')
assert(!scrubbed.includes('user@example.com'), 'email redacted')

const obs = redactObservation('x'.repeat(5000), 400)
assert(obs.includes('[truncated'), 'observation truncated')
assert(obs.length < 500, 'observation length capped')

const row = redactForPersistence({
  answer: sample,
  nested: { token: 'secret-value-12345678', note: 'y'.repeat(3000) }
}) as Record<string, unknown>
assert(row.token === '***REDACTED***' || (row.nested as { token?: string })?.token === '***REDACTED***', 'token key redacted')
assert(!containsPlainSecretPatterns(JSON.stringify(row)), 'persistence payload clean')

console.log('smoke-redact: ok')
