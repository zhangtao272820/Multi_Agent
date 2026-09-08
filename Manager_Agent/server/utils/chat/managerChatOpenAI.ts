import { ChatOpenAI } from '@langchain/openai'
import { isQwen3HybridModel, readQwenEnableThinkingFromEnv, withQwenModelKwargs } from '#agent-shared/qwenModelKwargs'
import {
  readAgentLlmMaxRetries,
  readAgentLlmRequestTimeoutMs
} from '#agent-shared/agentLlmSpeed'

export function createManagerChatOpenAI(input: {
  apiKey: string
  modelName: string
  openaiBaseUrl?: string
  temperature?: number
  maxTokens?: number
  /** 轻量 JSON/对齐调用默认关思考，避免 qwen3 混合模型拖慢 */
  skipThinking?: boolean
  /**
   * 思考开关：
   * - true：强制开（路由 thought 流 / 用户可见回答）
   * - false：强制关（结构化）
   * - undefined + honorEnvThinking：跟随 QWEN_ENABLE_THINKING / CAP_ENABLE_THINKING
   * - undefined（默认）：混合模型关（安全默认，供大量 JSON 调用方）
   */
  enableThinking?: boolean
  /** synth 等用户可见回答：尊重全局 env，不默认硬关 */
  honorEnvThinking?: boolean
}): ChatOpenAI {
  const modelName = String(input.modelName || '').trim()
  let thinkingOpts: { enableThinking?: boolean } | undefined
  if (input.skipThinking === true || input.enableThinking === false) {
    thinkingOpts = { enableThinking: false }
  } else if (input.enableThinking === true) {
    thinkingOpts = { enableThinking: true }
  } else if (input.honorEnvThinking === true) {
    thinkingOpts = { enableThinking: readQwenEnableThinkingFromEnv() }
  } else if (isQwen3HybridModel(modelName)) {
    thinkingOpts = { enableThinking: false }
  } else {
    thinkingOpts = undefined
  }
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
    thinkingOpts
  )
  return new ChatOpenAI(base as ConstructorParameters<typeof ChatOpenAI>[0])
}
