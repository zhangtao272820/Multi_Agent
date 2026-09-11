/**
 * RAG 入库队列契约 smoke：enqueue → fake processor → completed（无 MinerU / 无 LLM）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  enqueueRagIngestJob,
  getRagIngestJob,
  registerRagIngestProcessor,
  resetRagIngestJobsForTests
} from '../server/utils/ragIngestJobs'
import { resetRagPoolGateForTests, withRagPoolSlot } from '../server/utils/ragPoolGate'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

resetRagIngestJobsForTests()
resetRagPoolGateForTests()
delete process.env.REDIS_URL
delete process.env.RAG_REDIS_URL
process.env.RAG_ASYNC_INGEST = '1'
process.env.RAG_FORCE_MEMORY_QUEUE = '1'

let processed = 0
registerRagIngestProcessor(async (job) => {
  const buf = await fs.readFile(job.filePath)
  assert(buf.length > 0, 'staging file readable')
  assert(job.tenantId === 'tenant-a', 'tenant preserved')
  processed += 1
  return 3
})

const job = await enqueueRagIngestJob({
  tenantId: 'tenant-a',
  fileName: 'smoke.txt',
  buffer: Buffer.from('hello ingest queue', 'utf8')
})
assert(job.jobId, 'jobId')
assert(['queued', 'active', 'completed'].includes(String(job.status)), `status=${job.status}`)

for (let i = 0; i < 50; i++) {
  const cur = getRagIngestJob(job.jobId)
  if (cur?.status === 'completed' || cur?.status === 'failed') break
  await new Promise((r) => setTimeout(r, 20))
}
const done = getRagIngestJob(job.jobId)
assert(done?.status === 'completed', `status=${done?.status}`)
assert(done?.chunks === 3, 'chunks')
assert(processed === 1, 'processed once')

process.env.RAG_CHAT_MAX_INFLIGHT = '1'
process.env.RAG_CHAT_MAX_INFLIGHT_PER_TENANT = '1'
resetRagPoolGateForTests()
let held = false
const p1 = withRagPoolSlot('rag_chat', 't1', async () => {
  held = true
  await new Promise((r) => setTimeout(r, 80))
  return 'ok'
})
await new Promise((r) => setTimeout(r, 10))
assert(held, 'slot held')
let rejected = false
try {
  await withRagPoolSlot('rag_chat', 't1', async () => 'nope')
} catch (e: any) {
  rejected = e?.code === 'rag_pool_overloaded' || e?.statusCode === 429
}
assert(rejected, 'second slot rejected')
assert((await p1) === 'ok', 'first finished')

delete process.env.RAG_ASYNC_INGEST
delete process.env.RAG_CHAT_MAX_INFLIGHT
delete process.env.RAG_CHAT_MAX_INFLIGHT_PER_TENANT
resetRagIngestJobsForTests()
resetRagPoolGateForTests()
console.log('smoke-rag-ingest-queue: ok')
