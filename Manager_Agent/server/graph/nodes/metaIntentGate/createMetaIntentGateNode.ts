/**
 * 编排前 meta-intent 闸门：记忆/寒暄/固化诉求 → 跳过 probe+orchestrate+子 Agent
 */
import type { BaseMessage } from '@langchain/core/messages'
import { sessionIntentAnchorFromMeta } from '../../core/memory/multiTurnIntent'
import {
  resolveTurnRoutingScope,
  shouldDirectChitchatSynth,
} from '../../core/routing/turnScope'
import { turnScopeLlmFromMeta } from '../../llm/turnScopeLlm'
import { parseMemoryMetaIntentByLlm } from '../../llm/memoryMetaIntentLlm'
import {
  isMemoryMetaIntentHotGateEnabled,
  resolveHotGateCaptureContext,
  shouldShortCircuitMemoryCapture,
  hasMemoryCaptureStructuralContext,
  resolveMemoryCaptureHotGateMinConfidence,
  isMemoryHotGateEligible,
} from '../../core/routing/orchestrationThickness'
import type { CreateMetaIntentGateNodeDeps } from './types'

export function createMetaIntentGateNode(deps: CreateMetaIntentGateNodeDeps) {
  const { opts, lastUserText, mergeMeta } = deps

  return async (state: any) => {
    opts.sendEvent({ event: 'phase', data: 'meta_intent_gate', from: 'manager' })

    if (!isMemoryMetaIntentHotGateEnabled()) {
      return { meta: mergeMeta(state, { metaIntentHotGateChecked: true }) }
    }

    const lastUser = String(lastUserText(state.messages as BaseMessage[]) || '').trim()
    const sessionAnchor = sessionIntentAnchorFromMeta(state.meta)
    const turnScope = resolveTurnRoutingScope({
      messages: state.messages as BaseMessage[],
      lastUser,
      sessionAnchor,
      attachment: state.mediaAttachment,
      turnScopeLlm: turnScopeLlmFromMeta(state.meta),
      meta: state.meta,
    })

    const ctx = resolveHotGateCaptureContext({
      messages: state.messages as BaseMessage[],
      sessionAnchor,
      lastUser,
    })

    const memoryStructuralCtx = hasMemoryCaptureStructuralContext({
      turnScope,
      sessionAnchor,
      turnKind: String(state.meta?.turnKind || turnScope.turnKind || ''),
    })
    const hotGateMinConfidence = resolveMemoryCaptureHotGateMinConfidence(memoryStructuralCtx)
    const hotGateEligible = isMemoryHotGateEligible(turnScope)

    const parsed = await parseMemoryMetaIntentByLlm(
      {
        lastUserText: lastUser,
        businessQuestion: ctx.businessQuestion,
        answerSnippet: ctx.answerSnippet,
        turnKind: turnScope.turnKind,
        memoryStructuralContext: memoryStructuralCtx,
        llm: {
          openaiApiKey: opts.openaiApiKey,
          openaiModel: opts.openaiModel,
          openaiBaseUrl: opts.openaiBaseUrl,
        },
      },
      process.env
    ).catch(() => null)

    if (
      hotGateEligible &&
      shouldDirectChitchatSynth({ meta: state.meta, turnScope }) &&
      !state.mediaAttachment?.filePath &&
      !shouldShortCircuitMemoryCapture(parsed, hotGateMinConfidence, turnScope)
    ) {
      if (!state.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: '记忆轻路径：寒暄/确认 → 跳过编排与子 Agent',
          from: 'manager',
        })
      }
      return {
        intent: 'multi',
        allowedAgents: [],
        routedQuery: lastUser,
        meta: mergeMeta(state, {
          orchestrationThickness: 'memory_capture',
          directChitchatSynth: true,
          metaIntentHotGate: true,
          orchestratorMode: 'chitchat',
          orchestratorSource: 'meta_intent_chitchat',
          lowCostMode: true,
          turnScopeMode: turnScope.mode,
          memoryMetaIntentParsed: parsed ?? undefined,
          memoryCaptureStructuralCtx: memoryStructuralCtx,
        }),
      }
    }

    if (!hotGateEligible || !shouldShortCircuitMemoryCapture(parsed, hotGateMinConfidence, turnScope)) {
      return {
        meta: mergeMeta(state, {
          metaIntentHotGateChecked: true,
          memoryMetaIntentParsed: parsed ?? undefined,
          memoryCaptureStructuralCtx: memoryStructuralCtx,
        }),
      }
    }

    if (!state.meta?.lowCostMode) {
      opts.sendEvent({
        event: 'thinking',
        data: `记忆轻路径：${parsed!.kind} → 跳过子 Agent 编排（finalize 后起草）`,
        from: 'manager',
      })
    }

    return {
      intent: ctx.intent || 'multi',
      allowedAgents: ctx.planAgents,
      routedQuery: lastUser,
      meta: mergeMeta(state, {
        orchestrationThickness: 'memory_capture',
        metaIntentHotGate: true,
        memoryMetaIntentParsed: parsed,
        hotGateBusinessQuestion: ctx.businessQuestion,
        hotGateAnswerSnippet: ctx.answerSnippet,
        hotGatePlanAgents: ctx.planAgents,
        hotGateIntent: ctx.intent,
        directChitchatSynth: true,
        orchestratorMode: 'memory_capture',
        orchestratorSource: 'meta_intent_hot_gate',
        lowCostMode: true,
        memoryCaptureStructuralCtx: memoryStructuralCtx,
        turnScopeMode: turnScope.mode,
      }),
    }
  }
}
