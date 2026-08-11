/**
 * DB 独立端 turnScope：对齐 shared/turnScope（默认隔离，仅 continuation 带历史）。
 * Manager 侧车已有 turn_scope 时由 shouldSuppressDbHistory 处理，本模块不抢权。
 */
import { z } from 'zod'
import type { ChatOpenAI } from '@langchain/openai'
import {
  buildTurnScopePayload,
  type TurnScopeMode,
  type TurnScopePayload
} from '#agent-shared/turnScope'
import { incrementLlmCallCount } from '../llm_call_counter'
import { isDbNluFeatureEnabled } from '../db_nlu_mode'

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

export function isDbTurnScopeLlmEnabled(): boolean {
  return isDbNluFeatureEnabled('turn_scope') || process.env.DB_TURN_SCOPE_LLM !== '0'
}

function lastHumanBefore(question: string, history: Array<{ role?: string; content?: string }>): string {
  const q = String(question || '').trim()
  const humans = (history || [])
    .filter((m) => String(m?.role || '').toLowerCase() === 'user' || String(m?.role || '').toLowerCase() === 'human')
    .map((m) => String(m?.content || '').trim())
    .filter(Boolean)
  if (!humans.length) return ''
  const last = humans[humans.length - 1]
  return last === q && humans.length >= 2 ? humans[humans.length - 2] : last
}

/** 结构回退：短承接 → continuation / output_followup；否则默认隔离 */
export function classifyDbTurnScopeStructural(
  question: string,
  history: Array<{ role?: string; content?: string }>
): TurnScopePayload {
  const q = String(question || '').trim()
  if (!q) return buildTurnScopePayload('current_only', 'new_task')
  const prev = lastHumanBefore(q, history)
  if (!prev || !history?.length) return buildTurnScopePayload('current_only', 'new_task')

  const compact = q.replace(/\s+/g, '')
  const followup = ['翻译', '详细', '总结', '改成', '换种', '再说', '精简', '要点', '英文', '中文']
  if (compact.length <= 24 && followup.some((w) => compact.includes(w))) {
    return buildTurnScopePayload('continuation', 'output_followup')
  }
  const refer = ['这个', '那个', '上述', '继续', '呢', '它', '他们', '刚才', '上面', '他', '她']
  if (compact.length <= 8 && refer.some((w) => compact.includes(w))) {
    return buildTurnScopePayload('continuation', 'continuation')
  }
  if (q.length <= Math.max(48, Math.floor(prev.length * 0.52))) {
    return buildTurnScopePayload('continuation', 'continuation')
  }
  if (q.length >= 40) return buildTurnScopePayload('topic_shift', 'new_task')
  return buildTurnScopePayload('current_only', 'new_task')
}

export async function classifyDbTurnScopeByLlm(
  model: ChatOpenAI | null,
  question: string,
  history: Array<{ role?: string; content?: string }>
): Promise<TurnScopePayload | null> {
  if (!model || !isDbTurnScopeLlmEnabled()) return null
  const q = String(question || '').trim()
  if (!q) return null
  const prev = lastHumanBefore(q, history)
  const histSnippet = (history || [])
    .slice(-6)
    .map((m) => `${m.role || '?'}: ${String(m.content || '').slice(0, 160)}`)
    .join('\n')
  try {
    incrementLlmCallCount(1)
    const res = await model.invoke([
      [
        'system',
        [
          '你是数据库对话轮次范围判定器。只判断本轮是否承接上文，不决定查哪张表。',
          'mode: current_only | continuation | topic_shift | chitchat',
          '自包含新查询 → current_only 或 topic_shift；短句指代承接 → continuation。',
          '只输出 JSON：{"mode":"...","confidence":0-1,"turn_kind":"new_task|continuation|output_followup|chitchat"}'
        ].join('\n')
      ],
      [
        'human',
        `【末轮】\n${q.slice(0, 600)}\n\n【上一用户句】\n${prev.slice(0, 400) || '（无）'}\n\n【近期】\n${histSnippet.slice(0, 1200) || '（无）'}`
      ]
    ])
    const parsed = TurnScopeSchema.safeParse(safeJsonParse(String((res as { content?: string })?.content ?? '')))
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
export async function resolveDbStandaloneTurnScope(input: {
  question: string
  chatHistory: Array<{ role?: string; content?: string }>
  managerTurnScope?: TurnScopePayload | null
  model?: ChatOpenAI | null
}): Promise<TurnScopePayload> {
  if (input.managerTurnScope) return input.managerTurnScope
  const llm = await classifyDbTurnScopeByLlm(input.model ?? null, input.question, input.chatHistory)
  if (llm) return llm
  return classifyDbTurnScopeStructural(input.question, input.chatHistory)
}
