import { agentHttpBaseFromWsUrl } from '../agents/agentTransport'

/** 事前 HITL：确认后应用 pending patch（可选验证失败自动回滚） */
export async function applyCodePendingPatch(input: {
  codeAgentWsUrl: string
  pendingId: string
  confirmToken: string
  decision?: '确认' | '取消'
  verifyAfterApply?: boolean
  verifyCommand?: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  error?: string
  answer?: string
  rollback_ref?: string
  rolled_back?: boolean
  verify?: unknown
}> {
  const base = agentHttpBaseFromWsUrl(input.codeAgentWsUrl, '13103')
  const verifyEnv = String(process.env.MANAGER_CODE_VERIFY_AFTER_APPLY ?? '').trim() === '1'
  const verifyAfter =
    input.verifyAfterApply !== undefined ? Boolean(input.verifyAfterApply) : verifyEnv
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/pending/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pending_id: input.pendingId,
        decision: input.decision || '确认',
        confirm_token: input.confirmToken || '',
        ...(verifyAfter ? { verify_after_apply: true } : {}),
        ...(input.verifyCommand ? { verify_command: input.verifyCommand } : {}),
      }),
      signal: input.signal,
    })
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: text || `HTTP ${res.status}` }
    }
    return {
      ok: Boolean(data?.ok),
      answer: String(data?.answer || ''),
      error: data?.ok ? undefined : String(data?.error_code || data?.answer || 'apply failed'),
      rollback_ref: data?.rollback_ref ? String(data.rollback_ref) : undefined,
      rolled_back: Boolean(data?.rolled_back),
      verify: data?.verify,
    }
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e ?? 'apply failed') }
  }
}
