/**
 * GET /api/auth/validate — 本容器本地验签（不依赖 clawhive_backend / 控制端）。
 */
import { buildLocalAuthValidateResponse } from '#agent-shared/nitroClawhiveAuth'

export default defineEventHandler((event) => {
  return buildLocalAuthValidateResponse(event)
})
