/**
 * Wave 8：finalize 冷路径 — 解析元意图并分发 shadow/draft（不阻塞业务答复）。
 */
import { lastUserText } from '../text/routingContext'
import type { BaseMessage } from '@langchain/core/messages'
import { isMemoryMetaIntentEnabled } from './memoryMetaIntent'
import { dispatchMemoryMetaIntent, type MemoryMetaIntentDispatchContext } from './dispatchMemoryMetaIntent'
import { parseMemoryMetaIntentByLlm, resolveMemoryMetaIntentFallback } from '../../llm/memoryMetaIntentLlm'
import {
  shouldRunMemoryMetaIntentCapture,
  type TurnRoutingScope,
} from '../routing/orchestrationThickness'
import type { TurnScopeMode } from '../routing/turnScope'
import type { TurnKind } from '../../llm/turnScopeLlm'
import type { MemoryCaptureProposal, MemoryMetaIntentParsed } from './memoryMetaIntent'

export type RunMemoryMetaIntentCaptureInput = {
  policyDir: string
  runId: string
  sessionId?: string
  userId?: string
  tenantId?: string
  messages: BaseMessage[]
  businessQuestion: string
  answer: string
  intent: string
  planAgents: string[]
  successScore: number
  needsClarify: boolean
  failureCategory: string
  scenarioKey?: string
  feedbackScore?: number | null
  probeDbMatched?: boolean
  probeRagHits?: number
  llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
  turnScopeMode?: TurnScopeMode
  turnKind?: TurnKind
  meta?: Record<string, unknown>
}

function turnScopeFromCaptureInput(
  input: Pick<RunMemoryMetaIntentCaptureInput, 'turnScopeMode' | 'turnKind'>
): TurnRoutingScope | null {
  const mode = input.turnScopeMode
  if (!mode) return null
  const turnKind = input.turnKind || (mode === 'chitchat' ? 'chitchat' : 'new_task')
  return {
    mode,
    turnKind,
    clarifyKind: 'none',
    lastOnly: '',
    routingContext: '',
    suppressSessionAnchor: mode === 'topic_shift' || mode === 'chitchat',
    suppressMultiTurnMerge: mode === 'topic_shift' || mode === 'chitchat',
    directChitchatSynth: mode === 'chitchat',
    refreshSessionAnchor: mode === 'topic_shift' || mode === 'chitchat',
  }
}

export type RunMemoryMetaIntentCaptureResult = {
  proposal: MemoryCaptureProposal | null
  detail?: string
}

export async function runMemoryMetaIntentCapture(
  input: RunMemoryMetaIntentCaptureInput & {
    preParsed?: MemoryMetaIntentParsed | null
    businessQuestionOverride?: string
    answerOverride?: string
    intentOverride?: string
    pathOverride?: string[]
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<RunMemoryMetaIntentCaptureResult> {
  if (!isMemoryMetaIntentEnabled(env)) {
    return { proposal: null, detail: 'disabled' }
  }

  const lastUser = lastUserText(input.messages)
  const hasPositiveFeedback =
    typeof input.feedbackScore === 'number' && input.feedbackScore >= 0.78
  const turnScope = turnScopeFromCaptureInput(input)

  if (
    !shouldRunMemoryMetaIntentCapture({
      turnScope,
      meta: input.meta,
      hasPositiveFeedback,
    })
  ) {
    return { proposal: null, detail: 'turn_ineligible' }
  }

  let parsed =
    input.preParsed ??
    ((await parseMemoryMetaIntentByLlm(
      {
        lastUserText: lastUser,
        businessQuestion: input.businessQuestionOverride || input.businessQuestion,
        answerSnippet: (input.answerOverride || input.answer).slice(0, 800),
        hasPositiveFeedback,
        llm: input.llm,
      },
      env
    )) ||
      resolveMemoryMetaIntentFallback({
        hasPositiveFeedback,
        feedbackScore: input.feedbackScore,
      }))

  if (!parsed || parsed.kind === 'none') {
    return { proposal: null, detail: 'no_meta_intent' }
  }

  const ctx: MemoryMetaIntentDispatchContext = {
    policyDir: input.policyDir,
    runId: input.runId,
    sessionId: input.sessionId,
    userId: input.userId,
    tenantId: input.tenantId,
    question: input.businessQuestionOverride || input.businessQuestion,
    answer: input.answerOverride || input.answer,
    intent: input.intentOverride || input.intent,
    planAgents: input.pathOverride?.length ? input.pathOverride : input.planAgents,
    successScore: input.successScore,
    needsClarify: input.needsClarify,
    failureCategory: input.failureCategory,
    scenarioKey: input.scenarioKey,
    feedbackScore: input.feedbackScore,
    probeDbMatched: input.probeDbMatched,
    probeRagHits: input.probeRagHits,
  }

  const source: MemoryCaptureProposal['source'] = hasPositiveFeedback
    ? 'positive_feedback_fallback'
    : 'explicit_user_request'

  const result = await dispatchMemoryMetaIntent(parsed, ctx, source)
  return { proposal: result.proposal, detail: result.detail }
}

export function memoryCaptureProposalLabel(proposal: MemoryCaptureProposal): string {
  const kindZh: Record<string, string> = {
    todo: '待办',
    save_answer: '保存答案',
    save_playbook: '保存打法',
    save_preference: '保存偏好',
    save_org_rule: '组织规则',
    none: '无',
  }
  const statusZh: Record<string, string> = {
    draft_pending_review: '已起草，待管理员审核',
    acknowledged_pre_ingest: '待办诉求已识别（入栈阶段处理）',
    applied_shadow: '已写入经验 shadow',
    skipped: '已跳过',
  }
  const k = kindZh[proposal.kind] || proposal.kind
  const s = statusZh[proposal.status] || proposal.status
  const title = proposal.title ? `：${proposal.title}` : ''
  return `记忆提案 · ${k}${title} — ${s}`
}
