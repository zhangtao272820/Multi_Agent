/**
 * 文件用途：对话主链路（LangGraph 编排 + Runnable 暴露）。
 * LangGraph 节点见 utils/graph/；本文件仅组装依赖与对外工厂。
 */
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import type { DataSource } from "typeorm";
import { PGVECTOR_DIM } from "#agent-shared/agentVectorPg";
import { createAgentSkills } from "./skills";
import {
  buildRouterTemplate,
  clipText,
  createCondenseQuestionPrompt,
  normalizeIntent,
  sanitizeCondensedQuestion,
} from "./nlu";
import { createDbGraph } from "./graph/createDbGraph";
import { createPostGraphStep, createPrepareGraphInput } from "./graph/postProcess";
import { createSkillRunCtx } from "./graph/skillRunCtx";
import { createSqlAgentExecutor } from "./graph/sqlAgentExecutor";
import type { DbGraphCompileRefs, DbGraphDeps, DbGraphEarlyDeps } from "./graph/types";

const condenseQuestionPrompt = createCondenseQuestionPrompt();

export function formatChatHistory(
  messages: { role: string; content: string }[],
): BaseMessage[] {
  const history: BaseMessage[] = [];
  for (const m of messages || []) {
    const content = typeof m?.content === "string" ? m.content : "";
    if (!content) continue;
    if (m?.role === "assistant") history.push(new AIMessage(content));
    else history.push(new HumanMessage(content));
  }
  return history;
}

export function createConversationalRetrievalChain({
  model,
  nluModel,
  largerModel,
  config,
  ds,
  progress,
}: {
  model: BaseLanguageModel;
  nluModel?: BaseLanguageModel;
  largerModel?: BaseLanguageModel;
  config: {
    dbId?: string;
    domain?: string;
    enableDomainSkills?: boolean;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    openaiModel?: string;
    openaiOrchestrationModel?: string;
    openaiNluModel?: string;
    openaiAgentModel?: string;
    openaiComplexModel?: string;
    openaiEmbeddingModel?: string;
    mysql: { host: string; port: number; user: string; password: string; database: string };
    mcpServers?: Record<string, any>;
  };
  ds: DataSource;
  progress?: (text: string) => void;
}) {
  const domainEnabled = Boolean(config.enableDomainSkills);
  const embeddingConfig = {
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    embeddingModel: config.openaiEmbeddingModel,
    embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS) || PGVECTOR_DIM,
  };

  const standaloneQuestionChain = RunnableSequence.from([
    condenseQuestionPrompt,
    nluModel ?? model,
    new StringOutputParser(),
    (q: string) => {
      try {
        const shown = clipText(sanitizeCondensedQuestion(q), 160);
        progress?.(`理解意图：正在分析您的问题 "${shown || "已解析"}"`);
      } catch {}
      return q;
    },
  ]).withConfig({ runName: "RephraseQuestionChain" });

  const agentExecutor = createSqlAgentExecutor({
    ds,
    model,
    nluModel,
    largerModel,
    progress,
    config,
    embeddingConfig,
  });

  const skills = createAgentSkills({
    model,
    largerModel,
    nluModel,
    ds,
    dbId: config.dbId,
    domain: config.domain,
    enableDomainSkills: domainEnabled,
    agentExecutor,
  });

  const skillRunCtx = createSkillRunCtx();

  const routerPrompt = ChatPromptTemplate.fromTemplate(
    buildRouterTemplate(
      Object.values(skills).map((s) => ({ id: s.id, description: s.description, enabled: s.enabled })),
      domainEnabled,
    ),
  );
  const routingChain = RunnableSequence.from([
    routerPrompt,
    largerModel ?? model,
    new StringOutputParser(),
    (s: string) => normalizeIntent(s),
    (intent: string) => {
      try {
        const label = intent === "sql_agent" ? "数据分析" : intent === "person_health" ? "健康信息" : intent;
        progress?.(`规划方案：确定使用 ${label} 模式`);
      } catch {}
      return intent;
    },
  ]).withConfig({ runName: "RoutingChain" });

  const graphEarlyDeps: DbGraphEarlyDeps = { model, nluModel, largerModel, progress, standaloneQuestionChain };
  const graphDeps: DbGraphDeps = {
    ...graphEarlyDeps,
    config,
    ds,
    domainEnabled,
    skills,
    skillRunCtx,
    routingChain,
    embeddingConfig,
  };
  const compileRefs: DbGraphCompileRefs = { compiledGraph: null };
  const graph = createDbGraph({ earlyDeps: graphEarlyDeps, graphDeps, compileRefs });

  return RunnableSequence.from([
    createPrepareGraphInput({ model }),
    graph,
    createPostGraphStep({ model, largerModel, embeddingConfig }),
  ]).withConfig({ runName: "ConversationalRetrievalChain" });
}
