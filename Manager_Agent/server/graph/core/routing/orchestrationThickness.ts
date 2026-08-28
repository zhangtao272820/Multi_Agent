/**
 * 编排厚度 SSOT：memory_capture（记忆/寒暄）| single_source | complex
 */
import type { BaseMessage } from '@langchain/core/messages'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { MemoryMetaIntentKind, MemoryMetaIntentParsed } from '../memory/memoryMetaIntent'
import { isMemoryMetaIntentHotGateEnabled } from '../memory/memoryMetaIntent'
import { isSingleSourceDbTask, isSingleSourceRagTask, isTrueMultiTask } from './subAgentPassthrough'
import type { SessionIntentAnchor } from '../memory/multiTurnIntent'
import type { TurnRoutingScope } from './turnScope'

export type OrchestrationThickness = 'memory_capture' | 'single_source' | 'complex'

/** 单源任务可挂加工链，但仍跳过 Planner / 审计厚路径 */
const PROCESSING_CHAIN_AGENTS = new Set(['clean', 'visualize', 'report', 'code'])

const SINGLE_SOURCE_EXEC_NODES = new Set([
  'rag',
  'db',
  'admin',
  'crawler',
  'code',
  'gui',
  'clean',
  'visualize',
  'report',
  'multimodal',
  'music',
  'video',
])

const HOT_GATE_KINDS = new Set<MemoryMetaIntentKind>([
  'save_playbook',
  'save_preference',
  'save_org_rule',
  'save_answer',
])

export { isMemoryMetaIntentHotGateEnabled }

/** 独立新业务问句不得走记忆热路径（结构信号，不读用户原话 regex） */
export function isMemoryHotGateEligible(turnScope?: TurnRoutingScope | null): boolean {
  if (!turnScope) return true
  if (turnScope.mode === 'topic_shift') return false
  if (turnScope.turnKind === 'new_task' && turnScope.mode !== 'chitchat') return false
  return true
}

export function shouldShortCircuitMemoryCapture(
  parsed: MemoryMetaIntentParsed | null | undefined,
  minConfidence = 0.75,
  turnScope?: TurnRoutingScope | null
): boolean {
  if (!isMemoryHotGateEligible(turnScope)) return false
  if (!parsed || parsed.kind === 'none' || parsed.kind === 'todo') return false
  if (!HOT_GATE_KINDS.has(parsed.kind)) return false
  return Number(parsed.confidence ?? 0) >= minConfidence
}

/** finalize 冷路径：独立新任务不得误起草记忆提案（除非本轮热路径或正反馈） */
export function shouldRunMemoryMetaIntentCapture(input: {
  turnScope?: TurnRoutingScope | null
  meta?: unknown
  hasPositiveFeedback?: boolean
}): boolean {
  if (input.hasPositiveFeedback) return true
  const m = metaRecord(input.meta)
  if (m.metaIntentHotGate === true && m.orchestrationThickness === 'memory_capture') {
    return true
  }
  return isMemoryHotGateEligible(input.turnScope)
}

/** 结构信号：上轮已执行专才 + 本轮承接/输出追问 → 优先走记忆热路径（非用户原话 regex） */
export function hasMemoryCaptureStructuralContext(input: {
  turnScope?: TurnRoutingScope | null
  sessionAnchor?: SessionIntentAnchor | null
  turnKind?: string | null
}): boolean {
  const anchor = input.sessionAnchor
  if (!String(anchor?.coalescedTask || '').trim()) return false
  const executed = (anchor?.lastExecutedAgents || []).map(String).filter(Boolean)
  if (!executed.length) return false
  const kind = String(input.turnKind || input.turnScope?.turnKind || '').trim()
  return kind === 'output_followup' || kind === 'continuation'
}

export function resolveMemoryCaptureHotGateMinConfidence(structuralContext: boolean): number {
  return structuralContext ? 0.62 : 0.75
}

function metaRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
}

function allowedAgentsList(meta: unknown, allowedAgents?: string[]): string[] {
  if (Array.isArray(allowedAgents) && allowedAgents.length) {
    return allowedAgents.map((a) => String(a || '').trim()).filter(Boolean)
  }
  const m = metaRecord(meta)
  if (!Array.isArray(m.allowedAgents)) return []
  return m.allowedAgents.map((a) => String(a || '').trim()).filter(Boolean)
}

function hasProcessingChainBeyondDataPlane(allowedAgents: string[]): boolean {
  return allowedAgents.some((a) => PROCESSING_CHAIN_AGENTS.has(String(a)))
}

/** 单源且仅数据面执行 → 跳过 Planner，直连专才节点 */
export function shouldBypassPlannerRoute(input: {
  meta?: unknown
  intent?: string
  allowedAgents?: string[]
}): boolean {
  const meta = input.meta
  const thickness = resolveOrchestrationThickness({
    meta,
    intent: input.intent,
    allowedAgents: input.allowedAgents,
  })
  if (thickness !== 'single_source') return false
  if (isTrueMultiTask(meta)) return false
  const allowed = allowedAgentsList(meta, input.allowedAgents)
  if (hasProcessingChainBeyondDataPlane(allowed)) return false
  const classify = metaRecord(meta).intentClassify as { requiresAgentPipeline?: boolean; isMulti?: boolean } | undefined
  if (classify?.isMulti === true && isTrueMultiTask(meta)) return false
  if (classify?.requiresAgentPipeline === true && hasProcessingChainBeyondDataPlane(allowed)) return false
  return resolveSingleSourceExecutionNode({ meta, intent: input.intent }) != null
}

/** 单源任务对外 intent：避免 rag_only 仍标 multi 导致误进 Planner */
export function resolveIntentForOrchestrationThickness(input: {
  meta?: unknown
  intent?: string
  allowedAgents?: string[]
}): string {
  const thickness = resolveOrchestrationThickness(input)
  if (thickness !== 'single_source') return String(input.intent || '').trim() || 'multi'
  const node = resolveSingleSourceExecutionNode(input)
  if (node) return node
  const intent = String(input.intent || '').trim()
  if (intent && intent !== 'multi') return intent
  if (isSingleSourceRagTask(input.meta)) return 'rag'
  if (isSingleSourceDbTask(input.meta)) return 'db'
  return intent || 'multi'
}

export function resolveSingleSourceExecutionNode(input: {
  meta?: unknown
  intent?: string
  allowedAgents?: string[]
}): string | null {
  const meta = input.meta
  if (isSingleSourceRagTask(meta)) return 'rag'
  if (isSingleSourceDbTask(meta)) return 'db'
  const m = metaRecord(meta)
  const classify = m.intentClassify as { planShortcut?: string; primaryIntent?: string } | undefined
  if (classify?.planShortcut === 'admin_only') return 'admin'
  const primary = String(classify?.primaryIntent || input.intent || m.intent || '').trim()
  if (primary && primary !== 'multi' && SINGLE_SOURCE_EXEC_NODES.has(primary)) return primary
  const allowed = allowedAgentsList(meta, input.allowedAgents)
  const dataPlane = allowed.find((a) => ['rag', 'db', 'admin', 'crawler'].includes(a))
  if (dataPlane) return dataPlane
  return null
}

/** prefetch 之后的路由 SSOT：轻编排单源直连专才，复杂任务才进 Planner */
export function resolvePostPrefetchRoute(input: {
  intent?: string
  meta?: unknown
  allowedAgents?: string[]
}): string {
  const m = metaRecord(input.meta)
  if (Boolean(m.needsClarify)) return 'clarify'
  if (Boolean(m.directChitchatSynth)) return 'synth'
  if (shouldBypassPlannerRoute(input)) {
    return resolveSingleSourceExecutionNode(input) || 'planner'
  }
  const intent = String(input.intent || '').trim()
  if (intent === 'multi' || resolveOrchestrationThickness(input) === 'complex') return 'planner'
  if (intent && SINGLE_SOURCE_EXEC_NODES.has(intent)) return intent
  return intent || 'planner'
}

export function resolveOrchestrationThickness(input: {
  meta?: unknown
  intent?: string
  allowedAgents?: string[]
}): OrchestrationThickness {
  const meta = input.meta
  const m = metaRecord(meta)
  if (m.metaIntentHotGate === true || m.orchestrationThickness === 'memory_capture') {
    return 'memory_capture'
  }
  if (m.directChitchatSynth === true && String(m.orchestratorMode || '') === 'chitchat') {
    return 'memory_capture'
  }
  if (isTrueMultiTask(meta)) return 'complex'
  // 单源（含 intent=multi 但仅 rag/db 面）须在 multi 判定之前，避免误标 complex
  if (isSingleSourceDbTask(meta) || isSingleSourceRagTask(meta)) return 'single_source'
  const intent = String(input.intent || m.intent || '').trim()
  if (intent === 'db' || intent === 'rag' || intent === 'admin') return 'single_source'
  if (intent === 'multi') return 'complex'
  return 'complex'
}

/** 单源 RAG 薄编排：走对话式 Synth，不整段跳过汇总 */
export function shouldUseConversationalRagSynth(input: {
  meta?: unknown
  intent?: string
  results?: Record<string, unknown> | null
}): boolean {
  if (resolveOrchestrationThickness(input) !== 'single_source') return false
  if (!isSingleSourceRagTask(input.meta)) return false
  const rag = String(input.results?.rag ?? '').trim()
  return rag.length >= 8
}

/** @deprecated 别名 */
export const shouldUseLightRagSynth = shouldUseConversationalRagSynth

/** 单源 DB 薄编排：走对话式 Synth（解读 + 拓展），不直通库表 dump */
export function shouldUseConversationalDbSynth(input: {
  meta?: unknown
  intent?: string
  results?: Record<string, unknown> | null
}): boolean {
  if (resolveOrchestrationThickness(input) !== 'single_source') return false
  if (!isSingleSourceDbTask(input.meta)) return false
  const db = String(input.results?.db ?? '').trim()
  return db.length >= 8
}

export function shouldSkipPostSynthAudit(meta: unknown): boolean {
  const thickness = resolveOrchestrationThickness({ meta })
  if (thickness === 'memory_capture' || thickness === 'single_source') return true
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
  return Boolean(m.directChitchatSynth)
}

export function allowsSingleSourceSynthPassthrough(input: {
  meta?: unknown
  professionalMode?: boolean
}): boolean {
  const thickness = resolveOrchestrationThickness({ meta: input.meta })
  if (thickness === 'single_source') return true
  const m = input.meta && typeof input.meta === 'object' ? (input.meta as Record<string, unknown>) : {}
  if (m.lowCostMode === true) return true
  return input.professionalMode !== true
}

export function resolveHotGateCaptureContext(input: {
  messages: BaseMessage[]
  sessionAnchor: SessionIntentAnchor | null
  lastUser: string
}): {
  businessQuestion: string
  answerSnippet: string
  planAgents: string[]
  intent: string
} {
  const lastUser = String(input.lastUser || '').trim()
  const anchor = input.sessionAnchor
  const planAgents = (anchor?.lastExecutedAgents || []).map(String).filter(Boolean)
  const intent = String(anchor?.primaryIntent || 'rag').trim() || 'rag'

  let businessQuestion = String(anchor?.coalescedTask || '').trim()
  let answerSnippet = ''

  const msgs = Array.isArray(input.messages) ? input.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg instanceof HumanMessage || msg?._getType?.() === 'human') {
      const text = String((msg as HumanMessage).content ?? '').trim()
      if (text && text !== lastUser) {
        if (!businessQuestion) businessQuestion = text
        for (let j = i + 1; j < msgs.length; j++) {
          const follow = msgs[j]
          if (follow instanceof AIMessage || follow?._getType?.() === 'ai') {
            answerSnippet = String((follow as AIMessage).content ?? '').trim()
            break
          }
        }
        break
      }
    }
  }

  if (!businessQuestion) businessQuestion = lastUser
  return {
    businessQuestion,
    answerSnippet: answerSnippet.slice(0, 1200),
    planAgents: planAgents.length ? planAgents : intent === 'db' ? ['db'] : ['rag'],
    intent,
  }
}

export function buildMemoryCaptureAckText(parsed: MemoryMetaIntentParsed): string {
  const title = parsed.title ? `「${parsed.title}」` : ''
  switch (parsed.kind) {
    case 'save_playbook':
      return `好的，我已经记住你这套查法${title}。会先存成草稿，管理员审核通过后才会在类似问题上生效。`
    case 'save_preference':
      return `好的，我已经记下你的偏好${title}。你可以在下方卡片里确认后写入。`
    case 'save_org_rule':
      return `好的，我已把这条组织规则${title}记成候选，待管理员审核后才会生效。`
    case 'save_answer':
      return title
        ? `好的，我已经帮你记住${title}这版答案。审核通过后，遇到类似问题我会优先参考它。`
        : `好的，我已经帮你记住这版答案。审核通过后，遇到类似问题我会优先参考它。`
    case 'todo':
      return title ? `好的，已记下待办：${title}。` : '好的，已记下这条待办。'
    default:
      return '好的，我已经记下了。审核通过后才会正式生效。'
  }
}
