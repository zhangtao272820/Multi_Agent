import { ChatOpenAI } from '@langchain/openai'
import { isQwen3HybridModel, withQwenModelKwargs } from '#agent-shared/qwenModelKwargs'
import {
  readAgentLlmJsonMaxTokens,
  readAgentLlmMaxRetries,
  readAgentLlmRequestTimeoutMs,
  readAgentLlmSynthMaxTokens
} from '#agent-shared/agentLlmSpeed'

export function createManagerChatOpenAI(input: {
  apiKey: string
  modelName: string
  openaiBaseUrl?: string
  temperature?: number
  maxTokens?: number
  /** 轻量 JSON/对齐调用默认关思考，避免 qwen3 混合模型拖慢 */
  skipThinking?: boolean
  /** 路由流式思考：须配合 stream + MANAGER_ROUTE_THOUGHT_STREAM */
  enableThinking?: boolean
}): ChatOpenAI {
  const modelName = String(input.modelName || '').trim()
  const enableThinking = input.enableThinking === true
  const forceNoThinking =
    !enableThinking && (input.skipThinking === true || isQwen3HybridModel(modelName))
  const base = withQwenModelKwargs(
    modelName,
    {
      apiKey: input.apiKey,
      modelName,
      configuration: input.openaiBaseUrl ? { baseURL: input.openaiBaseUrl } : undefined,
      temperature: input.temperature ?? 0,
      // 路由/规划 JSON 需足够输出额度，避免 qwen3.5 默认截断
      maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : 2048,
      timeout: readAgentLlmRequestTimeoutMs(),
      maxRetries: readAgentLlmMaxRetries()
    },
    forceNoThinking ? { enableThinking: false } : enableThinking ? { enableThinking: true } : undefined
  )
  return new ChatOpenAI(base as ConstructorParameters<typeof ChatOpenAI>[0])
}
