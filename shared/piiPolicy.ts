/**
 * PII / 密钥脱敏策略 SSOT（日志 / 指标 / Observation；不改用户可见正文默认）。
 */

import { redactSecrets, truncateText, redactForPersistence, redactObservation } from './redact'

export type PiiPolicyProfile = 'lan' | 'enterprise'

export function resolvePiiPolicyProfile(env: NodeJS.ProcessEnv = process.env): PiiPolicyProfile {
  const raw = String(env.MANAGER_PII_POLICY ?? env.AGENT_SECURITY_PROFILE ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'enterprise' || raw === 'strict' || raw === 'prod') return 'enterprise'
  return 'lan'
}

export function resolvePersistenceMaxFieldChars(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePiiPolicyProfile(env) === 'enterprise' ? 1200 : 2000
}

/** 日志 / metrics.jsonl 落盘 */
export function redactForLogs(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  return redactForPersistence(value, {
    maxFieldChars: resolvePersistenceMaxFieldChars(env),
    maxChars: resolvePiiPolicyProfile(env) === 'enterprise' ? 8000 : undefined
  })
}

/** 工具 Observation（企业档更短截断） */
export function redactToolObservation(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const max = resolvePiiPolicyProfile(env) === 'enterprise' ? 3000 : 4000
  return redactObservation(text, max)
}

export { redactSecrets, truncateText }
