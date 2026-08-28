import { z } from 'zod'
import { processManagerFeedback } from './processManagerFeedback'
import { appendRouteWrongFeedback } from '../../utils/route/managerRouteFeedbackStore'
import { routeWrongFeedbackKey, upsertSessionFeedback } from '#agent-shared/sessionFeedbackStore'

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  tenantId: z.string().min(1).max(64).optional(),
  runId: z.string().min(1).max(80).optional(),
  turnId: z.number().int().min(0).max(5000).optional(),
  userMessageIndex: z.number().int().min(0).max(500).optional(),
  score: z.union([z.literal(0), z.literal(1), z.number()]).optional(),
  kind: z.enum(['score', 'route_wrong']).optional(),
  artifact: z.record(z.unknown()).optional(),
  userTask: z.string().max(2000).optional(),
  cap: z.array(z.string()).optional(),
  intent: z.string().max(120).optional(),
  orchestratorSource: z.string().max(120).optional(),
  lintIssues: z.array(z.string()).optional()
})

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event))
  const kind = body.kind ?? 'score'

  if (kind === 'route_wrong') {
    const uidx =
      typeof body.userMessageIndex === 'number' && Number.isFinite(body.userMessageIndex)
        ? Math.floor(body.userMessageIndex)
        : null
    try {
      await appendRouteWrongFeedback({
        sessionId: body.sessionId,
        userId: body.userId,
        runId: body.runId ? String(body.runId) : undefined,
        turnId: body.turnId,
        userMessageIndex: uidx ?? undefined,
        comment: '路由不对',
        userTask: body.userTask,
        cap: body.cap,
        intent: body.intent,
        orchestratorSource: body.orchestratorSource,
        lintIssues: body.lintIssues
      })
      if (uidx != null && uidx >= 0) {
        await upsertSessionFeedback({
          agent: 'manager',
          sessionId: body.sessionId,
          tenantId: body.tenantId,
          feedbackKey: routeWrongFeedbackKey(uidx),
          score: 0,
          userMessageIndex: uidx,
          runId: body.runId ? String(body.runId) : null,
          turnId: body.turnId ?? null,
          comment: 'route_wrong',
          artifact: {
            routeWrong: true,
            cap: body.cap,
            intent: body.intent
          }
        }).catch(() => false)
      }
      return {
        ok: true,
        kind: 'route_wrong',
        userMessageIndex: uidx,
        note: '已记录路由纠错反馈，将进入人工/CI 复核队列（不直接改 Bandit）。'
      }
    } catch (e: unknown) {
      throw createError({
        statusCode: 500,
        statusMessage: String((e as Error)?.message || e || 'route_feedback_failed')
      })
    }
  }

  const result = await processManagerFeedback({
    sessionId: body.sessionId,
    userId: body.userId,
    tenantId: body.tenantId,
    runId: body.runId,
    turnId: body.turnId,
    userMessageIndex: body.userMessageIndex,
    score: body.score,
    artifact: body.artifact ?? null
  })

  if (!result.ok) {
    throw createError({
      statusCode: 400,
      statusMessage: result.error || 'feedback_save_failed'
    })
  }

  return {
    ok: true,
    kind: 'score',
    feedbackScore: result.feedbackScore,
    feedbackKey: result.feedbackKey,
    userMessageIndex: result.userMessageIndex,
    runId: result.runId,
    learningPatched: result.learningPatched,
    compositeScore: result.compositeScore,
    weightsTuned: result.weightsTuned,
    experiencePromoted: result.experiencePromoted,
    experienceIndexed: result.experienceIndexed,
    note: result.note
  }
})
