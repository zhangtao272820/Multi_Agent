import { auditVectorStoreHealth, getUploadedDocuments, getVectorBackend, getVectorStore } from '../utils/vectorStore'
import { getRagMemoryStatus } from '../../utils/learning_signal_store'
import { getAmpSummary } from '#agent-shared/agentMemoryPolicy'

/** 总管 probe：health=进程存活，ready=向量库 + 记忆 PG 可达 */
export default defineEventHandler(async () => {
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
    const ready = vectorReady && memoryReady
    const error_code = !vectorReady ? 'vector_not_ready' : !memoryReady ? 'vector_not_ready' : undefined
    return {
      ok: true,
      ready,
      service: 'rag_agent',
      vectorBackend: backend,
      docCount: docs.length,
      audit,
      memory: {
        backend: memory.backend,
        pgConfigured: memory.pgConfigured,
        pgReachable: memory.pgReachable,
        policyVersion: amp.version
      },
      detail: ready ? `vector_${backend}_memory_${memory.backend}` : `vector_${vectorReady ? 'ok' : 'drift'}_memory_${memory.backend}`,
      ...(error_code ? { error_code } : {}),
      ts: new Date().toISOString()
    }
  } catch (e: unknown) {
    const detail = String(e instanceof Error ? e.message : e ?? 'vector_init_failed').slice(0, 240)
    return {
      ok: false,
      ready: false,
      service: 'rag_agent',
      detail,
      error_code: 'vector_not_ready',
      ts: new Date().toISOString()
    }
  }
})
