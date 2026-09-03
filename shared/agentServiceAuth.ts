/**
 * E5.2：总管 → 专家服务身份（Envelope / HTTP 侧车）。
 *
 * 头：`x-agent-service-token`（规范）+ `x-clawhive-internal-token`（兼容）
 * 密钥：AGENT_SERVICE_TOKEN → CLAWHIVE_INTERNAL_TOKEN → AGENT_INTERNAL_TOKEN → MANAGER_OPS_TOKEN
 *
 * AGENT_SERVICE_AUTH=require|1 时：无密钥拒配；有密钥时出站必带、入站必验。
 * 默认 off：有密钥则出站携带、入站校验（与 CodePy 现状一致）；无密钥则不拦（LAN 开发）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isEnterpriseSecurityProfile } from './securityProfile'

export const AGENT_SERVICE_TOKEN_HEADER = 'x-agent-service-token'
export const CLAWHIVE_INTERNAL_TOKEN_HEADER = 'x-clawhive-internal-token'

export type AgentServiceAuthMode = 'off' | 'optional' | 'require'

export function resolveAgentServiceToken(env: NodeJS.ProcessEnv = process.env): string {
  return String(
    env.AGENT_SERVICE_TOKEN ||
      env.CLAWHIVE_INTERNAL_TOKEN ||
      env.AGENT_INTERNAL_TOKEN ||
      env.MANAGER_OPS_TOKEN ||
      ''
  ).trim()
}

export function resolveAgentServiceAuthMode(env: NodeJS.ProcessEnv = process.env): AgentServiceAuthMode {
  const raw = String(env.AGENT_SERVICE_AUTH || env.MANAGER_AGENT_SERVICE_AUTH || '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return 'off'
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes' || raw === 'require' || raw === 'required') {
    return 'require'
  }
  if (raw === 'optional') return 'optional'
  // 企业档未显式设 AUTH → require（缺 token 由 getAgentServiceAuthConfigStatus 拒配）
  if (isEnterpriseSecurityProfile(env)) return 'require'
  // LAN：有 token 则 optional（出站带、入站验）；无 token 则 off
  return resolveAgentServiceToken(env) ? 'optional' : 'off'
}

export function isAgentServiceAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = resolveAgentServiceAuthMode(env)
  return mode === 'optional' || mode === 'require'
}

export type AgentServiceAuthConfigStatus = {
  ok: boolean
  mode: AgentServiceAuthMode
  hasToken: boolean
  detail?: string
}

export function getAgentServiceAuthConfigStatus(env: NodeJS.ProcessEnv = process.env): AgentServiceAuthConfigStatus {
  const mode = resolveAgentServiceAuthMode(env)
  const hasToken = Boolean(resolveAgentServiceToken(env))
  if (mode === 'require' && !hasToken) {
    return { ok: false, mode, hasToken, detail: 'agent_service_token_required_but_missing' }
  }
  return { ok: true, mode, hasToken }
}

export function buildAgentServiceAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const mode = resolveAgentServiceAuthMode(env)
  if (mode === 'off') return {}
  const token = resolveAgentServiceToken(env)
  if (!token) return {}
  return {
    [AGENT_SERVICE_TOKEN_HEADER]: token,
    [CLAWHIVE_INTERNAL_TOKEN_HEADER]: token
  }
}

function headerGet(headers: Record<string, unknown> | null | undefined, name: string): string {
  if (!headers || typeof headers !== 'object') return ''
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v ?? '').trim()
  }
  return ''
}

function safeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

export type AgentServiceAuthVerifyResult = {
  ok: boolean
  reason?: string
}

/** 从 HTTP / WS 头校验服务身份 */
export function verifyAgentServiceAuth(
  headers: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): AgentServiceAuthVerifyResult {
  const mode = resolveAgentServiceAuthMode(env)
  if (mode === 'off') return { ok: true }
  const expected = resolveAgentServiceToken(env)
  if (!expected) {
    if (mode === 'require') return { ok: false, reason: 'agent_service_token_not_configured' }
    return { ok: true }
  }
  const got =
    headerGet(headers, AGENT_SERVICE_TOKEN_HEADER) ||
    headerGet(headers, CLAWHIVE_INTERNAL_TOKEN_HEADER) ||
    headerGet(headers, 'x-internal-token')
  if (!got) return { ok: false, reason: 'agent_service_token_missing' }
  if (!safeEqualStr(got, expected)) return { ok: false, reason: 'agent_service_token_invalid' }
  return { ok: true }
}

/** HITL confirm_token：HMAC(runId|confirmId)；无密钥时退化为 confirmId 明文（仍可存在性校验） */
export function mintHitlConfirmToken(
  runId: string,
  confirmId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const rid = String(runId || '').trim()
  const cid = String(confirmId || '').trim()
  if (!rid || !cid) return ''
  const secret = resolveAgentServiceToken(env)
  if (!secret) return cid
  return createHmac('sha256', secret).update(`${rid}|${cid}`).digest('hex').slice(0, 48)
}

export function verifyHitlConfirmToken(
  token: string,
  runId: string,
  confirmId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const got = String(token || '').trim()
  if (!got) return false
  const expected = mintHitlConfirmToken(runId, confirmId, env)
  return Boolean(expected) && safeEqualStr(got, expected)
}
