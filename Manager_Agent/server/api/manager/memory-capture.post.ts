/**
 * Wave 8b：用户侧记忆提案轻确认（偏好确认 / 知晓草稿已提交）
 * 不走 ops token；不 promote skill/规则。
 */
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'
import {
  confirmPendingUserPrefs,
  rejectPendingUserPrefs,
} from '../../graph/core/memory/userProfile'

type Body = {
  decision?: string
  kind?: string
  userId?: string
  sessionId?: string
  tenantId?: string
  runId?: string
  proposalId?: string
}

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => ({}))) as Body
  const decision = String(body?.decision || '').trim().toLowerCase()
  const kind = String(body?.kind || '').trim().toLowerCase()
  const userId = String(body?.userId || '').trim()
  const tenantId = body?.tenantId ? String(body.tenantId) : undefined
  const policyDir = resolveManagerPolicyDir(tenantId)

  if (!decision) {
    return { ok: false, message: 'missing decision' }
  }

  // 偏好：须显式 confirm / reject
  if (kind === 'save_preference' || decision === 'confirm_prefs' || decision === 'reject_prefs') {
    if (!userId) return { ok: false, message: 'missing userId' }
    if (decision === 'confirm' || decision === 'confirm_prefs') {
      const profile = await confirmPendingUserPrefs(policyDir, userId, tenantId)
      return { ok: Boolean(profile), decision: 'confirm', kind: 'save_preference', profile }
    }
    if (decision === 'reject' || decision === 'reject_prefs') {
      const profile = await rejectPendingUserPrefs(policyDir, userId, tenantId)
      return { ok: Boolean(profile), decision: 'reject', kind: 'save_preference', profile }
    }
  }

  // 打法 / 答案 / 规则：用户「已知晓已提交审核」——仅回执，不晋级
  if (
    decision === 'ack' ||
    decision === 'dismiss' ||
    decision === 'acknowledge'
  ) {
    return {
      ok: true,
      decision: 'ack',
      kind: kind || 'memory_capture',
      runId: body?.runId || null,
      note: 'draft_remains_pending_admin_review',
    }
  }

  return { ok: false, message: `unsupported decision: ${decision}` }
})
