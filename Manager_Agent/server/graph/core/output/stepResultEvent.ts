import type { AgentStepOutcome } from '../executors'
import { errorCodeFromStepOutcome } from '../runtime/expertFailure'
import { buildStepStatus } from '../runtime/stepStatus'

const AGENT_LABELS: Record<string, string> = {
  db: '数据库查询',
  rag: '知识库检索',
  crawler: '网页采集',
  code: '数据计算',
  clean: '数据清洗',
  visualize: '图表生成',
  report: '分析报告',
  admin: '个人事务',
  gui: '浏览器操作',
  multimodal: '多媒体理解',
  music: '音乐生成',
  video: '视频生成'
}

export type StepResultPayload = {
  stepId: string
  agent: string
  status: 'success' | 'failed'
  title: string
  preview: string
  query?: string
  error?: string
  /** U2：与 observabilitySchema ExpertErrorCode 对齐 */
  errorCode?: string
  empty?: boolean
  ragCitations?: Array<{ source: string; excerpt?: string }>
  runId?: string
}


function extractRagCitations(outcome: AgentStepOutcome): StepResultPayload['ragCitations'] {
  const ev = outcome.evidence as Record<string, unknown> | undefined
  if (!ev) return undefined
  const fromCitations = Array.isArray(ev.citations)
    ? (ev.citations as Array<{ source?: string; excerpt?: string }>)
    : []
  if (fromCitations.length) {
    return fromCitations
      .map((c) => ({ source: String(c.source || '').trim(), excerpt: String(c.excerpt || '').trim().slice(0, 200) }))
      .filter((c) => c.source || c.excerpt)
      .slice(0, 6)
  }
  const agentResult = (outcome.meta as { agentResult?: { sources?: Array<{ ref?: string; type?: string }> } } | undefined)
    ?.agentResult
  const src = Array.isArray(agentResult?.sources) ? agentResult!.sources! : []
  const docs = src.filter((s) => String(s.type || '') === 'doc' || String(s.ref || '').trim())
  if (!docs.length) return undefined
  return docs
    .map((s) => ({ source: String(s.ref || '').trim() }))
    .filter((c) => c.source)
    .slice(0, 6)
}

export function buildStepResultPayload(input: {
  stepId: string
  agent: string
  outcome: AgentStepOutcome
  runId?: string
}): StepResultPayload {
  const { stepId, agent, outcome, runId } = input
  const preview = String(outcome.output || outcome.error || '').trim().slice(0, 520)
  const empty = Boolean((outcome.evidence as { empty?: boolean } | undefined)?.empty)
  const errorCode = outcome.ok
    ? undefined
    : errorCodeFromStepOutcome({
        ok: false,
        error: outcome.error,
        meta: outcome.meta,
        policy: String((outcome.meta as { policy?: string } | undefined)?.policy || '') || undefined
      })
  return {
    stepId,
    agent,
    status: outcome.ok ? 'success' : 'failed',
    title: AGENT_LABELS[agent] || agent,
    preview,
    query: String(outcome.query || '').slice(0, 240) || undefined,
    error: outcome.ok ? undefined : String(outcome.error || '').slice(0, 240) || undefined,
    errorCode: errorCode || undefined,
    empty: empty || undefined,
    ragCitations: agent === 'rag' ? extractRagCitations(outcome) : undefined,
    runId
  }
}


export function emitStepResultEvent(
  opts: { sendEvent: (event: { event: string; data?: unknown; from?: string }) => void; runId?: string; sessionId?: string; tenantId?: string },
  input: { stepId: string; agent: string; outcome: AgentStepOutcome; ms?: number }
) {
  const data = buildStepResultPayload({ ...input, runId: opts.runId })
  // 单步路径（ragNode/dbNode）只发 step_result 时 UI 会卡在 running：始终补发终态 step_status
  opts.sendEvent({
    event: 'step_status',
    data: buildStepStatus(
      {
        stepId: data.stepId,
        agent: data.agent,
        status: data.status,
        pct: data.status === 'success' ? 100 : undefined,
        error: data.error,
        query: data.query
      },
      opts.runId
    ),
    from: 'manager'
  })
  if (!data.preview && data.status === 'success') return
  opts.sendEvent({ event: 'step_result', data, from: 'manager' })
  if (opts.runId) {
    void Promise.all([
      import('#agent-shared/toolCallPolicyEngine'),
      import('#agent-shared/toolCallAuditStore')
    ])
      .then(async ([{ evaluateToolCallPolicy }, { recordToolCallAudit }]) => {
        const readOnly = Boolean(
          (input.outcome.evidence as { readOnly?: boolean } | undefined)?.readOnly ??
            (input.outcome.meta as { readOnly?: boolean } | undefined)?.readOnly
        )
        const risk =
          input.agent === 'gui'
            ? 'high'
            : input.agent === 'admin' && !readOnly
              ? 'high'
              : 'low'
        const policy = await evaluateToolCallPolicy({
          agent: input.agent,
          toolName: input.agent,
          ok: input.outcome.ok,
          sessionId: opts.sessionId,
          tenantId: opts.tenantId,
          risk: risk as 'high' | 'medium' | 'low',
          readOnly,
          metadata: { stepId: input.stepId, readOnly }
        })
        if (policy.audit || !policy.allow) {
          opts.sendEvent({
            event: 'policy_decision',
            data: { agent: input.agent, allow: policy.allow, matchedRules: policy.matchedRules, reasons: policy.reasons },
            from: 'manager'
          })
        }
        await recordToolCallAudit({
          runId: opts.runId!,
          sessionId: opts.sessionId,
          tenantId: opts.tenantId,
          agent: input.agent,
          toolName: input.agent,
          stepId: input.stepId,
          ok: input.outcome.ok,
          ms: input.ms,
          error: input.outcome.error,
          queryPreview: input.outcome.query,
          resultPreview: input.outcome.output,
          metadata: {
            empty: Boolean((input.outcome.evidence as { empty?: boolean })?.empty),
            evidenceKind: (input.outcome.evidence as { kind?: string })?.kind,
            policy: { allow: policy.allow, matchedRules: policy.matchedRules, reasons: policy.reasons }
          }
        })
      })
      .catch(() => undefined)
  }
}
