import { z } from 'zod'
import { MediaAttachmentSchema } from '../../utils/media/mediaAttachment'

export const SessionIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)

export const ForceIntentSchema = z.enum(['auto', 'db', 'rag', 'multimodal', 'music', 'video']).default('auto')
export const HumanDecisionSchema = z.enum(['confirm', 'cancel'])

export const RunIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)

export const UserIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

export const TenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional()

export const TraceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional()

export const IncomingMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resume'),
    sessionId: SessionIdSchema,
    userId: UserIdSchema.optional(),
    tenantId: TenantIdSchema,
    traceId: TraceIdSchema
  }),
  z.object({
    type: z.literal('clear_experience'),
    sessionId: SessionIdSchema,
    userId: UserIdSchema.optional(),
    tenantId: TenantIdSchema
  }),
  z.object({
    type: z.literal('chat'),
    sessionId: SessionIdSchema,
    userId: UserIdSchema.optional(),
    tenantId: TenantIdSchema,
    traceId: TraceIdSchema,
    text: z.string().max(8000).default(''),
    dbId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    forceIntent: ForceIntentSchema.optional(),
    attachment: MediaAttachmentSchema.optional(),
    mode: z.enum(['normal', 'regenerate', 'edit_resend']).optional(),
    userMessageIndex: z.number().int().min(0).max(199).optional(),
    /** edit_resend：用于定位旧锚点的原文（text 字段是新内容） */
    anchorText: z.string().max(8000).optional(),
    clientContext: z.record(z.unknown()).optional()
  }),
  z.object({
    type: z.literal('human_confirm'),
    sessionId: SessionIdSchema,
    decision: HumanDecisionSchema,
    runId: RunIdSchema.optional(),
    confirmId: z.string().min(1).max(120).optional()
  }),
  z.object({
    type: z.literal('plan_confirm'),
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    previewId: z.string().min(1).max(120),
    action: z.enum(['execute', 'cancel']),
    steps: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          agent: z.string().min(1).max(32),
          query: z.string().max(2000).default(''),
          dependsOn: z.array(z.string()).optional(),
          parallelGroup: z.string().optional(),
          enabled: z.boolean().optional()
        })
      )
      .max(24)
      .optional(),
    /** Plan Mode：用户补充的执行约束（写入 meta.planConstraints） */
    constraints: z.string().max(500).optional()
  }),
  z.object({ type: z.literal('cancel'), sessionId: SessionIdSchema, runId: RunIdSchema.optional() }),
  z.object({
    type: z.literal('withdraw_turn'),
    sessionId: SessionIdSchema,
    userId: UserIdSchema.optional(),
    userMessageIndex: z.number().int().min(0).max(199).optional(),
    text: z.string().max(8000).optional()
  }),
  z.object({
    type: z.literal('feedback'),
    sessionId: SessionIdSchema,
    userId: UserIdSchema.optional(),
    runId: RunIdSchema,
    turnId: z.number().int().min(0).max(500).optional(),
    userMessageIndex: z.number().int().min(0).max(199).optional(),
    score: z.union([z.number(), z.string(), z.boolean(), z.null(), z.undefined()]).optional(),
    rating: z.union([z.number(), z.string(), z.boolean(), z.null(), z.undefined()]).optional(),
    value: z.union([z.number(), z.string(), z.boolean(), z.null(), z.undefined()]).optional(),
    artifact: z.record(z.unknown()).optional()
  }),
  z.object({
    type: z.literal('route_feedback'),
    sessionId: SessionIdSchema,
    userId: UserIdSchema.optional(),
    runId: RunIdSchema,
    turnId: z.number().int().min(0).max(500).optional(),
    userMessageIndex: z.number().int().min(0).max(199).optional(),
    comment: z.string().max(800).optional(),
    userTask: z.string().max(2000).optional(),
    cap: z.array(z.string().max(32)).max(16).optional(),
    intent: z.string().max(64).optional(),
    orchestratorSource: z.string().max(120).optional(),
    lintIssues: z.array(z.string().max(400)).max(12).optional()
  })
])
