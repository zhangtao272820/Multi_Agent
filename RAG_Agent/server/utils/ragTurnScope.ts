/**
 * RAG 独立端 turnScope：对齐 shared/turnScope（默认隔离，仅 continuation 带历史）。
 * Manager 侧车 / 步进 session 优先，本模块不抢权。
 */
import { z } from 'zod'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  buildTurnScopePayload,
  type TurnScopeMode,
  type TurnScopePayload
} from '#agent-shared/turnScope'

const TurnScopeSchema = z.object({
  mode: z.enum(['current_only', 'continuation', 'topic_shift', 'chitchat']),
  confidence: z.number().min(0).max(1).optional(),
  turn_kind: z.enum(['new_task', 'continuation', 'output_followup', 'slot_answer', 'chitchat']).optional()
})

function safeJsonParse(text: string): unknown {
  const s = String(text ?? '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

export function isRagTurnScopeLlmEnabled(): boolean {
  const v = String(process.env.RAG_TURN_SCOPE_LLM ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off')
}

function lastHumanBefore(question: string, history: Array<{ role?: string; content?: string }>): string {
  const q = String(question || '').trim()
  const humans = (history || [])
    .filter((m) => {
      const r = String(m?.role || '').toLowerCase()
      return r === 'user' || r === 'human'
    })
    .map((m) => String(m?.content || '').trim())
    .filter(Boolean)
  if (!humans.length) return ''
  const last = humans[humans.length - 1]
  return last === q && humans.length >= 2 ? humans[humans.length - 2] : last
}

/** 结构回退：仅明确指代/输出加工 → continuation；自洽新问默认隔离（禁止长度启发误判） */
export function classifyRagTurnScopeStructural(
  question: string,
  history: Array<{ role?: string; content?: string }>
): TurnScopePayload {
  const q = String(question || '').trim()
  if (!q) return buildTurnScopePayload('current_only', 'new_task')
  const prev = lastHumanBefore(q, history)
  if (!prev || !history?.length) return buildTurnScopePayload('current_only', 'new_task')

  const compact = q.replace(/\s+/g, '')
  const refer = ['这个', '那个', '上述', '继续', '呢', '它', '他们', '刚才', '上面', '他', '她']
  if (compact.length <= 10 && refer.some((w) => compact.includes(w))) {
    return buildTurnScopePayload('continuation', 'continuation')
  }
  const followup = ['翻译', '详细', '总结', '改成', '换种', '再说', '精简', '要点', '英文', '中文']
  if (compact.length <= 24 && followup.some((w) => compact.includes(w))) {
    return buildTurnScopePayload('continuation', 'output_followup')
  }
  // 有上文且本轮非明确承接 → 主题切换隔离（勿用「短句=承接」）
  return buildTurnScopePayload('topic_shift', 'new_task')
}

export async function classifyRagTurnScopeByLlm(
  model: BaseChatModel | null,
  question: string,
  history: Array<{ role?: string; content?: string }>
): Promise<TurnScopePayload | null> {
  if (!model || !isRagTurnScopeLlmEnabled()) return null
  const q = String(question || '').trim()
  if (!q) return null
  if (!history?.length) return null
  const prev = lastHumanBefore(q, history)
  if (!prev) return null
  const histSnippet = (history || [])
    .slice(-6)
    .map((m) => `${m.role || '?'}: ${String(m.content || '').slice(0, 160)}`)
    .join('\n')
  try {
    const res = await model.invoke([
      [
        'system',
        [
          '你是文档助手轮次范围判定器。只判断本轮是否承接上文，不决定检索哪些文档。',
          'mode: current_only | continuation | topic_shift | chitchat',
          '自包含新问题 → current_only 或 topic_shift；短句指代承接 → continuation。',
          '只输出 JSON：{"mode":"...","confidence":0-1,"turn_kind":"new_task|continuation|output_followup|chitchat"}'
        ].join('\n')
      ],
      [
        'human',
        `【末轮】\n${q.slice(0, 600)}\n\n【上一用户句】\n${prev.slice(0, 400) || '（无）'}\n\n【近期】\n${histSnippet.slice(0, 1200) || '（无）'}`
      ]
    ])
    const parsed = TurnScopeSchema.safeParse(safeJsonParse(String((res as { content?: unknown })?.content ?? '')))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.48) return null
    const mode = parsed.data.mode as TurnScopeMode
    return buildTurnScopePayload(mode, parsed.data.turn_kind || (mode === 'continuation' ? 'continuation' : 'new_task'))
  } catch {
    return null
  }
}

/**
 * 解析本轮有效 turn_scope：Manager 侧车优先；否则独立判定。
 */
export async function resolveRagStandaloneTurnScope(input: {
  question: string
  chatHistory: Array<{ role?: string; content?: string }>
  managerTurnScope?: TurnScopePayload | null
  model?: BaseChatModel | null
}): Promise<TurnScopePayload> {
  if (input.managerTurnScope) return input.managerTurnScope
  if (!input.chatHistory?.length) {
    return classifyRagTurnScopeStructural(input.question, [])
  }
  const llm = await classifyRagTurnScopeByLlm(input.model ?? null, input.question, input.chatHistory)
  if (llm) return llm
  return classifyRagTurnScopeStructural(input.question, input.chatHistory)
}
