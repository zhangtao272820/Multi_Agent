import { recallProcessMemory } from '#agent-shared/processMemoryStore'
import { requireTenantId, ScopeRequiredError } from '#agent-shared/tenantScope'
import { resolveManagerHttpUser } from '../../utils/platform/managerRequestUser'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const question = String(query.q ?? query.question ?? '').trim()
  const scenarioKey = String(query.scenario_key ?? query.scenarioKey ?? '').trim()
  const limitRaw = Number(query.limit)
  const limit = Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 5

  if (!question) {
    throw createError({ statusCode: 400, statusMessage: 'q 不能为空' })
  }

  const auth = resolveManagerHttpUser(event)
  let tenantId: string
  try {
    tenantId = requireTenantId(auth.tenantId || query.tenant_id || query.tenantId)
  } catch (e) {
    if (e instanceof ScopeRequiredError) {
      throw createError({ statusCode: 401, statusMessage: 'tenant_required' })
    }
    throw e
  }

  const items = await recallProcessMemory(question, {
    tenantId,
    scenarioKey: scenarioKey || undefined,
    limit
  })
  return { ok: true, tenantId, count: items.length, items }
})
