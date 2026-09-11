/**
 * 注册入库处理器；API 进程也可在无独立 worker 时内存 drain。
 */
import { registerRagIngestProcessor, startRagIngestWorkerLoop } from '../utils/ragIngestJobs'
import { processRagIngestJobRecord } from '../utils/ragIngestProcessor'

export default defineNitroPlugin(() => {
  registerRagIngestProcessor(processRagIngestJobRecord)
  if (String(process.env.RAG_ROLE || '').trim().toLowerCase() === 'worker') {
    void startRagIngestWorkerLoop()
  }
})
