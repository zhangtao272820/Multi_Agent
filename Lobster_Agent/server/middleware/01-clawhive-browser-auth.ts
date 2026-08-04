/**
 * 业务 API：ClawHive JWT 或 internal token；health/ready/metrics 放行。
 */
import {
  isPublicAgentPath,
  requireBrowserOrInternalAuth
} from '#agent-shared/nitroClawhiveAuth'

export default defineEventHandler((event) => {
  const path = String(event.path || event.node?.req?.url || '').split('?')[0] || ''
  if (!path.startsWith('/api/') && !path.startsWith('/_ws') && path !== '/_ws') return
  if (isPublicAgentPath(path)) return
  if (path.endsWith('/health') || path.endsWith('/ready')) return

  requireBrowserOrInternalAuth(event, {
    createError: (input) => {
      throw createError({ statusCode: input.statusCode, statusMessage: input.statusMessage })
    }
  })
})
