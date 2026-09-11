import { getRagIngestJobAsync } from '../utils/ragIngestJobs'

/** GET /api/ingest-job?jobId= */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const jobId = String(q.jobId || q.id || '').trim()
  if (!jobId) {
    throw createError({ statusCode: 400, statusMessage: 'jobId required' })
  }
  const job = await getRagIngestJobAsync(jobId)
  if (!job) {
    throw createError({ statusCode: 404, statusMessage: 'job not found' })
  }
  return {
    jobId: job.jobId,
    status: job.status,
    fileName: job.fileName,
    chunks: job.chunks,
    error: job.error,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  }
})
