import { defineEventHandler, readBody, createError, setResponseStatus } from 'h3'
import * as z from 'zod'
import { resolveCodeExecutionPlan } from '../utils/code_execution'
import { runComputeChat, shouldSkipManagerComputeOverhead } from '../utils/code_compute'
import { buildFullExperienceContext, recordQueryOutcome } from '../utils/code_learning'
import {
  formatInspectStrategyHint,
  resolvePromptAbVariant,
  recordPromptAbObservation,
} from '../utils/code_prompt_ab_router'
import { recordCodeQueryMetric } from '../utils/code_metrics'
import {
  buildCodeComputeAgentResult,
  buildCodeFailAgentResult,
  classifyCodeThrownError
} from '../utils/agent_result'
import { appendAgentTraceLog } from '../utils/trace_log'
import { ensureInternalAgentAccess } from '../utils/internal_auth'
import { applyPlatformRuntimeOverrides } from '../utils/platform_config'
import { mergeOpenAiRuntimeSecrets } from '../utils/runtime_secrets'
import { resolveAgentUsage } from '#agent-shared/agentUsage'

/**
 * 总管编排专用 compute：HTTP JSON，无 WebSocket / LangGraph。
 */
export default defineEventHandler(async (event) => {
  ensureInternalAgentAccess(event)
  const started = Date.now()
  const body = await readBody(event).catch(() => null)
  const parsed = z
    .object({
      message: z.string().min(1),
      threadId: z.string().optional(),
      managerTask: z.record(z.unknown()).optional(),
      manager_task_json: z.union([z.string(), z.record(z.unknown())]).optional(),
    })
    .safeParse(body)

  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid body' })
  }

  const runtime = mergeOpenAiRuntimeSecrets(await applyPlatformRuntimeOverrides(useRuntimeConfig() as any))
  const apiKey = runtime.openaiApiKey as string | undefined
  const baseURL = runtime.openaiBaseUrl as string | undefined
  const model = runtime.openaiModel as string | undefined
  if (!apiKey) throw createError({ statusCode: 500, statusMessage: 'Missing OPENAI_API_KEY' })
  if (!baseURL) throw createError({ statusCode: 500, statusMessage: 'Missing OPENAI_BASE_URL' })
  if (!model) throw createError({ statusCode: 500, statusMessage: 'Missing OPENAI_MODEL' })

  const embeddingModel =
    typeof runtime.openaiEmbeddingModel === 'string' && runtime.openaiEmbeddingModel
      ? String(runtime.openaiEmbeddingModel)
      : 'text-embedding-v1'

  const executionPlan = resolveCodeExecutionPlan({
    message: parsed.data.message,
    managerTask: parsed.data.managerTask,
    manager_task_json: parsed.data.manager_task_json,
  })

  if (executionPlan.taskKind !== 'compute') {
    throw createError({
      statusCode: 400,
      statusMessage: `task_kind=${executionPlan.taskKind} is not supported on /api/compute`,
    })
  }

  const traceId =
    String(event.node.req.headers['x-trace-id'] ?? event.node.req.headers['x-run-id'] ?? '').trim() ||
    undefined
  const sessionKey = String(parsed.data.threadId || 'manager-compute').trim() || 'manager-compute'
  const skipOverhead = shouldSkipManagerComputeOverhead(executionPlan)
  const promptAbVariant = skipOverhead ? 'control' : resolvePromptAbVariant(sessionKey, executionPlan.question)

  const noopDelta = () => {}
  const noopEvent = () => {}

  let experienceContext = ''
  if (!skipOverhead) {
    experienceContext = await buildFullExperienceContext({
      question: executionPlan.question,
      task_kind: 'compute',
      sessionKey,
      abVariant: promptAbVariant,
      embeddingConfig: { openaiApiKey: apiKey, openaiBaseUrl: baseURL, embeddingModel },
    })
  }

  try {
    const result = await runComputeChat({
      apiKey,
      baseURL,
      model,
      question: executionPlan.question,
      upstreamContext: executionPlan.upstreamContext,
      upstreamFacts: executionPlan.upstreamFacts,
      mustOutputs: executionPlan.mustOutputs,
      experienceContext,
      inspectStrategyHint: skipOverhead ? '' : formatInspectStrategyHint(promptAbVariant, 'compute'),
      sendDelta: noopDelta,
      sendEvent: noopEvent,
    })

    const ms = Date.now() - started
    const computeOk = Boolean(result.text)
    if (!skipOverhead) recordPromptAbObservation(promptAbVariant, computeOk)
    recordCodeQueryMetric({
      path: 'compute',
      ok: computeOk,
      ms,
      question: executionPlan.question,
      from_manager: executionPlan.fromManager,
    })
    recordQueryOutcome({
      question: executionPlan.question,
      task_kind: 'compute',
      ok: computeOk,
      from_manager: executionPlan.fromManager,
      ms,
    })

    const agentResult = buildCodeComputeAgentResult({
      answer: result.text,
      trace_id: traceId,
      ms,
      task_kind: 'compute',
      usage: resolveAgentUsage({ llmUsage: result.usage, answerText: result.text })
    })
    void appendAgentTraceLog({
      agent: 'code',
      path: '/api/compute',
      trace_id: traceId,
      ok: agentResult.ok,
      latency_ms: ms,
      detail: `from_manager=${executionPlan.fromManager} skip_overhead=${skipOverhead}`,
    })

    return {
      ok: computeOk,
      answer: result.text,
      ms,
      meta: { task_kind: 'compute', from_manager: executionPlan.fromManager, skip_overhead: skipOverhead },
      agentResult,
      trace_id: traceId,
    }
  } catch (e: unknown) {
    const ms = Date.now() - started
    const errMsg = String((e as Error)?.message || e || 'compute failed')
    const error_code = classifyCodeThrownError(e)
    recordCodeQueryMetric({
      path: 'compute',
      ok: false,
      ms,
      question: executionPlan.question,
      from_manager: executionPlan.fromManager,
      reason: error_code,
    })
    void appendAgentTraceLog({
      agent: 'code',
      path: '/api/compute',
      trace_id: traceId,
      ok: false,
      latency_ms: ms,
      detail: `error_code=${error_code}`,
    })
    if (/403|AllocationQuota|free quota|免费额度|FreeTierOnly/i.test(errMsg)) {
      throw createError({
        statusCode: 403,
        statusMessage:
          `DashScope 模型调用被拒绝（model=${model}）：免费额度已用尽或控制台开启了「仅使用免费额度」。请开通付费/关闭该限制，或改用有余额的模型。模型名由 .env.capability-models 经 apply-capability-models 同步到本服务 .env。`,
      })
    }
    // 契约失败体：供总管 wrap / U2，避免无码 500
    setResponseStatus(event, 200)
    return {
      ok: false,
      answer: '',
      ms,
      meta: { task_kind: 'compute', from_manager: executionPlan.fromManager, error: errMsg.slice(0, 400) },
      agentResult: buildCodeFailAgentResult({
        error_code,
        answer: errMsg.slice(0, 400),
        trace_id: traceId,
        ms,
        structured: { task_kind: 'compute' },
      }),
      error_code,
      trace_id: traceId,
    }
  }
})
