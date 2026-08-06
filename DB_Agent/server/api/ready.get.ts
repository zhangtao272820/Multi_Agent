import { getDataSource } from '../../utils/db'
import { getDbMemoryStatus } from '../../utils/learning_signal_store'
import { resolveAgentRuntimeConfig } from '../../utils/runtime'
import { getAmpSummary } from '#agent-shared/agentMemoryPolicy'
import { resolveInternalAuthReady } from '#agent-shared/nitroClawhiveAuth'

/** 总管 probe：health=进程存活，ready=MySQL 可 ping + 记忆后端就绪 + 鉴权可服务间调用 */
export default defineEventHandler(async (event) => {
  const runtimeConfig = useRuntimeConfig(event) as Record<string, unknown>
  const auth = resolveInternalAuthReady()
  try {
    const config = resolveAgentRuntimeConfig(runtimeConfig)
    const ds = await getDataSource(config)
    await ds.query('SELECT 1 AS ok')
    const dbName = String((ds.options as { database?: string })?.database ?? '')
    const memory = await getDbMemoryStatus()
    const amp = getAmpSummary()
    const memoryReady =
      memory.backend === 'file' ||
      (memory.backend === 'dual' && (!memory.pgConfigured || memory.pgReachable)) ||
      (memory.backend === 'postgres' && memory.pgConfigured && memory.pgReachable)
    const ready = memoryReady && auth.ok
    const detail = !auth.ok
      ? String(auth.detail || 'internal_token_missing_with_browser_auth')
      : ready
        ? 'mysql_ping'
        : `memory_${memory.backend}_pg_unreachable`
    return {
      ok: true,
      ready,
      service: 'db_agent',
      database: dbName,
      auth: {
        browserAuthEnabled: auth.browserAuthEnabled,
        internalTokenConfigured: auth.internalTokenConfigured
      },
      memory: {
        backend: memory.backend,
        pgConfigured: memory.pgConfigured,
        pgReachable: memory.pgReachable,
        policyVersion: amp.version
      },
      detail,
      ts: new Date().toISOString()
    }
  } catch (e: unknown) {
    const detail = String(e instanceof Error ? e.message : e ?? 'mysql_ping_failed').slice(0, 240)
    return {
      ok: false,
      ready: false,
      service: 'db_agent',
      auth: {
        browserAuthEnabled: auth.browserAuthEnabled,
        internalTokenConfigured: auth.internalTokenConfigured
      },
      detail,
      ts: new Date().toISOString()
    }
  }
})
