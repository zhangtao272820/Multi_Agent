/**
 * 统一编排 SSOT（Semantic Router + Plan-and-Execute，开源式单层 LLM 决策）
 *
 * 路径：turn_scope → probe → orchestrate（本模块）→ prefetch → planner（蓝图材料化）→ exec
 * - 一次编排 LLM：cap / clauses / planBlueprint 权威
 * - PU-Stack / 媒体 / probe 仅作 prompt hint
 * - 专业 vs 对话：仅 prompt 模式块不同，流水线相同
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { LlmInvokeFn } from '../llm/taskConstraintsLlm'
import type { TurnRoutingScope } from '../core/routing/turnScope'
import { runProfessionalPuStack, buildPuStackMetaPatch } from '../core/proPuStack'
import { formatProbeForOrchestrator } from '../core/probe/probeInterpretation'
import { orchestratorPromptModeBlock } from '../core/runtime/modeIsolate'
import type { SessionIntentAnchor } from '../core/memory/multiTurnIntent'
import type { IntentRagRecallResult } from '../core/rag/intentRagRecallCore'
import { resolveOrchestratorPipeline,
  type OrchestratorPipelineResult
} from './orchestratorPipeline'
import type { OrchestratorDecision } from './orchestratorInvariants'
import { resolveCompositeMediaAgents } from '../llm/mediaRouteLlm'
import { formatPuStackOrchestratorHint, formatPuStackDraftBindingForOrchestrator, shouldPuStackBypassOrchestratorLlm } from '../core/routing/proRoutePolicy'
import { buildOrchestratorBundleFromPuStack } from './puStackOrchestratorAuthority'
import { resolveManagerInteractionMode, isProUnderstandEnabled } from '../../utils/platform/managerInteractionMode'
import { formatAttachmentHintForOrchestrator, shouldRunPuStackLlmInOrchestrate } from './unifiedRouting'
import {
  fetchRouteImageCaption,
  mergeCaptionIntoAttachment,
  type RouteCaptionResult
} from './routeImageCaption'
import type { MediaAttachment } from '../../utils/media/mediaAttachment'

export type UnifiedOrchestrateInput = {
  state: Record<string, unknown>
  messages: BaseMessage[]
  lastUser: string
  routingContext: string
  turnScopeHint: string
  turnScope: TurnRoutingScope
  probe?: { db?: { matched?: boolean; tables?: string[] }; rag?: { hits?: number } } | null
  sessionAnchor?: SessionIntentAnchor | null
  ragRecall?: IntentRagRecallResult | null
  evolutionHint?: string
  llmInvoke: LlmInvokeFn
  mergeMeta: (state: unknown, patch: Record<string, unknown>) => Record<string, unknown>
  onThinking: (line: string) => void
  multimodalAgentHttpUrl?: string
  signal?: AbortSignal
  traceId?: string
}

export type UnifiedOrchestrateResult = {
  decision: OrchestratorDecision
  orchestratorSource: string
  pipelineResult: OrchestratorPipelineResult | null
  orchestratorMetaBase: Record<string, unknown>
  orchestratorState: Record<string, unknown>
  /** 编排前看图摘要（可能写回 mediaAttachment） */
  mediaAttachment?: MediaAttachment | null
  routeCaption?: RouteCaptionResult | null
}

async function readPuStackHint(input: UnifiedOrchestrateInput): Promise<{
  puMetaPatch: Record<string, unknown>
  puStackHint: string
}> {
  const probeHint = formatProbeForOrchestrator(input.probe)
  const probeOnlyHint = probeHint ? `【Probe 弱参考·不得扩 cap】\n${probeHint}` : ''

  if (!shouldRunPuStackLlmInOrchestrate()) {
    return { puMetaPatch: {}, puStackHint: probeOnlyHint }
  }

  if (!isProUnderstandEnabled() || resolveManagerInteractionMode(input.state.meta) !== 'professional') {
    return { puMetaPatch: {}, puStackHint: probeOnlyHint }
  }
  const pu = await runProfessionalPuStack({
    interactionMode: 'professional',
    lastUser: input.lastUser,
    routingContext: input.routingContext,
    probeHint,
    llmInvoke: input.llmInvoke,
    state: input.state
  }).catch(() => null)
  if (!pu) return { puMetaPatch: {}, puStackHint: probeOnlyHint }
  input.onThinking(pu.hintBlock || '读题 hint 已注入编排 LLM（非权威）')
  const puHint = pu.hintBlock || formatPuStackOrchestratorHint(buildPuStackMetaPatch(pu))
  return {
    puMetaPatch: buildPuStackMetaPatch(pu),
    puStackHint: [probeOnlyHint, puHint].filter(Boolean).join('\n\n')
  }
}

export async function resolveUnifiedOrchestration(
  input: UnifiedOrchestrateInput
): Promise<UnifiedOrchestrateResult> {
  const workbenchMode = resolveManagerInteractionMode(input.state.meta)
  const { puMetaPatch, puStackHint } = await readPuStackHint(input)

  let attachment = (input.state as { mediaAttachment?: MediaAttachment | null }).mediaAttachment || null
  let routeCaption: RouteCaptionResult | null = null
  if (attachment?.filePath && attachment.mediaType === 'image' && input.multimodalAgentHttpUrl) {
    input.onThinking('看图摘要：轻量 VL 预读画面…')
    routeCaption = await fetchRouteImageCaption({
      multimodalAgentHttpUrl: input.multimodalAgentHttpUrl,
      attachment,
      userQuery: input.lastUser,
      traceId: input.traceId,
      signal: input.signal
    })
    attachment = mergeCaptionIntoAttachment(attachment, routeCaption)
    if (routeCaption.caption) {
      input.onThinking(`看图摘要：${routeCaption.caption.slice(0, 72)}`)
    } else if (routeCaption.captionSource === 'timeout' || routeCaption.captionSource === 'error') {
      input.onThinking('看图摘要超时/失败，继续仅路径 hint 编排')
    }
  }

  let compositeMedia: string[] | null = null
  if (attachment?.filePath) {
    compositeMedia = await resolveCompositeMediaAgents(
      input.lastUser,
      attachment,
      input.llmInvoke,
      input.state
    ).catch(() => null)
  }

  const captionMeta =
    routeCaption && (routeCaption.caption || routeCaption.captionSource !== 'skip')
      ? {
          routeCaptionMs: routeCaption.captionMs,
          routeCaptionSource: routeCaption.captionSource,
          routeCaptionChars: routeCaption.caption ? routeCaption.caption.length : 0,
          ...(routeCaption.caption
            ? {
                routeImageCaption: routeCaption.caption,
                ...(routeCaption.ocrSnippet ? { routeImageOcr: routeCaption.ocrSnippet } : {})
              }
            : {})
        }
      : {}

  const orchestratorMetaBase = input.mergeMeta(input.state, {
    unifiedOrchestrator: true,
    intentClassifyMode: 'orchestrator',
    interactionMode: workbenchMode,
    workbenchMode,
    llmFirstRoute: true,
    ...puMetaPatch,
    ...(compositeMedia?.length ? { compositeMediaAgents: compositeMedia } : {}),
    ...captionMeta
  }) as Record<string, unknown>

  const orchestratorState = {
    ...input.state,
    ...(attachment ? { mediaAttachment: attachment } : {}),
    meta: orchestratorMetaBase
  }
  const modeHint = orchestratorPromptModeBlock(workbenchMode)
  const attachmentHint = formatAttachmentHintForOrchestrator(attachment, compositeMedia)
  const puHint = formatPuStackOrchestratorHint(orchestratorMetaBase) || puStackHint
  const draftBinding = formatPuStackDraftBindingForOrchestrator(orchestratorMetaBase)
  const orchestratorTurnHint = [input.turnScopeHint, modeHint, attachmentHint, puHint, draftBinding].filter(Boolean).join('\n\n')

  const seedBundle = shouldPuStackBypassOrchestratorLlm(orchestratorMetaBase)
    ? buildOrchestratorBundleFromPuStack({
        lastUser: input.lastUser,
        turnScope: input.turnScope,
        meta: orchestratorMetaBase,
        probe: input.probe
      })
    : null

  let pipelineResult: OrchestratorPipelineResult | null = null
  let orchestratorSource = 'unified_llm'

  try {
    pipelineResult = await resolveOrchestratorPipeline({
      messages: input.messages,
      lastUser: input.lastUser,
      routingContext: input.routingContext,
      turnScopeHint: orchestratorTurnHint,
      turnScope: input.turnScope,
      probe: input.probe,
      sessionAnchor: input.sessionAnchor,
      ragRecall: input.ragRecall,
      evolutionHint: input.evolutionHint,
      llmInvoke: input.llmInvoke,
      state: orchestratorState,
      seedBundle,
      onThinking: input.onThinking
    })
    orchestratorSource = pipelineResult.source
  } catch (e) {
    input.onThinking(`编排 LLM 未通过：${e instanceof Error ? e.message : String(e)}`)
    throw e
  }

  const decision = pipelineResult.decision
  return {
    decision,
    orchestratorSource,
    pipelineResult,
    orchestratorMetaBase,
    orchestratorState,
    mediaAttachment: attachment,
    routeCaption
  }
}

/** @deprecated 使用 resolveUnifiedOrchestration */
export async function resolveProfessionalOrchestration(input: UnifiedOrchestrateInput) {
  return resolveUnifiedOrchestration(input)
}

/** @deprecated 使用 resolveUnifiedOrchestration */
export async function resolveChatOrchestration(input: UnifiedOrchestrateInput) {
  return resolveUnifiedOrchestration(input)
}
