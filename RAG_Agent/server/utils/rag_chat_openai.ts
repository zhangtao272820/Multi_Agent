import { ChatOpenAI } from "@langchain/openai";
import { withQwenModelKwargs } from "#agent-shared/qwenModelKwargs";
import {
  readAgentLlmJsonMaxTokens,
  readAgentLlmMaxRetries,
  readAgentLlmRequestTimeoutMs,
  readAgentLlmSynthMaxTokens,
} from "#agent-shared/agentLlmSpeed";

export function createRagChatOpenAI(input: {
  apiKey?: string;
  model?: string;
  modelName?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  /** 轻量 JSON/condense/evidence 调用 */
  jsonTask?: boolean;
}): ChatOpenAI {
  const apiKey = String(input.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  const model = String(input.model ?? input.modelName ?? "").trim();
  const baseURL = String(input.baseURL ?? process.env.OPENAI_BASE_URL ?? "").trim();
  const maxTokens =
    typeof input.maxTokens === "number"
      ? input.maxTokens
      : input.jsonTask
        ? readAgentLlmJsonMaxTokens()
        : readAgentLlmSynthMaxTokens();
  return new ChatOpenAI(
    withQwenModelKwargs(
      model,
      {
        apiKey,
        model,
        configuration: baseURL ? { baseURL } : undefined,
        timeout: readAgentLlmRequestTimeoutMs(),
        maxRetries: readAgentLlmMaxRetries(),
        temperature: input.temperature ?? 0,
        maxTokens,
        ...(input.streaming ? { streaming: true } : {}),
      },
      // 结构化 JSON/condense/evidence 强制关；chat 回答跟随 CAP/QWEN env
      input.jsonTask ? { enableThinking: false } : undefined,
    ) as ConstructorParameters<typeof ChatOpenAI>[0],
  );
}
