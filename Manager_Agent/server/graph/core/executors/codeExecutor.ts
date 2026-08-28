import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { normalizeCodeOutputAsync } from '../../../utils/code/managerCodeAuthorityNormalize'
import { buildCodeEvidenceExtras, parseCodeClarifyFromMeta } from '../../../utils/code/managerCodeMeta'
import {
  buildManagerCodeTaskPayload,
  buildStructuredFactsFromResults,
  buildUpstreamContextFromResults,
  supplementCodeOutputFromUpstream
} from '../../../utils/code/managerCodeTaskPayload'
import { resolveManagerCodeTaskKind } from '../../../utils/code/resolveManagerCodeTaskKind'
import { resolveSubAgentTurnScope, resolveTurnScopeFromMeta } from '../runtime/sessionBridge'
import type { ManagerGraphState } from '../../state/state'
import { extractStructuredPayload } from '../shared'
import type { AgentExecutorDeps, AgentExecutorOpts, AgentStepOutcome } from './types'
import { isChatRevisionMeta } from './sharedHelpers'
import { tryDeterministicCodeFromDbResults, tryDeterministicStructuralCode } from '#agent-shared/dbPipelineDeterministic'
import {
  buildManagerTaskEnvelope,
  isManagerTaskEnvelopeV2Enabled,
  serializeManagerTaskEnvelope,
  type ManagerCodeTaskPayload
} from '#agent-shared/managerTaskEnvelope'
import { resolveBlastRadius } from '#agent-shared/blastRadius'
import { gateManagerEnvelopeBlastRadius } from '#agent-shared/envelopeBlastGate'
import { callCodeAssistMcpTask } from '../../../utils/mcp/managerMcpHost'
import {
  extractCodeEditPreview,
  isCodeEditHitlEnabled,
  requestCodeEditHumanConfirm,
} from '../../../utils/code/codeHumanConfirm'
import { restoreCodeAgentEditedFiles } from '../../../utils/code/codeAgentRestore'

export function isCodeMcpFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_CODE_MCP_FIRST ?? '0').trim() === '1'
}

async function maybeConfirmCodeEdit(input: {
  taskKind: string
  question: string
  meta?: Record<string, unknown> | null
  stateMeta?: unknown
  raw?: unknown
  opts: AgentExecutorOpts
  sendThinking: (t: string) => void
}): Promise<{ confirmed: boolean; outputSuffix?: string }> {
  if (input.taskKind !== 'edit' || !isCodeEditHitlEnabled()) return { confirmed: true }
  const preview = extractCodeEditPreview({ meta: input.meta, raw: input.raw })
  if (!preview?.files?.length) return { confirmed: true }
  const approved = await requestCodeEditHumanConfirm({
    runId: input.opts.runId,
    preview,
    task: input.question,
    meta: input.stateMeta,
    sendThinking: input.sendThinking,
    sendEvent: input.opts.sendEvent,
  })
  if (approved) return { confirmed: true }
  const restore = await restoreCodeAgentEditedFiles({
    codeAgentWsUrl: input.opts.codeAgentWsUrl,
    paths: preview.files,
    signal: input.opts.signal,
  })
  const suffix = restore.ok
    ? '\n\n（用户取消：已撤销 Code Agent 写盘变更）'
    : `\n\n（用户取消写盘，但撤销失败：${restore.error || 'unknown'}）`
  return { confirmed: false, outputSuffix: suffix }
}

export async function executeCodeStep(
  deps: AgentExecutorDeps,
  opts: AgentExecutorOpts,
  input: {
    state: ManagerGraphState
    effQuery: string
    out: Record<string, string>
    timeoutMs: number
    sendThinking: (t: string) => void
    sendDelta?: (d: string) => void
    message?: string
    taskKind?: 'compute' | string
    llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
  }
): Promise<AgentStepOutcome> {
  try {
    const mergedForDet = { ...(input.state.results || {}), ...input.out } as Record<string, unknown>
    const detCode =
      tryDeterministicCodeFromDbResults(mergedForDet, extractStructuredPayload) ??
      tryDeterministicStructuralCode(mergedForDet, extractStructuredPayload)
    const codeModel = createCodeAuthorityLlmModel({
      openaiApiKey: input.llm?.openaiApiKey,
      openaiBaseUrl: input.llm?.openaiBaseUrl,
      modelName: input.llm?.openaiModel || String((input.state.resources as { modelLowCost?: string } | undefined)?.modelLowCost ?? '')
    })
    if (detCode) {
      input.sendThinking('Code：上游结构化事实，确定性 JSON（跳过 Code Agent LLM）')
      const skipEnrich = String(process.env.MANAGER_CODE_SKIP_ENRICH ?? '1').trim() !== '0'
      const enrichedAnswer = skipEnrich
        ? detCode
        : await normalizeCodeOutputAsync(codeModel, detCode, extractStructuredPayload)
      if (!skipEnrich && enrichedAnswer !== detCode) {
        input.sendThinking('Code：启发模型校正输出结构（供图表/报告消费）')
      }
      return {
        ok: true,
        agent: 'code',
        output: enrichedAnswer,
        query: input.effQuery,
        parsed: extractStructuredPayload(enrichedAnswer),
        evidence: {
          kind: 'code',
          query: input.effQuery,
          threadId: opts.threadId,
          mode: skipEnrich ? 'structural_deterministic' : 'db_deterministic'
        }
      }
    }
    const mergedResults = { ...(input.state.results || {}), ...input.out }
    const upstreamContext = buildUpstreamContextFromResults(mergedResults)
    const structuredFacts = buildStructuredFactsFromResults(mergedResults)
    const question = input.effQuery
    const turn_scope = resolveSubAgentTurnScope(input.state.meta) ?? resolveTurnScopeFromMeta(input.state.meta)
    const resolvedTaskKind = resolveManagerCodeTaskKind({
      question,
      upstreamContext: upstreamContext || undefined,
      explicitTaskKind: input.taskKind,
      meta: input.state.meta
    })
    const managerTaskPayload =
      buildManagerCodeTaskPayload({
        question,
        upstreamContext: upstreamContext || undefined,
        facts: structuredFacts.length ? structuredFacts : undefined,
        taskKind: resolvedTaskKind,
        meta: input.state.meta,
        turnScope: turn_scope
      }) ?? undefined

    const envelope =
      isManagerTaskEnvelopeV2Enabled() && managerTaskPayload
        ? buildManagerTaskEnvelope({
            target_agent: 'code',
            trace_id: opts.runId,
            session_id: opts.sessionId || opts.threadId,
            utterance: question,
            turn_scope,
            blast_radius: resolveBlastRadius({
              agent: 'code',
              writeAllowed: Boolean((managerTaskPayload as ManagerCodeTaskPayload).write_allowed),
              actionKind:
                resolvedTaskKind === 'edit' || resolvedTaskKind === 'script' ? 'code_edit' : 'code_compute',
              dryRun: !Boolean((managerTaskPayload as ManagerCodeTaskPayload).write_allowed)
            }),
            confirm_token: String(
              (input.state.meta as { hitlConfirmToken?: string } | undefined)?.hitlConfirmToken || ''
            ).trim() || undefined,
            payload: { kind: 'code', data: managerTaskPayload as ManagerCodeTaskPayload }
          })
        : null

    if (envelope && managerTaskPayload) {
      const writeAllowed = Boolean((managerTaskPayload as ManagerCodeTaskPayload).write_allowed)
      const gate = gateManagerEnvelopeBlastRadius(envelope, {
        writeAllowed,
        auto_confirm: false,
        allow_t2_auto: false
      })
      if (!gate.ok && writeAllowed) {
        // T2 无 confirm_token：出站前剥掉 write_allowed（payload 可能是 envelope 浅拷贝，两边都写）
        ;(managerTaskPayload as ManagerCodeTaskPayload).write_allowed = false
        if (envelope.payload.kind === 'code') {
          envelope.payload.data.write_allowed = false
        }
        envelope.blast_radius = resolveBlastRadius({
          agent: 'code',
          writeAllowed: false,
          actionKind: 'code_edit',
          dryRun: true
        })
        delete envelope.confirm_token
        input.sendThinking(`Code：${gate.reason}（已降为预览，write_allowed=0）`)
      }
    }

    if (resolvedTaskKind !== 'compute') {
      input.sendThinking(`Code：task_kind=${resolvedTaskKind}（工程执行模式）`)
    }

    if (isCodeMcpFirstEnabled()) {
      try {
        input.sendThinking(`Code Agent：MCP 主路径（run_code_task · ${resolvedTaskKind}）…`)
        const mcpOut = await callCodeAssistMcpTask({
          message: input.message ?? question,
          managerTask: managerTaskPayload as Record<string, unknown> | undefined,
          managerTaskEnvelope: envelope ? serializeManagerTaskEnvelope(envelope) : undefined,
          threadId: opts.threadId,
        })
        if (!mcpOut.fallback && mcpOut.ok && mcpOut.text) {
          const raw =
            mcpOut.raw && typeof mcpOut.raw === 'object'
              ? (mcpOut.raw as Record<string, unknown>)
              : {}
          const artifacts =
            raw.artifacts && typeof raw.artifacts === 'object'
              ? (raw.artifacts as Record<string, unknown>)
              : {}
          const filesChanged = Array.isArray(artifacts.files_changed)
            ? artifacts.files_changed.map(String).filter(Boolean)
            : []
          const mcpMeta = {
            task_kind: resolvedTaskKind,
            files_touched: filesChanged,
            validate_ok: artifacts.validate_ok,
            unified_diff: artifacts.unified_diff,
            diff_stat: artifacts.diff_stat,
            branch: artifacts.branch,
            edit_preview: {
              files: filesChanged,
              unified_diff: artifacts.unified_diff ? String(artifacts.unified_diff) : undefined,
              diff_stat: artifacts.diff_stat ? String(artifacts.diff_stat) : undefined,
              branch: artifacts.branch ? String(artifacts.branch) : undefined,
            },
          }
          const hitl = await maybeConfirmCodeEdit({
            taskKind: resolvedTaskKind,
            question,
            meta: mcpMeta,
            stateMeta: input.state.meta,
            raw: mcpOut.raw,
            opts,
            sendThinking: input.sendThinking,
          })
          const supplemented = supplementCodeOutputFromUpstream(mcpOut.text, mergedResults) + (hitl.outputSuffix ?? '')
          return {
            ok: true,
            agent: 'code',
            output: supplemented,
            query: input.effQuery,
            parsed: extractStructuredPayload(supplemented),
            meta: mcpMeta,
            evidence: {
              kind: 'code',
              query: input.effQuery,
              threadId: opts.threadId,
              task_kind: resolvedTaskKind,
              transport: 'mcp',
              edit_confirmed: hitl.confirmed,
              ...buildCodeEvidenceExtras(mcpMeta),
            },
          }
        }
        if (mcpOut.fallback) {
          input.sendThinking('Code Agent：MCP 不支持该 task_kind，回退 WebSocket…')
        }
      } catch (mcpErr) {
        input.sendThinking(
          `Code Agent：MCP 失败，回退 WebSocket（${String((mcpErr as Error)?.message || mcpErr).slice(0, 120)}）`
        )
      }
    }

    const { answer, meta, transportMetrics } = await deps.callCodeAgent({
      codeAgentWsUrl: opts.codeAgentWsUrl,
      timeoutMs: input.timeoutMs,
      message: input.message ?? question,
      managerTask: managerTaskPayload,
      managerTaskEnvelope: envelope ? serializeManagerTaskEnvelope(envelope) : undefined,
      threadId: opts.threadId,
      traceId: opts.runId,
      skipCache: isChatRevisionMeta(input.state.meta),
      sendThinking: input.sendThinking,
      sendDelta: input.sendDelta,
      signal: opts.signal
    })
    const codeClarify = parseCodeClarifyFromMeta(meta)
    const supplemented = supplementCodeOutputFromUpstream(answer, mergedResults)
    const skipEnrich = String(process.env.MANAGER_CODE_SKIP_ENRICH ?? '1').trim() !== '0'
    const enrichedAnswer = skipEnrich
      ? supplemented
      : await normalizeCodeOutputAsync(codeModel, supplemented, extractStructuredPayload)
    if (!skipEnrich && enrichedAnswer !== supplemented) {
      input.sendThinking('Code：启发模型校正输出结构（供图表/报告消费）')
    }
    const hitl = await maybeConfirmCodeEdit({
      taskKind: resolvedTaskKind,
      question,
      meta: meta as Record<string, unknown> | null | undefined,
      stateMeta: input.state.meta,
      opts,
      sendThinking: input.sendThinking,
    })
    const enrichedWithHitl = enrichedAnswer + (hitl.outputSuffix ?? '')
    return {
      ok: true,
      agent: 'code',
      output: enrichedWithHitl,
      query: input.effQuery,
      parsed: extractStructuredPayload(enrichedWithHitl),
      meta,
      evidence: {
        kind: 'code',
        query: input.effQuery,
        threadId: opts.threadId,
        task_kind: resolvedTaskKind,
        edit_confirmed: hitl.confirmed,
        ...buildCodeEvidenceExtras(meta),
        ...(transportMetrics ? { transportMetrics } : {})
      },
      clarifyQuestions: codeClarify.needsClarify ? codeClarify.questions : undefined
    }
  } catch (e: unknown) {
    const err = String((e as Error)?.message || e || 'unknown error')
    const lower = err.toLowerCase()
    const error_code =
      lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')
        ? 'timeout'
        : lower.includes('tool_round_limit') || lower.includes('recursion limit')
          ? 'tool_round_limit'
          : 'business'
    return {
      ok: false,
      agent: 'code',
      output: `代码助手步骤失败：${err}`,
      query: input.effQuery,
      error: error_code,
      meta: {
        agentResult: {
          ok: false,
          agent: 'code',
          error_code,
          answer: err.slice(0, 400),
          trace_id: opts.runId
        }
      }
    }
  }
}
