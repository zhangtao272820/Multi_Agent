import { z } from 'zod'
import { safeJsonParse } from '../core/shared/llmJson'
import { createManagerChatOpenAI } from '../../utils/chat/managerChatOpenAI'
import {
  isMemoryMetaIntentLlmEnabled,
  memoryMetaIntentTimeoutMs,
  type MemoryMetaIntentKind,
  type MemoryMetaIntentParsed,
} from '../core/memory/memoryMetaIntent'

const MetaIntentSchema = z.object({
  kind: z
    .enum(['none', 'todo', 'save_answer', 'save_playbook', 'save_preference', 'save_org_rule'])
    .default('none'),
  confidence: z.number().min(0).max(1).optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  preferredAgents: z.array(z.string()).optional(),
  refusePreference: z.string().optional(),
})

export type MemoryMetaIntentLlmInput = {
  lastUserText: string
  businessQuestion: string
  answerSnippet?: string
  turnKind?: string
  memoryStructuralContext?: boolean
  hasPositiveFeedback?: boolean
  llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
}

export function resolveMemoryMetaIntentFallback(input: {
  hasPositiveFeedback?: boolean
  feedbackScore?: number | null
}): MemoryMetaIntentParsed | null {
  const fb =
    typeof input.feedbackScore === 'number' && Number.isFinite(input.feedbackScore)
      ? input.feedbackScore
      : input.hasPositiveFeedback
        ? 0.85
        : null
  if (fb == null || fb < 0.78) return null
  return {
    kind: 'save_answer',
    confidence: Math.min(1, Math.max(0.78, fb)),
    summary: '用户正反馈：固化本轮问答与证据链',
  }
}

export async function parseMemoryMetaIntentByLlm(
  input: MemoryMetaIntentLlmInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<MemoryMetaIntentParsed | null> {
  if (!isMemoryMetaIntentLlmEnabled(env)) {
    return resolveMemoryMetaIntentFallback({
      hasPositiveFeedback: input.hasPositiveFeedback,
    })
  }

  const last = String(input.lastUserText ?? '').trim()
  const biz = String(input.businessQuestion ?? '').trim()
  if (last.length < 2 && !input.hasPositiveFeedback) return null

  const key = String(input.llm?.openaiApiKey ?? env.OPENAI_API_KEY ?? '').trim()
  if (!key) {
    return resolveMemoryMetaIntentFallback({
      hasPositiveFeedback: input.hasPositiveFeedback,
    })
  }

  try {
    const modelName = String(
      env.MANAGER_MODEL_ROUTE || input.llm?.openaiModel || env.OPENAI_MODEL || 'qwen-flash-2025-07-28'
    ).trim()
    const model = createManagerChatOpenAI({
      apiKey: key,
      modelName,
      openaiBaseUrl: input.llm?.openaiBaseUrl || env.OPENAI_BASE_URL,
      temperature: 0,
      maxTokens: 320,
    })
    const answer = String(input.answerSnippet ?? '').trim().slice(0, 800)
    const turnKind = String(input.turnKind ?? '').trim()
    const res = await model.invoke(
      [
        [
          'system',
          [
            '你是「记忆元意图」解析器：判断用户末轮是否在要求固化记忆，而不是在提新业务问题。',
            '只输出 JSON；按语义理解，勿用关键词表硬匹配。',
            'kind=none：普通查询/分析/闲聊，或仅对答案满意但无保存诉求。',
            'kind=todo：记录未来要做的事（待办/提醒/截止日期），不是保存本次问答。',
            'kind=save_answer：要把本轮问答/结论/证据记住（如「这个很好帮我记住」「保存这个答案」）。',
            '若用户末轮是独立的新查数/查文档/查记录/统计问句（含专名、对象、指标），即使上轮刚保存记忆，kind 必须为 none。',
            'kind=save_playbook：要把成功查法/路径固化为打法（如「以后都这么查」「按这种方式做」「这种查法很好」）。',
            'kind=save_preference：表达长期偏好（如「我更喜欢用知识库查制度」「默认走 RAG」）。',
            'kind=save_org_rule：要求写成规则/规范/别再踩（如「写成规则」「以后都要这样」）。',
            '若 turnKind 为 output_followup/continuation 且存在上轮业务问句：优先判断是否在固化打法/偏好/答案，而非重新提问。',
            'title：4-120字，概括要固化什么；kind=none 可省略。',
            'summary：可选补充说明。',
            'preferredAgents：仅 save_preference 时，弱 hint 如 rag/db/admin（勿扩权）。',
            'schema: {"kind":"...","confidence":number,"title":string,"summary":string,"preferredAgents":string[]}',
          ].join('\n'),
        ],
        [
          'human',
          [
            `用户末轮：${last.slice(0, 500) || '（无，仅有正反馈）'}`,
            `本轮业务问句：${biz.slice(0, 600) || '（未知）'}`,
            turnKind ? `轮次语义 turnKind=${turnKind}` : '',
            input.memoryStructuralContext ? '结构：上轮已执行专才，本轮为承接/输出追问。' : '',
            answer ? `助理答案摘要：${answer}` : '',
            input.hasPositiveFeedback ? '用户已点「有用」。' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ],
      ],
      { signal: AbortSignal.timeout(memoryMetaIntentTimeoutMs(env)) }
    )
    const parsed = MetaIntentSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success) return null
    const confidence = Number(parsed.data.confidence ?? 0)
    if (confidence < 0.5) return { kind: 'none', confidence }
    const kind = parsed.data.kind as MemoryMetaIntentKind
    if (kind === 'none') return { kind: 'none', confidence }
    const title = String(parsed.data.title ?? '').trim()
    const preferredAgents = (parsed.data.preferredAgents || [])
      .map((a) => String(a || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 6)
    return {
      kind,
      confidence,
      title: title.length >= 4 ? title.slice(0, 120) : undefined,
      summary: parsed.data.summary ? String(parsed.data.summary).slice(0, 400) : undefined,
      preferencePatch:
        kind === 'save_preference' && (preferredAgents.length || parsed.data.refusePreference)
          ? {
              preferredAgents: preferredAgents.length ? preferredAgents : undefined,
              refusePreference: parsed.data.refusePreference
                ? String(parsed.data.refusePreference).slice(0, 200)
                : undefined,
            }
          : undefined,
    }
  } catch {
    return resolveMemoryMetaIntentFallback({
      hasPositiveFeedback: input.hasPositiveFeedback,
    })
  }
}
