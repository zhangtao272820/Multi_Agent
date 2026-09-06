import { ChatOpenAI } from '@langchain/openai'
import { withQwenModelKwargs } from '#agent-shared/qwenModelKwargs'
import type { AgentConfig } from './types'

export function createQwenChatModel(config: AgentConfig, kind: 'planner' | 'decision' | 'vision') {
  const apiKey = String(
    config?.openaiApiKey || process.env.OPENAI_API_KEY || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
  ).trim()
  if (!apiKey) return null
  const baseURL = String(
    config?.openaiBaseUrl || process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ).trim()
  const modelName =
    kind === 'planner'
      ? String(config?.lobster?.plannerModel || process.env.LOBSTER_PLANNER_MODEL || process.env.QWEN_PLANNER_MODEL || '').trim()
      : kind === 'vision'
        ? String(config?.lobster?.visionModel || process.env.LOBSTER_VISION_MODEL || '').trim()
        : String(
            config?.lobster?.decisionModel ||
              process.env.LOBSTER_DECISION_MODEL ||
              process.env.QWEN_MODEL ||
              process.env.OPENAI_MODEL ||
              '',
          ).trim()
  if (!modelName) return null
  const maxTokens = (() => {
    const v =
      kind === 'planner'
        ? config?.lobster?.plannerMaxTokens
        : kind === 'vision'
          ? config?.lobster?.visionMaxTokens
          : config?.lobster?.decisionMaxTokens
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
    if (kind === 'planner') return 600
    if (kind === 'vision') return 420
    return 420
  })()
  return new ChatOpenAI(
    withQwenModelKwargs(modelName, {
      apiKey,
      modelName,
      configuration: { baseURL },
      temperature: 0.2,
      maxTokens,
      skipForVision: kind === 'vision',
    }) as ConstructorParameters<typeof ChatOpenAI>[0]
  )
}
