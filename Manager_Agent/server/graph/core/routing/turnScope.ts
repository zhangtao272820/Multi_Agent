import type { BaseMessage } from '@langchain/core/messages'
import { shouldRunNlCoalesce } from './nlResolve'
import type { IntentClassifyResult } from '../../llm/intentClassifyLlm'
import {
  hasStructuralMultiLineBullets,
  isExplicitMultiRequest,
  lastUserText,
  preferCurrentTurnScope,
  resolveStandaloneMediaRoute,
  routingConversationContext
} from '../text'
import type { SessionIntentAnchor } from '../memory/multiTurnIntent'
import type { TurnScopeLlmResult, TurnKind, ClarifyKind } from '../../llm/turnScopeLlm'
import { turnScopeLlmFromMeta } from '../../llm/turnScopeLlm'

export type TurnScopeMode = 'current_only' | 'continuation' | 'topic_shift' | 'chitchat'

export type { TurnKind, ClarifyKind } from '../../llm/turnScopeLlm'

export type TurnRoutingScope = {
  mode: TurnScopeMode
  /** 细粒度轮次语义（LLM 判定，供编排 hint） */
  turnKind: TurnKind
  clarifyKind: ClarifyKind
  lastOnly: string
  /** 供路由 LLM / 合并理解；continuation 才带有限历史 */
  routingContext: string
  /** 跳过会话意图锚点与 RAG 快路径 */
  suppressSessionAnchor: boolean
  /** 跳过 nlCoalesce / merged 多轮合并 */
  suppressMultiTurnMerge: boolean
  /** 直连 synth，不调用子 Agent */
  directChitchatSynth: boolean
  /** 本轮是否应刷新 sessionIntentAnchor（话题切换或闲聊） */
  refreshSessionAnchor: boolean
  /** turnScope LLM 置信（无 LLM 时缺省；续轮 cap 复用须 ≥0.7） */
  confidence?: number
}

const LLM_CONF_FLOOR = 0.48

function chitchatScope(lastOnly: string, messages: BaseMessage[]): TurnRoutingScope {
  return scopeFromMode('chitchat', lastOnly, messages)
}

/** 寒暄/确认是否应直连 synth（优先于 LLM continuation 与 Bandit 历史） */
export function shouldDirectChitchatSynth(input: {
  meta?: unknown
  intentClassify?: IntentClassifyResult | null
  turnScopeLlm?: TurnScopeLlmResult | null
  turnScope?: TurnRoutingScope | null
}): boolean {
  const scope = input.turnScope
  const llm = input.turnScopeLlm ?? turnScopeLlmFromMeta(input.meta)
  // 话题切换 / 独立新任务不得继承上轮 directChitchatSynth（已在 turn_scope 清 meta，此处为双保险）
  if (scope?.mode === 'topic_shift') return false
  if (scope?.turnKind === 'new_task' && scope.mode !== 'chitchat') {
    if (llm && llm.confidence >= LLM_CONF_FLOOR && llm.mode === 'chitchat') {
      // LLM 仍判寒暄则允许
    } else {
      return false
    }
  }

  const meta = input.meta as { directChitchatSynth?: boolean } | null | undefined
  if (meta?.directChitchatSynth === true) return true
  if (input.turnScope?.directChitchatSynth || input.turnScope?.mode === 'chitchat') return true
  if (
    input.intentClassify?.planShortcut === 'chitchat_only' &&
    Number(input.intentClassify.confidence ?? 0) >= 0.55
  ) {
    return true
  }
  return Boolean(llm && llm.confidence >= LLM_CONF_FLOOR && llm.mode === 'chitchat')
}

function scopeFromMode(
  mode: TurnScopeMode,
  lastOnly: string,
  messages: BaseMessage[],
  directChitchatSynth?: boolean,
  turnKind?: TurnKind,
  clarifyKind?: ClarifyKind,
  confidence?: number
): TurnRoutingScope {
  const kind: TurnKind =
    turnKind ??
    (mode === 'chitchat'
      ? 'chitchat'
      : mode === 'continuation'
        ? 'continuation'
        : mode === 'topic_shift'
          ? 'new_task'
          : 'new_task')
  const ck: ClarifyKind = clarifyKind ?? 'none'
  const conf =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : undefined
  if (mode === 'chitchat') {
    return {
      mode: 'chitchat',
      turnKind: kind === 'chitchat' ? 'chitchat' : kind,
      clarifyKind: ck,
      lastOnly,
      routingContext: lastOnly,
      suppressSessionAnchor: true,
      suppressMultiTurnMerge: true,
      directChitchatSynth: true,
      refreshSessionAnchor: true,
      confidence: conf
    }
  }
  if (mode === 'topic_shift') {
    return {
      mode: 'topic_shift',
      turnKind: kind === 'output_followup' ? 'output_followup' : 'new_task',
      clarifyKind: ck,
      lastOnly,
      routingContext: lastOnly,
      suppressSessionAnchor: true,
      suppressMultiTurnMerge: true,
      directChitchatSynth: false,
      refreshSessionAnchor: true,
      confidence: conf
    }
  }
  if (mode === 'continuation') {
    // 剪枝：仅保留极短先验（锚点/软交接由编排 Human 另挂），禁止整段历史灌入
    return {
      mode: 'continuation',
      turnKind: kind === 'slot_answer' ? 'slot_answer' : 'continuation',
      clarifyKind: ck,
      lastOnly,
      routingContext: routingConversationContext(messages, { maxPriorRounds: 1, maxTotalChars: 480 }),
      suppressSessionAnchor: false,
      suppressMultiTurnMerge: false,
      directChitchatSynth: false,
      refreshSessionAnchor: false,
      confidence: conf
    }
  }
  if (kind === 'output_followup') {
    return {
      mode: 'current_only',
      turnKind: 'output_followup',
      clarifyKind: ck === 'none' ? 'output_disambiguation' : ck,
      lastOnly,
      routingContext: lastOnly,
      suppressSessionAnchor: false,
      suppressMultiTurnMerge: true,
      directChitchatSynth: Boolean(directChitchatSynth),
      refreshSessionAnchor: false,
      confidence: conf
    }
  }
  return {
    mode: 'current_only',
    turnKind: kind,
    clarifyKind: ck,
    lastOnly,
    routingContext: lastOnly,
    suppressSessionAnchor: kind !== 'slot_answer',
    suppressMultiTurnMerge: true,
    directChitchatSynth: Boolean(directChitchatSynth),
    refreshSessionAnchor: false,
    confidence: conf
  }
}

/** 意图识别 chitchat_only 或 LLM 轮次范围结果（无正则词表） */
export function isChitchatTurn(scope: TurnRoutingScope, intentClassify?: IntentClassifyResult | null): boolean {
  if (scope.mode === 'chitchat' || scope.directChitchatSynth) return true
  return (
    intentClassify?.planShortcut === 'chitchat_only' &&
    Number(intentClassify.confidence ?? 0) >= 0.55
  )
}

/** @deprecated 请用 isChitchatTurn / turnScopeLlm；保留供 smoke 注入 LLM 结果 */
export function detectStructuralChitchat(text: string, intentClassify?: IntentClassifyResult | null): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (hasStructuralMultiLineBullets(t) || isExplicitMultiRequest(t)) return false
  if (intentClassify?.planShortcut === 'chitchat_only' && Number(intentClassify.confidence ?? 0) >= 0.55) {
    return true
  }
  return false
}

/** 话题切换：优先 LLM；回退为意图识别 vs 会话锚点语义不一致（无词表正则） */
export function detectTopicShiftStructural(input: {
  messages: BaseMessage[]
  lastUser: string
  sessionAnchor?: SessionIntentAnchor | null
  intentClassify?: IntentClassifyResult | null
  turnScopeLlm?: TurnScopeLlmResult | null
}): boolean {
  const llm = input.turnScopeLlm
  if (llm && llm.confidence >= LLM_CONF_FLOOR && llm.mode === 'topic_shift') return true
  if (llm && llm.confidence >= LLM_CONF_FLOOR && llm.mode === 'chitchat') return true

  const last = String(input.lastUser || '').trim()
  if (!last) return false

  const anchor = input.sessionAnchor
  const classify = input.intentClassify
  if (!anchor || !classify) return false

  const continuation = shouldRunNlCoalesce(input.messages, last)
  // Wave6：意图面相对锚点已变时，禁止用「短句 coalesce」挡住 topic_shift
  const intentBreak =
    Number(classify.confidence ?? 0) >= 0.58 && classify.primaryIntent !== anchor.primaryIntent
  if (continuation && !intentBreak && (!llm || llm.mode === 'continuation')) return false

  if (classify.isMulti !== anchor.isMulti && Number(classify.confidence ?? 0) >= 0.55) return true
  if (intentBreak) return true

  if (resolveStandaloneMediaRoute(last, null, null) && anchor.primaryIntent !== 'admin') {
    const dataIntents = new Set(['db', 'rag', 'crawler', 'code', 'clean', 'visualize', 'report', 'multi'])
    if (dataIntents.has(String(anchor.primaryIntent)) || anchor.lastExecutedAgents?.some((a) => dataIntents.has(a))) {
      return true
    }
  }

  return false
}

export function resolveTurnRoutingScope(input: {
  messages: BaseMessage[]
  lastUser?: string
  sessionAnchor?: SessionIntentAnchor | null
  intentClassify?: IntentClassifyResult | null
  attachment?: { filePath?: string } | null
  turnScopeLlm?: TurnScopeLlmResult | null
  meta?: unknown
}): TurnRoutingScope {
  const lastOnly = String(input.lastUser ?? lastUserText(input.messages) ?? '').trim()
  const hasAttachment = Boolean(input.attachment?.filePath)
  const llm = input.turnScopeLlm ?? turnScopeLlmFromMeta(input.meta)

  if (hasAttachment) {
    return scopeFromMode('current_only', lastOnly, input.messages)
  }

  if (shouldDirectChitchatSynth({ meta: input.meta, intentClassify: input.intentClassify, turnScopeLlm: llm })) {
    return chitchatScope(lastOnly, input.messages)
  }

  if (llm && llm.confidence >= LLM_CONF_FLOOR) {
    const rejectContinuation =
      llm.mode === 'continuation' &&
      (llm.turnKind === 'output_followup' ||
        llm.turnKind === 'new_task' ||
        preferCurrentTurnScope(input.messages, lastOnly) ||
        Boolean(input.sessionAnchor && !shouldRunNlCoalesce(input.messages, lastOnly)))
    if (rejectContinuation) {
      const forcedKind = llm.turnKind === 'output_followup' ? 'output_followup' : 'new_task'
      const anchorBreak =
        forcedKind === 'new_task' &&
        Boolean(input.sessionAnchor) &&
        !shouldRunNlCoalesce(input.messages, lastOnly)
      if (anchorBreak) {
        return scopeFromMode('topic_shift', lastOnly, input.messages, false, forcedKind, llm.clarifyKind, llm.confidence)
      }
      return scopeFromMode('current_only', lastOnly, input.messages, false, forcedKind, llm.clarifyKind, llm.confidence)
    }
    if (llm.turnKind === 'output_followup') {
      return scopeFromMode(
        'current_only',
        lastOnly,
        input.messages,
        llm.directChitchatSynth,
        'output_followup',
        llm.clarifyKind,
        llm.confidence
      )
    }
    // Wave6：高置信 topic_shift 保持 mode（不因 preferCurrentTurnScope 降级为 current_only）
    return scopeFromMode(
      llm.mode,
      lastOnly,
      input.messages,
      llm.directChitchatSynth,
      llm.turnKind,
      llm.clarifyKind,
      llm.confidence
    )
  }

  if (
    input.intentClassify?.planShortcut === 'chitchat_only' &&
    Number(input.intentClassify.confidence ?? 0) >= 0.55
  ) {
    return chitchatScope(lastOnly, input.messages)
  }

  const topicShift = detectTopicShiftStructural({
    messages: input.messages,
    lastUser: lastOnly,
    sessionAnchor: input.sessionAnchor,
    intentClassify: input.intentClassify,
    turnScopeLlm: llm
  })

  const continuation = shouldRunNlCoalesce(input.messages, lastOnly) && !topicShift

  if (topicShift) {
    return scopeFromMode('topic_shift', lastOnly, input.messages)
  }

  if (continuation) {
    return scopeFromMode('continuation', lastOnly, input.messages)
  }

  const isolated = preferCurrentTurnScope(input.messages, lastOnly)
  return {
    mode: 'current_only',
    turnKind: 'new_task',
    clarifyKind: 'none',
    lastOnly,
    routingContext: lastOnly,
    suppressSessionAnchor: isolated,
    suppressMultiTurnMerge: isolated,
    directChitchatSynth: false,
    refreshSessionAnchor: false
  }
}

export function buildChitchatIntentClassify(lastUser: string): IntentClassifyResult {
  return {
    primaryIntent: 'multi',
    isMulti: false,
    suggestedAgents: [],
    isDbAnchored: false,
    needsAdmin: false,
    needsWeb: false,
    explicitWantsReport: false,
    explicitWantsVisualize: false,
    planShortcut: 'chitchat_only',
    confidence: 0.92,
    rationale: `轮次范围判定为寒暄/确认：${lastUser.slice(0, 24)}`
  }
}

export function formatTurnScopeRouterHint(scope: TurnRoutingScope): string {
  const kindLine = `【轮次语义】turnKind=${scope.turnKind} clarifyKind=${scope.clarifyKind}`
  if (scope.turnKind === 'output_followup') {
    return [
      kindLine,
      '【轮次范围】输出追问：用户对上一轮结果消歧/解释，禁止扩写 db/admin/多源 pipeline；cap 仅限上轮数据面（通常 rag 或 synth）。',
      '【主题锚定】coalescedTask / clauses.text / queryFocus 必须基于 session_anchor.task（上轮任务），禁止另起新检索主题或新专名；短句「再详细一点」不得单独作为检索问句。'
    ].join('\n')
  }
  if (scope.turnKind === 'slot_answer') {
    return [kindLine, '【轮次范围】澄清补答：合并后重编排，禁止二次 clarify。'].join('\n')
  }
  if (scope.mode === 'chitchat') {
    return [kindLine, '【轮次范围】本轮为寒暄/确认，直接对话回复，禁止调用 db/rag/crawler/code 等子 Agent。'].join('\n')
  }
  if (scope.mode === 'topic_shift') {
    return [kindLine, '【轮次范围】检测到话题切换：仅以【当前用户输入】路由，勿继承上一轮 rag/db/multi 任务。'].join('\n')
  }
  if (scope.mode === 'continuation') {
    return [
      kindLine,
      '【轮次范围】多轮承接：可结合有限前序上下文，但 data-plane 仍以用户原表述为准。',
      '【主题锚定】短承接时 coalescedTask/queryFocus 须锚定 session_anchor.task，禁止发明与上轮无关的新主题。'
    ].join('\n')
  }
  return [kindLine, '【轮次范围】独立新任务：仅依据当前用户输入路由，勿混入历史轮次的图表/查库/报告诉求。'].join('\n')
}
