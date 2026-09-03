import { z } from 'zod'
import path from 'node:path'
import { readHistoryEntries } from '../../graph/core/shared'
import { normalizeFeedbackScore } from '../../graph/core/runtime/runtimePersistence'
import { listSessionFeedback } from '#agent-shared/sessionFeedbackStore'
import {
  assertManagerSessionAccess,
  resolveManagerHttpUser
} from '../../utils/platform/managerRequestUser'
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'

const QuerySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional()
})

export default defineEventHandler(async (event) => {
  const query = QuerySchema.parse(getQuery(event))
  const auth = resolveManagerHttpUser(event, query.userId)
  await assertManagerSessionAccess({ sessionId: query.sessionId, userId: auth.userId })

  const pgItems = await listSessionFeedback('manager', query.sessionId)
  if (pgItems.length) {
    return {
      items: pgItems
        .filter((it) => it.feedbackKey || it.runId)
        .map((it) => ({
          runId: it.runId || it.feedbackKey,
          feedbackKey: it.feedbackKey,
          turnId: it.turnId,
          userMessageIndex: it.userMessageIndex,
          score: (it.score === 0 || it.score === 1 ? it.score : null) as 0 | 1 | null,
          comment: it.comment,
          ts: it.updatedAt
        }))
        .filter((it) => it.score === 0 || it.score === 1 || String(it.comment || '') === 'route_wrong')
    }
  }

  // 与 processManagerFeedback 写入同一租户目录（MGR_TENANT_SCOPE=1 时为 .data/tenants/{id}）
  const dir = resolveManagerPolicyDir(auth.tenantId)
  const jsonlPath = path.join(dir, 'manager-memory.jsonl')
  const jsonPath = path.join(dir, 'manager-memory.json')
  const history = await readHistoryEntries(jsonlPath, jsonPath, 800)
  const byRunId = new Map<string, { runId: string; score: 0 | 1; ts: string }>()

  for (const h of history) {
    if (String(h?.type || '') !== 'feedback') continue
    if (String(h?.sessionId || '') !== query.sessionId) continue
    const runId = String(h?.runId || '').trim()
    if (!runId) continue
    const score = normalizeFeedbackScore(h?.score ?? h?.rating ?? h?.value)
    if (score !== 0 && score !== 1) continue
    const ts = String(h?.ts || new Date().toISOString())
    const prev = byRunId.get(runId)
    if (!prev || ts >= prev.ts) {
      byRunId.set(runId, { runId, score: score as 0 | 1, ts })
    }
  }

  return { items: [...byRunId.values()] }
})
