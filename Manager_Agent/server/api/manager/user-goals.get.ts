import path from 'node:path'
import { z } from 'zod'
import { buildUserGoalsDashboard, isUserGoalsEnabled, loadUserGoals } from '../../graph/core/task/userGoals'
import { resolveManagerHttpUser } from '../../utils/platform/managerRequestUser'

const SessionIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const policyDir = path.join(process.cwd(), '.data')

  if (!isUserGoalsEnabled()) {
    return { ok: true, enabled: false, goals: [], userId: null }
  }

  const auth = resolveManagerHttpUser(event, query.userId ? String(query.userId) : undefined)
  const userId = auth.userId

  if (query.dashboard === '1' || query.dashboard === 'true') {
    const dashboard = await buildUserGoalsDashboard(policyDir, userId)
    return { ok: true, dashboard }
  }

  if (query.sessionId) SessionIdSchema.parse(String(query.sessionId))
  if (!userId) {
    return { ok: true, enabled: true, userId: null, goals: [] }
  }
  const store = await loadUserGoals(policyDir, userId)
  return { ok: true, enabled: true, userId, goals: store.goals, updatedAt: store.updatedAt }
})
