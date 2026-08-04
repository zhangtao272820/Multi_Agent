/**
 * Nitro：业务 API 要求 ClawHive JWT 或 internal token；探活路径放行。
 */
import {
  isPublicAgentPath,
  requireBrowserOrInternalAuth
} from '#agent-shared/nitroClawhiveAuth'

export default defineEventHandler((event) => {
  const path = String(event.path || event.node?.req?.url || '').split('?')[0] || ''
  if (!path.startsWith('/api/')) return
  if (isPublicAgentPath(path)) return
  // 静态与内部探活已在 isPublicAgentPath；MCP/metrics 子路径亦放行健康类
  if (path.endsWith('/health') || path.endsWith('/ready')) return

  requireBrowserOrInternalAuth(event, {
    createError: (input) => {
      throw createError({ statusCode: input.statusCode, statusMessage: input.statusMessage })
    }
  })
})
