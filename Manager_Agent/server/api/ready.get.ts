import { getAmpSummary } from '#agent-shared/agentMemoryPolicy'
import { getManagerWsAuthConfigStatus } from '../graph/core/runtime/wsAuth'
import { getManagerMemoryStatus } from '../utils/session/managerSessionStore'

/** 总管 probe：health=进程存活，ready=记忆存储后端可达（postgres 模式需 PG ping）+ 鉴权配置完整 */
export default defineEventHandler(async () => {
  const memory = await getManagerMemoryStatus()
  const amp = getAmpSummary()
  const auth = getManagerWsAuthConfigStatus()
  const memoryReady =
    memory.backend === 'file' ||
    (memory.backend === 'dual' && (!memory.pgConfigured || memory.pgReachable)) ||
    (memory.backend === 'postgres' && memory.pgConfigured && memory.pgReachable)
  const ready = memoryReady && auth.ok

  if (!auth.ok) {
    console.error(
      '[manager ready] WS 鉴权已启用但未配置 MANAGER_WS_TOKEN（或 CLAWHIVE_INTERNAL_TOKEN / MANAGER_OPS_TOKEN）'
    )
  }

  return {
    ok: ready,
    ready,
    service: 'manager_agent',
    auth: {
      required: auth.required,
      hasToken: auth.hasToken,
      ok: auth.ok,
      detail: auth.detail
    },
    memory: {
      backend: memory.backend,
      pgConfigured: memory.pgConfigured,
      pgReachable: memory.pgReachable,
      policyVersion: amp.version
    },
    detail: !auth.ok
      ? auth.detail
      : ready
        ? `memory_${memory.backend}`
        : `memory_${memory.backend}_pg_unreachable`,
    ts: new Date().toISOString()
  }
})
