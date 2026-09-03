/**
 * 内容信任严档：仅 enterprise profile 或显式 env 开启；LAN 默认不变。
 */

import { isEnterpriseSecurityProfile } from './securityProfile'

export const CONTENT_TRUST_STRICT_MAX_CHARS = 800

export function isContentTrustStrictEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.MANAGER_CONTENT_TRUST_STRICT ?? '').trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return isEnterpriseSecurityProfile(env)
}

export function resolveUntrustedMaxChars(defaultMax: number, env: NodeJS.ProcessEnv = process.env): number {
  const base = Math.max(64, Number(defaultMax) || 1200)
  if (!isContentTrustStrictEnabled(env)) return base
  return Math.min(base, CONTENT_TRUST_STRICT_MAX_CHARS)
}
