import { auditVectorStoreHealth, getUploadedDocuments, getVectorBackend, getVectorStore } from '../utils/vectorStore'
import { getRagMemoryStatus } from '../../utils/learning_signal_store'
import { getAmpSummary } from '#agent-shared/agentMemoryPolicy'
import { resolveInternalAuthReady } from '#agent-shared/nitroClawhiveAuth'
import { getRagAgentEnv } from '../utils/rag_agent_env'
import { probeMineruHealth } from '../utils/heavy_parse_client'

/** 总管 probe：health=进程存活，ready=向量库 + 记忆 PG 可达 + 鉴权；strict 时含 MinerU */
export default defineEventHandler(async () => {
  const auth = resolveInternalAuthReady()
  try {
    await getVectorStore()
    const backend = await getVectorBackend()
    const docs = await getUploadedDocuments()
    const audit = await auditVectorStoreHealth({ reconcile: true })
    const vectorReady = audit.consistent || (audit.metadataDocCount === 0 && (audit.vectorRowCount ?? 0) === 0)
    const memory = await getRagMemoryStatus()
    const amp = getAmpSummary()
    const memoryReady =
      memory.backend === 'file' ||
      (memory.backend === 'dual' && (!memory.pgConfigured || memory.pgReachable)) ||
      (memory.backend === 'postgres' && memory.pgConfigured && memory.pgReachable)

    const env = getRagAgentEnv()
    let heavyParse: { enabled: boolean; strict: boolean; ok: boolean | null; detail: string } = {
      enabled: env.enableHeavyParse,
      strict: env.heavyParseStrict,
      ok: null,
      detail: 'skipped',
    }
    if (env.enableHeavyParse && String(env.mineruApiUrl || '').trim()) {
      const probe = await probeMineruHealth({ timeoutMs: 4000 })
      heavyParse = {
        enabled: true,
        strict: env.heavyParseStrict,
        ok: probe.ok,
        detail: probe.detail,
      }
    } else if (env.enableHeavyParse) {
      heavyParse = {
        enabled: true,
        strict: env.heavyParseStrict,
        ok: false,
        detail: 'no_mineru_url',
      }
    }

    const heavyBlocksReady = env.heavyParseStrict && env.enableHeavyParse && heavyParse.ok !== true
    const ready = vectorReady && memoryReady && auth.ok && !heavyBlocksReady
    const error_code = !auth.ok
      ? 'auth_misconfigured'
      : heavyBlocksReady
        ? 'heavy_parse_not_ready'
        : !vectorReady
          ? 'vector_not_ready'
          : !memoryReady
            ? 'vector_not_ready'
            : undefined
    const detail = !auth.ok
      ? String(auth.detail || 'internal_token_missing_with_browser_auth')
      : heavyBlocksReady
        ? `mineru_${heavyParse.detail}`
        : ready
          ? `vector_${backend}_memory_${memory.backend}`
          : `vector_${vectorReady ? 'ok' : 'drift'}_memory_${memory.backend}`
    return {
      ok: true,
      ready,
      service: 'rag_agent',
      vectorBackend: backend,
      docCount: docs.length,
      audit,
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
      heavyParse,
      detail,
      ...(error_code ? { error_code } : {}),
      ts: new Date().toISOString()
    }
  } catch (e: unknown) {
    const detail = String(e instanceof Error ? e.message : e ?? 'vector_init_failed').slice(0, 240)
    return {
      ok: false,
      ready: false,
      service: 'rag_agent',
      auth: {
        browserAuthEnabled: auth.browserAuthEnabled,
        internalTokenConfigured: auth.internalTokenConfigured
      },
      detail,
      error_code: 'vector_not_ready',
      ts: new Date().toISOString()
    }
  }
})
