import { promises as fs } from 'node:fs'
import { processDocument } from './vectorStore'
import { runWithRagTenant } from './ragTenantContext'
import { withRagPoolSlot } from './ragPoolGate'
import type { RagIngestJobRecord } from './ragIngestJobs'

export async function processRagIngestJobRecord(job: RagIngestJobRecord): Promise<number> {
  const buf = await fs.readFile(job.filePath)
  return await withRagPoolSlot('rag_ingest', job.tenantId, async () => {
    return await runWithRagTenant({ tenantId: job.tenantId, userId: job.userId }, async () => {
      return await processDocument(buf, job.fileName, undefined, {
        ...(job.sourceVersion ? { source_version: job.sourceVersion } : {}),
        ...(job.forceReembed ? { forceReembed: true } : {})
      })
    })
  })
}
