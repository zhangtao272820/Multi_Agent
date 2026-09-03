import { agentHttpBaseFromWsUrl } from '../agents/agentTransport'

/** 事前 HITL：确认后应用 pending patch */
export async function applyCodePendingPatch(input: {
  codeAgentWsUrl: string
  pendingId: string
  confirmToken: string
  decision?: '确认' | '取消'
  signal?: AbortSignal
}): Promise<{ ok: boolean; error?: string; answer?: string }> {
  const base = agentHttpBaseFromWsUrl(input.codeAgentWsUrl, '13103')
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/pending/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pending_id: input.pendingId,
        decision: input.decision || '确认',
        confirm_token: input.confirmToken || '',
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
    }
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message ?? e ?? 'apply failed') }
  }
}
