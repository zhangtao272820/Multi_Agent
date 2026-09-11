/**
 * 独立入库 worker（开发 / 非 Docker 入口）。
 * 生产 Docker 用同镜像 + RAG_ROLE=worker 跑 Nitro（见 compose）。
 */
import { registerRagIngestProcessor, startRagIngestWorkerLoop } from '../utils/ragIngestJobs'
import { processRagIngestJobRecord } from '../utils/ragIngestProcessor'

async function main() {
  process.env.RAG_ROLE = process.env.RAG_ROLE || 'worker'
  registerRagIngestProcessor(processRagIngestJobRecord)
  await startRagIngestWorkerLoop()
  console.log('[rag-ingest-worker] started')
  // keep process alive
  await new Promise(() => {})
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
