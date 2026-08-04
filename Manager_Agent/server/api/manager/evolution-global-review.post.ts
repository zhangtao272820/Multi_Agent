import { z } from 'zod'
import { reviewGlobalCandidate } from '../../graph/core/evolution/globalEvolutionBridge'

const BodySchema = z.object({
  id: z.union([z.string(), z.number()]),
  decision: z.enum(['approved', 'rejected']),
  reviewer: z.string().min(1).max(128).optional(),
  note: z.string().max(500).optional()
})

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event))
  const reviewer = body.reviewer || 'platform'
  const result = await reviewGlobalCandidate({
    id: body.id,
    decision: body.decision,
    reviewer,
    note: body.note
  })
  if (!result.ok) {
    throw createError({ statusCode: 400, statusMessage: result.reason || 'review_failed' })
  }
  return { ok: true, ...result }
})
