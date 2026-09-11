/**
 * RAG 入库作业队列：默认内存（smoke / 无 Redis）；
 * REDIS_URL + RAG_ASYNC_INGEST=1 时用 BullMQ（动态 import）。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { QUEUE_NAMES, jobStatusKey, normalizeQueueTenantId } from '#agent-shared/jobQueueKeys'

export type RagIngestJobStatus = 'queued' | 'active' | 'completed' | 'failed'

export type RagIngestJobRecord = {
  jobId: string
  status: RagIngestJobStatus
  tenantId: string
  userId?: string
  fileName: string
  filePath: string
  sourceVersion?: string
  forceReembed?: boolean
  enqueuedAt: number
  startedAt?: number
  finishedAt?: number
  chunks?: number
  error?: string
}

type EnqueueInput = {
  tenantId?: string
  userId?: string
  fileName: string
  buffer: Buffer
  sourceVersion?: string
  forceReembed?: boolean
}

const memoryJobs = new Map<string, RagIngestJobRecord>()
const memoryQueue: string[] = []
let memoryDraining = false
let processHandler: ((job: RagIngestJobRecord) => Promise<number>) | null = null

function asyncIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RAG_ASYNC_INGEST ?? '').trim()
  if (v === '0' || v.toLowerCase() === 'false') return false
  if (v === '1' || v.toLowerCase() === 'true') return true
  // 有 REDIS_URL 时默认开异步
  return Boolean(String(env.REDIS_URL || env.RAG_REDIS_URL || '').trim())
}

export function isRagAsyncIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return asyncIngestEnabled(env)
}

function stagingDir(): string {
  return path.resolve(process.cwd(), '.data', 'ingest-staging')
}

async function writeStagingFile(jobId: string, fileName: string, buffer: Buffer): Promise<string> {
  const dir = stagingDir()
  await fs.mkdir(dir, { recursive: true })
  const safe = String(fileName || 'upload').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180)
  const filePath = path.join(dir, `${jobId}__${safe}`)
  await fs.writeFile(filePath, buffer)
  return filePath
}

/** 注册实际处理函数（API 进程与 worker 共用） */
export function registerRagIngestProcessor(fn: (job: RagIngestJobRecord) => Promise<number>): void {
  processHandler = fn
  void drainMemoryQueue()
}

export async function enqueueRagIngestJob(input: EnqueueInput): Promise<RagIngestJobRecord> {
  const jobId = randomUUID()
  const tenantId = normalizeQueueTenantId(input.tenantId)
  const filePath = await writeStagingFile(jobId, input.fileName, input.buffer)
  const rec: RagIngestJobRecord = {
    jobId,
    status: 'queued',
    tenantId,
    userId: input.userId,
    fileName: input.fileName,
    filePath,
    sourceVersion: input.sourceVersion,
    forceReembed: input.forceReembed,
    enqueuedAt: Date.now()
  }
  memoryJobs.set(jobId, rec)

  const redisUrl = String(process.env.REDIS_URL || process.env.RAG_REDIS_URL || '').trim()
  const forceMemory = String(process.env.RAG_FORCE_MEMORY_QUEUE || '').trim() === '1'
  if (redisUrl && asyncIngestEnabled() && !forceMemory) {
    try {
      const bullmq = await import('bullmq')
      const connection = { url: redisUrl }
      const queue = new bullmq.Queue(QUEUE_NAMES.ragIngest, { connection })
      await queue.add(
        'ingest',
        {
          jobId,
          tenantId,
          userId: input.userId,
          fileName: input.fileName,
          filePath,
          sourceVersion: input.sourceVersion,
          forceReembed: input.forceReembed,
          enqueuedAt: rec.enqueuedAt
        },
        { jobId, removeOnComplete: 100, removeOnFail: 50 }
      )
      await queue.close()
      return { ...rec }
    } catch (e: any) {
      console.warn('[rag-ingest] BullMQ unavailable, fallback memory queue:', e?.message || e)
    }
  }

  memoryQueue.push(jobId)
  void drainMemoryQueue()
  // 返回快照，避免 drain 异步改写同一对象导致调用方读到 completed
  return { ...rec }
}

export function getRagIngestJob(jobId: string): RagIngestJobRecord | null {
  return memoryJobs.get(String(jobId || '').trim()) || null
}

export async function getRagIngestJobAsync(jobId: string): Promise<RagIngestJobRecord | null> {
  const local = getRagIngestJob(jobId)
  if (local) return local
  const redisUrl = String(process.env.REDIS_URL || process.env.RAG_REDIS_URL || '').trim()
  if (!redisUrl) return null
  try {
    const { createClient } = await import('redis')
    const client = createClient({ url: redisUrl })
    await client.connect()
    const raw = await client.get(jobStatusKey(jobId))
    await client.quit()
    if (!raw) return null
    return JSON.parse(raw) as RagIngestJobRecord
  } catch {
    return null
  }
}

async function persistJobStatus(rec: RagIngestJobRecord): Promise<void> {
  memoryJobs.set(rec.jobId, { ...rec })
  const redisUrl = String(process.env.REDIS_URL || process.env.RAG_REDIS_URL || '').trim()
  if (!redisUrl) return
  try {
    const { createClient } = await import('redis')
    const client = createClient({ url: redisUrl })
    await client.connect()
    await client.set(jobStatusKey(rec.jobId), JSON.stringify(rec), { EX: 86400 })
    await client.quit()
  } catch {
    /* ignore */
  }
}

async function runOneJob(jobId: string): Promise<void> {
  const rec = memoryJobs.get(jobId)
  if (!rec || !processHandler) return
  rec.status = 'active'
  rec.startedAt = Date.now()
  await persistJobStatus(rec)
  try {
    const chunks = await processHandler(rec)
    rec.status = 'completed'
    rec.chunks = chunks
    rec.finishedAt = Date.now()
    await persistJobStatus(rec)
    try {
      await fs.unlink(rec.filePath)
    } catch {
      /* ignore */
    }
  } catch (e: any) {
    rec.status = 'failed'
    rec.error = String(e?.message || e || 'ingest failed').slice(0, 800)
    rec.finishedAt = Date.now()
    await persistJobStatus(rec)
  }
}

async function drainMemoryQueue(): Promise<void> {
  if (memoryDraining || !processHandler) return
  memoryDraining = true
  try {
    while (memoryQueue.length) {
      const id = memoryQueue.shift()
      if (id) await runOneJob(id)
    }
  } finally {
    memoryDraining = false
  }
}

/** Worker 入口：消费 BullMQ；无 Redis 时仅 drain 内存队列 */
export async function startRagIngestWorkerLoop(): Promise<void> {
  if (!processHandler) {
    throw new Error('registerRagIngestProcessor required before worker start')
  }
  const redisUrl = String(process.env.REDIS_URL || process.env.RAG_REDIS_URL || '').trim()
  if (!redisUrl || !asyncIngestEnabled()) {
    console.log('[rag-ingest-worker] memory mode (no REDIS_URL or async off)')
    setInterval(() => void drainMemoryQueue(), 1000)
    return
  }
  try {
    const bullmq = await import('bullmq')
    const worker = new bullmq.Worker(
      QUEUE_NAMES.ragIngest,
      async (job) => {
        const data = job.data as RagIngestJobRecord
        const rec: RagIngestJobRecord = {
          jobId: data.jobId || String(job.id),
          status: 'queued',
          tenantId: normalizeQueueTenantId(data.tenantId),
          userId: data.userId,
          fileName: data.fileName,
          filePath: data.filePath,
          sourceVersion: data.sourceVersion,
          forceReembed: data.forceReembed,
          enqueuedAt: data.enqueuedAt || Date.now()
        }
        memoryJobs.set(rec.jobId, rec)
        await runOneJob(rec.jobId)
        const done = memoryJobs.get(rec.jobId)
        if (done?.status === 'failed') throw new Error(done.error || 'ingest failed')
        return { chunks: done?.chunks || 0 }
      },
      {
        connection: { url: redisUrl },
        concurrency: Math.max(1, Number(process.env.RAG_INGEST_MAX_INFLIGHT || 2) || 2)
      }
    )
    worker.on('failed', (job, err) => {
      console.error('[rag-ingest-worker] failed', job?.id, err?.message || err)
    })
    console.log('[rag-ingest-worker] BullMQ listening', QUEUE_NAMES.ragIngest)
  } catch (e: any) {
    console.warn('[rag-ingest-worker] BullMQ start failed, memory fallback:', e?.message || e)
    setInterval(() => void drainMemoryQueue(), 1000)
  }
}

/** smoke：重置内存队列 */
export function resetRagIngestJobsForTests(): void {
  memoryJobs.clear()
  memoryQueue.length = 0
  memoryDraining = false
}
