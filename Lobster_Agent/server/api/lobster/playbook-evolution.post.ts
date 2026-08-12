import {
  listPlaybookShadows,
  promotePlaybookShadow,
  rejectPlaybookShadow,
  rollbackPlaybookActive,
  savePlaybookEvolved,
  verifyLobsterPlaybookStructure,
} from '../../services/lobsterPlaybookEvolution'

/**
 * GET/POST Lobster playbook 门禁进化。
 * POST body: { action: list|promote|reject|rollback|save_shadow, key?, startUrl?, plan_steps? }
 */
export default defineEventHandler(async (event) => {
  const method = event.method || 'GET'
  if (method === 'GET') {
    const q = getQuery(event)
    const status = String(q.status || 'shadow') as 'shadow' | 'active' | 'all'
    return { ok: true, items: listPlaybookShadows(status), autoPromote: false }
  }

  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null
  const action = String(body?.action || '').trim()
  if (action === 'list') {
    return { ok: true, items: listPlaybookShadows((body?.status as any) || 'shadow') }
  }
  if (action === 'promote') {
    return await promotePlaybookShadow(String(body?.key || ''))
  }
  if (action === 'reject') {
    return rejectPlaybookShadow(String(body?.key || ''))
  }
  if (action === 'rollback') {
    return rollbackPlaybookActive(String(body?.key || ''))
  }
  if (action === 'save_shadow') {
    const rec = savePlaybookEvolved({
      startUrl: String(body?.startUrl || ''),
      taskKind: String(body?.taskKind || 'unknown'),
      plan_steps: Array.isArray(body?.plan_steps) ? (body!.plan_steps as any) : [],
    })
    return { ok: Boolean(rec), record: rec }
  }
  if (action === 'verify') {
    return verifyLobsterPlaybookStructure({
      host: String(body?.host || ''),
      plan_steps: Array.isArray(body?.plan_steps) ? (body!.plan_steps as any) : [],
    })
  }
  return { ok: false, reason: 'unknown_action' }
})
