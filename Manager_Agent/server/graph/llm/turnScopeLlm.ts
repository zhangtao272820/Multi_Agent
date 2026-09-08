import { z } from 'zod'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import { safeJsonParse } from '../core/shared/llmJson'
import type { LlmInvokeFn } from './taskConstraintsLlm'
import { routingDecisionLlmTier } from '../core/shared/modelTier'
import { formatSessionAnchorBlock, type SessionIntentAnchor } from '../core/memory/multiTurnIntent'
import { shouldRunNlCoalesce } from '../core/routing/nlResolve'
import { routingConversationContext } from '../core/text'

export const TURN_SCOPE_MODES = ['current_only', 'continuation', 'topic_shift', 'chitchat'] as const
export type TurnScopeLlmMode = (typeof TURN_SCOPE_MODES)[number]

export const TURN_KINDS = ['new_task', 'continuation', 'output_followup', 'slot_answer', 'chitchat'] as const
export type TurnKind = (typeof TURN_KINDS)[number]

export const CLARIFY_KINDS = ['none', 'slot', 'plane', 'output_disambiguation'] as const
export type ClarifyKind = (typeof CLARIFY_KINDS)[number]

export const TurnScopeLlmSchema = z.object({
  mode: z.enum(TURN_SCOPE_MODES),
  turnKind: z.enum(TURN_KINDS).default('new_task'),
  clarifyKind: z.enum(CLARIFY_KINDS).default('none'),
  directChitchatSynth: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(480).default('')
})

export type TurnScopeLlmResult = z.infer<typeof TurnScopeLlmSchema>

import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'

export function isTurnScopeLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_TURN_SCOPE_LLM', env)
}

export function turnScopeLlmFromMeta(meta: unknown): TurnScopeLlmResult | null {
  const raw = (meta as { turnScopeLlm?: unknown } | null)?.turnScopeLlm
  const parsed = TurnScopeLlmSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function humanTurnCount(messages: BaseMessage[]): number {
  return (Array.isArray(messages) ? messages : []).filter((m) =>
    String((m as { _getType?: () => string })._getType?.() || (m as { type?: string }).type || '').includes('human')
  ).length
}

/**
 * 轮次范围 LLM 节点：判定 chitchat / topic_shift / continuation / current_only。
 * 参考 Semantic Router 会话边界 + Rasa direct response：默认隔离，仅语义承接才合并历史。
 */
export async function classifyTurnScopeByLlm(input: {
  messages: BaseMessage[]
  lastUser: string
  sessionAnchor?: SessionIntentAnchor | null
  attachment?: { filePath?: string } | null
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<TurnScopeLlmResult | null> {
  if (!isTurnScopeLlmEnabled()) return null
  const last = String(input.lastUser || '').trim()
  if (!last || last.length < 1) return null
  if (input.attachment?.filePath) return null

  const turnCount = humanTurnCount(input.messages)
  const multiTurn = turnCount >= 2 && shouldRunNlCoalesce(input.messages, last)
  const ctx =
    turnCount >= 2
      ? routingConversationContext(input.messages, { maxPriorRounds: 2, maxTotalChars: 1400 })
      : last
  const anchorBlock = formatSessionAnchorBlock(input.sessionAnchor)

  try {
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        new SystemMessage(
          [
            '你是总管 Agent 的「轮次范围」判定节点。只判断本轮如何携带上下文，不决定具体 Agent。',
            '仅以【用户末轮】原文描述任务；rationale 不得从锚点/历史虚构用户未说的第二任务。',
            'mode：chitchat | topic_shift | continuation | current_only',
            'turnKind（与 mode 对齐）：',
            '- new_task：独立新任务（末轮自包含，无需依赖上轮才能执行）',
            '- continuation：短句/指代承接上一轮同一任务（继续/同上/接着改条件）',
            '- output_followup：追问上一轮**输出/结果**（如「同上面是 A 还是 B」「刚才说的是什么意思」），不是新查库任务',
            '- slot_answer：用户正在回答系统上一轮澄清问题（补全区域/对象/时间）',
            '- chitchat：寒暄确认',
            'clarifyKind（本轮是否应触发澄清，供编排参考）：',
            '- none：可执行或输出消歧，不需系统反问',
            '- slot：缺必填槽位（区域/对象/时间），须编排 needsClarify',
            '- plane：rag/db 数据面说不清且末轮无明确指向',
            '- output_disambiguation：用户对上轮结果二选一，needsClarify 应为 false',
            '末轮若本身是完整新任务（自足可执行），即使主题相近也必须 new_task + current_only，禁止 continuation。',
            '仅当末轮依赖指代/省略（同上、刚才、再细一点、只要前3名）才可 continuation。',
            '「同上面/刚才/上文」且在对上轮答案消歧 → output_followup + output_disambiguation。',
            '只输出 JSON，无 markdown。'
          ].join('\n')
        ),
        new HumanMessage(
          [
            multiTurn ? '【多轮会话】是' : '【多轮会话】否（单轮）',
            `【用户末轮】\n${last.slice(0, 900)}`,
            turnCount >= 2 ? `【近几轮对话】\n${ctx.slice(0, 1600)}` : '',
            anchorBlock,
            'schema: {"mode":"current_only|continuation|topic_shift|chitchat","turnKind":"new_task|continuation|output_followup|slot_answer|chitchat","clarifyKind":"none|slot|plane|output_disambiguation","directChitchatSynth":bool,"confidence":0-1,"rationale":"..."}'
          ]
            .filter(Boolean)
            .join('\n\n')
        )
      ],
      { tier: routingDecisionLlmTier(input.state), quiet: true }
    )
    const parsed = TurnScopeLlmSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success) return null
    if (Number(parsed.data.confidence) < 0.42) return null
    const mode = parsed.data.mode
    const turnKind = parsed.data.turnKind
    const clarifyKind = parsed.data.clarifyKind
    return {
      ...parsed.data,
      turnKind,
      clarifyKind,
      directChitchatSynth: mode === 'chitchat' || turnKind === 'chitchat' ? true : Boolean(parsed.data.directChitchatSynth)
    }
  } catch {
    return null
  }
}
