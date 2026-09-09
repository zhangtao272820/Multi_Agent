/**
 * Agentic 多跳检索：证据不足时用 LLM 改写 query 再检（≤N 轮）。
 */
import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv, chatModelName } from "./rag_agent_env";
import { formatRagDocCatalog } from "./query_plan_builder";

const withRetry = async <T>(fn: () => Promise<T>, retries = 2, delay = 800): Promise<T> => {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error?.status === 429 || error?.status >= 500)) {
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

export type AgenticRewriteResult = {
  query: string;
  reason: string;
};

/** 证据不足时生成下一轮检索问句（扩词须依据知识库目录，勿编造专有名词） */
export async function rewriteQueryForAgenticRetrieval(params: {
  originalQuery: string;
  failedQuery: string;
  attempt: number;
  priorQueries?: string[];
  learningHints?: string[];
  retrievalFailureMode?: string;
  docCatalog?: { name: string; summary?: string }[];
}): Promise<AgenticRewriteResult> {
  const env = getRagAgentEnv({ docCount: params.docCatalog?.length });
  const model = createRagChatOpenAI({
    modelName: env.expansionModel ?? chatModelName(),
    temperature: 0.2,
    maxTokens: 220,
    jsonTask: true,
  });

  const prior = (params.priorQueries ?? []).filter(Boolean).slice(-4);
  const hints = (params.learningHints ?? []).filter(Boolean).slice(0, 3);
  const catalog = formatRagDocCatalog(params.docCatalog ?? []);
  const prompt = [
    "你是检索问句改写专家。上一轮检索证据不足，请生成一条更适合向量/关键词检索的中文问句。",
    "规则：",
    "1) 保留原问题核心实体、数字、时间范围；",
    "2) 可换表述、拆关键词；扩词须优先依据【知识库目录】中的文件名/摘要术语；",
    "3) 不要编造目录中未出现的专有名词；",
    "4) 只输出一条问句，不要解释、不要序号。",
    params.retrievalFailureMode === "false_negative_miss"
      ? "5) 失败类型为假阴性：上一轮可能命中近义片段但未覆盖问题核心实体；请改写以区分易混淆对象，并优先对齐【知识库目录】中不同文档的专有表述。"
      : "",
    `【知识库目录】\n${catalog}`,
    `原始问题：${params.originalQuery}`,
    `上一轮问句：${params.failedQuery}`,
    `当前是第 ${params.attempt} 次改写。`,
    params.retrievalFailureMode ? `失败类型：${params.retrievalFailureMode}` : "",
    prior.length ? `已尝试：${prior.join("；")}` : "",
    hints.length ? `历史成功策略参考（勿照搬问句；与当前问题不一致时忽略）：${hints.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await withRetry(() => model.invoke(prompt));
  let query = String(res.content ?? "")
    .trim()
    .replace(/^["'「『\s]+|["'」』\s]+$/g, "")
    .replace(/^(改写后[：:]\s*)/, "")
    .trim();

  if (!query || query.toLowerCase() === params.failedQuery.toLowerCase()) {
    const topics = String(params.originalQuery || params.failedQuery || "")
      .split(/[\s，,；;、]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2)
      .slice(0, 4);
    const fallback = topics.length ? topics.join(" ") : params.originalQuery;
    return { query: fallback.slice(0, 120), reason: "fallback_token_join" };
  }

  return { query: query.slice(0, 300), reason: "llm_rewrite" };
}

export { shouldAttemptAgenticRetry } from "./rag_agentic_retry_gate";
