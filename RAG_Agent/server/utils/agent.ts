import { createRagChatOpenAI } from "./rag_chat_openai";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getUploadedDocuments } from "./vectorStore";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BaseMessage, HumanMessage, AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { sanitizeIncomingQuestion, looksLikeManagerRetrievalTask } from "./incoming_question";
import { runDocumentRetrieval } from "./document_retrieval";
import { getRagAgentEnv, chatModelName } from "./rag_agent_env";
import { judgeDocScope, getRagRequestIntent } from "./doc_scope_judge";
import {
  buildExplicitDocNotFoundMessage,
  parseClarifyMessageFromTool,
  parseRetrievalMetaFromTool,
  parseEvidenceJsonFromTool,
} from "./retrieval_shared";
import { condenseRetrievalQuery } from "./query_condense";
import { loadPlaybookBody, skillDocToToolDescription } from "./playbook_skills";
import { buildGeneratePromptTemplate, wrapRagUntrustedContext } from "./rag_playbook_prompts";
import { getRagPromptPatchesForStage } from "./prompt_evolution";
import { resolvePromptAbVariant } from "./prompt_ab_router";
import { getRetrievalUserKey, isOrchestratedByManager } from "./retrieval_context";
import { resolveRagRetrievalMode, resolveRetrievalRunParams } from "./rag_retrieval_mode";
import { formatRagDocCatalog } from "./query_plan_builder";
import {
  bumpRagAgenticToolRound,
  getRagAgenticToolRounds,
  isRagAgenticToolLoopActive,
} from "./rag_agentic_mode";

const withRetry = async <T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> => {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error.status === 429 || error.status >= 500)) {
      console.warn(`[Retry] API call failed with status ${error.status}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const loadSkillDescription = (skillName: string) => {
  try {
    const fromPlaybook = loadPlaybookBody(skillName);
    if (fromPlaybook.trim()) return fromPlaybook;
    const filePath = path.join(process.cwd(), `skills/${skillName}/skill.md`);
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    console.error(`Error loading skill ${skillName}:`, error);
    return "";
  }
};

/** 从 skill.md 提取工具 description（去 frontmatter，限制长度） */
const skillToolDescription = (loaded: string, fallback: string) => {
  return skillDocToToolDescription(loaded, fallback);
};

const documentListDesc = loadSkillDescription("document-list");
const documentQueryDesc = loadSkillDescription("document-query");
const documentUploadDesc = loadSkillDescription("document-upload");

const clampText = (text: string, maxChars: number) => {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 16))}\n...(已截断)...`;
};

const formatRecentDialogForCondense = (messages: BaseMessage[], maxMessages: number): string => {
  const slice = messages.slice(-maxMessages);
  const lines: string[] = [];
  for (const m of slice) {
    if (m instanceof HumanMessage) {
      const t = String(m.content ?? "").replace(/\s+/g, " ").trim();
      if (t) lines.push(`用户：${clampText(t, 1200)}`);
    } else if (m instanceof AIMessage) {
      const raw = typeof m.content === "string" ? m.content : "";
      const t = raw.replace(/\s+/g, " ").trim();
      if (t) lines.push(`助手：${clampText(t, 600)}`);
    }
  }
  return lines.join("\n");
};

const buildClarifyMessage = async (query: string) => {
  const docs = await getUploadedDocuments();
  const docHints = docs.slice(0, 5).map((d) => `- ${d.name}`).join("\n");
  const hintBlock = docHints ? `你当前已上传文档（节选）:\n${docHints}\n\n` : "";
  return [
    "检索到的证据不足，暂时无法给出可靠答案。",
    `${hintBlock}请补充 1-2 个关键信息后我再查：`,
    "1) 直接回复上面列表中的“文档名”（任选一个）或你关心的主题",
    "2) 时间范围/对象（例如某月份、某类人群）",
    "3) 更具体的指标/关键词（例如“补贴标准”“护理员配比”）",
    `你也可以直接改问：关于“${query}”，请先在指定文档里定位相关段落。`,
  ].join("\n");
};

const buildContextForGenerateByModel = async (params: { toolText: string; question: string }) => {
  const env = getRagAgentEnv();
  const maxContextChars = env.maxContextChars;
  const raw = String(params.toolText ?? "").trim();
  if (!raw) return "";

  const formatEvidenceItems = (items: { content?: string; source?: string; quote?: string }[]) => {
    const lines: string[] = [];
    for (const it of items.slice(0, env.maxContextSnippets)) {
      const content = String(it?.content ?? it?.quote ?? "").trim();
      const source = String(it?.source ?? "unknown").trim();
      if (!content) continue;
      lines.push(`[内容]: ${content}`);
      lines.push(`[来源]: ${source}`);
      lines.push("");
    }
    const out = lines.join("\n").trim();
    return out ? clampText(out, maxContextChars) : "";
  };

  const fromJson = parseEvidenceJsonFromTool(raw);
  if (fromJson.length) return formatEvidenceItems(fromJson);

  const jsonMarker = "[evidence_json]";
  const jsonStart = raw.indexOf(jsonMarker);
  if (jsonStart >= 0) {
    const after = raw.slice(jsonStart + jsonMarker.length).trim();
    const braceStart = after.indexOf("{");
    const braceEnd = after.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      try {
        const parsed = JSON.parse(after.slice(braceStart, braceEnd + 1));
        const items = Array.isArray(parsed?.evidence) ? parsed.evidence : Array.isArray(parsed) ? parsed : [];
        const formatted = formatEvidenceItems(items);
        if (formatted) return formatted;
      } catch {
        /* fall through */
      }
    }
  }

  const extractor = createRagChatOpenAI({
    modelName: process.env.RAG_CONTEXT_EXTRACT_MODEL ?? env.evidenceSelectModel ?? chatModelName(),
    maxTokens: 500,
  });
  const prompt = [
    "你是“检索证据抽取器”。",
    "任务：只从给定工具输出中抽取与用户问题最相关的证据，不要编造。",
    "要求：",
    "1) 忽略路由解释、调试字段、与问题无关内容。",
    "2) 仅输出 1-5 条证据；每条使用两行格式：",
    "   [内容]: ...",
    "   [来源]: ...",
    "3) 若来源缺失可写 unknown，但不要省略 [来源] 行。",
    "4) 不输出任何额外说明。",
    "",
    `用户问题：${String(params.question || "")}`,
    "",
    "工具输出：",
    raw,
  ].join("\n");
  const res = await withRetry(() => extractor.invoke(prompt));
  return clampText(String(res.content ?? "").trim(), maxContextChars);
};

const documentListSkill = tool(
  async () => {
    const docs = await getUploadedDocuments();
    return docs.length > 0
      ? `目前向量数据库中包含以下非结构化文档: ${docs.map((d) => d.name).join(", ")}`
      : "目前向量数据库中没有任何文档，请先上传。";
  },
  {
    name: "document_list",
    description: skillToolDescription(
      documentListDesc,
      "列出所有已上传的文档。当用户问“有哪些文档”、“上传了什么文件”时使用。"
    ),
  }
);

const formatRetrievalToolOutput = async (params: {
  query: string;
  rawQuery?: string;
  forceSources?: string[];
}) => {
  const intent = getRagRequestIntent();
  const docs = await getUploadedDocuments();
  const mode = resolveRagRetrievalMode({
    intent,
    corpusSize: docs.length,
    isManagerOrchestrated: isOrchestratedByManager(),
  });
  const runParams = resolveRetrievalRunParams(mode);
  const result = await runDocumentRetrieval({
    query: params.query,
    rawQuery: params.rawQuery,
    skipCondense: true,
    forceSources: params.forceSources,
    ...runParams,
  });
  const meta = {
    agenticRounds: result.agenticRounds ?? 0,
    rerankMode: result.rerankMode,
    evidenceCount: result.evidence.length,
    needsClarify: result.needsClarify,
    experienceHits: result.experienceHits ?? 0,
    abVariant: result.abVariant,
    banditArm: result.banditArm,
    ms: result.ms,
    forceSources: params.forceSources ?? [],
    toolRound: getRagAgenticToolRounds(),
  };
  return `${result.output}\n[retrieval_meta]\n${JSON.stringify(meta)}`;
};

const kbCatalogSkill = tool(
  async () => {
    const docs = await getUploadedDocuments();
    if (!docs.length) {
      return "知识库为空：尚未上传任何文档。请先引导用户上传。";
    }
    const catalog = formatRagDocCatalog(docs);
    return [
      `知识库共 ${docs.length} 份文档。请据此决定是否检索、检索哪些来源、是否需要多跳。`,
      catalog,
      "文档文件名列表：" + docs.map((d) => d.name).join(" | "),
    ].join("\n");
  },
  {
    name: "kb_catalog",
    description:
      "查看知识库目录与摘要。复杂调研时应先调用，再决定是否 retrieve / retrieve_scoped。不替代正式检索。",
  }
);

const retrieveSkill = tool(
  async ({ query, rawQuery }: { query: string; rawQuery?: string }) => {
    return formatRetrievalToolOutput({ query, rawQuery });
  },
  {
    name: "retrieve",
    description:
      "按主题从知识库混合检索相关片段。用于回答条款/定义/流程/事实。复杂问题可先 kb_catalog 再调用。",
    schema: z.object({
      query: z.string().describe("用于检索的关键词或问题"),
      rawQuery: z.string().optional().describe("用户原始问题"),
    }),
  }
);

const retrieveScopedSkill = tool(
  async ({
    query,
    sources,
    rawQuery,
  }: {
    query: string;
    sources: string[];
    rawQuery?: string;
  }) => {
    const docs = await getUploadedDocuments();
    const names = new Set(docs.map((d) => d.name));
    const forceSources = (sources || [])
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .filter((s) => names.has(s) || [...names].some((n) => n.includes(s) || s.includes(n)));
    return formatRetrievalToolOutput({
      query,
      rawQuery,
      forceSources: forceSources.length ? forceSources : undefined,
    });
  },
  {
    name: "retrieve_scoped",
    description:
      "在指定文档 sources 范围内检索。用于对比、深挖某一手册，或 catalog 选定来源后的第二跳。",
    schema: z.object({
      query: z.string().describe("检索问句"),
      sources: z.array(z.string()).min(1).describe("文档文件名列表"),
      rawQuery: z.string().optional().describe("用户原始问题"),
    }),
  }
);

const documentQuerySkill = tool(
  async ({ query, rawQuery }: { query: string; rawQuery?: string }) => {
    return formatRetrievalToolOutput({ query, rawQuery });
  },
  {
    name: "document_query",
    description: skillToolDescription(
      documentQueryDesc,
      "兼容别名：等同 retrieve。从上传文档中搜索信息。"
    ),
    schema: z.object({
      query: z.string().describe("用于检索的关键词或问题"),
      rawQuery: z.string().optional().describe("用户原始问题，用于检索保底与召回增强"),
    }),
  }
);

const documentUploadSkill = tool(
  async () => {
    return "请通过左侧侧边栏的‘上传非结构化文档’按钮进行文档上传和向量化存储。";
  },
  {
    name: "document_upload",
    description: skillToolDescription(
      documentUploadDesc,
      "获取如何上传非结构化文档的指引。当用户询问“如何上传”、“怎么增加文档”时使用。"
    ),
  }
);

const skills = [
  kbCatalogSkill,
  retrieveSkill,
  retrieveScopedSkill,
  documentListSkill,
  documentQuerySkill,
  documentUploadSkill,
];
const toolNode = new ToolNode(skills);

const RETRIEVAL_TOOL_NAMES = new Set(["retrieve", "retrieve_scoped", "document_query"]);
const PRESENT_TOOL_NAMES = new Set(["document_list", "document_upload"]);
const LOOP_TOOL_NAMES = new Set(["kb_catalog"]);

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => {
      if (y.some((m) => m.additional_kwargs?.replace)) {
        // replace 标记表示「保留这些消息作为新的精简历史」
        return y.filter((m) => m.additional_kwargs?.replace);
      }
      return x.concat(y);
    },
    default: () => [],
  }),
  summary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  context: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
});

export const createAgent = async () => {
  const model = createRagChatOpenAI({
    modelName: chatModelName(),
    streaming: true,
  }).bindTools(skills);

  const agentNode = async (state: typeof GraphState.State) => {
    const lastMessage = state.messages[state.messages.length - 1] as HumanMessage;
    const questionRaw = String(lastMessage.content);
    const question = sanitizeIncomingQuestion(questionRaw) || questionRaw.trim();

    const docs = await getUploadedDocuments();
    const intent = getRagRequestIntent() ?? (await judgeDocScope(question || questionRaw, docs));

    if (intent.route_action === "document_list") {
      return {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [{ name: "document_list", args: {}, id: `tool_call_${Date.now()}` }],
          }),
        ],
      };
    }
    if (intent.route_action === "document_upload") {
      return {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [{ name: "document_upload", args: {}, id: `tool_call_${Date.now()}` }],
          }),
        ],
      };
    }

    if (intent.missing_documents.length > 0) {
      return {
        messages: [
          new AIMessage({
            content: buildExplicitDocNotFoundMessage(intent.missing_documents, docs),
          }),
        ],
      };
    }

    const isChitchat = intent.is_chitchat;

    if (docs.length === 0 && intent.route_action === "document_query" && !isChitchat) {
      return {
        messages: [
          new AIMessage({
            content:
              "知识库中暂无任何已上传文档，无法检索相关内容。请先在左侧上传 PDF、Word、TXT 等资料后再提问。",
          }),
        ],
      };
    }

    if (
      getRagAgentEnv().preferDocumentQueryWhenDocsExist &&
      intent.route_action === "document_query" &&
      !isChitchat &&
      docs.length > 0 &&
      !isRagAgenticToolLoopActive()
    ) {
      const humanTurns = state.messages.filter((m) => m instanceof HumanMessage).length;
      const hasSummary = Boolean(String(state.summary || "").trim());
      let queryForRetrieval = question.trim();
      const shouldCondense =
        getRagAgentEnv().enableQueryCondense &&
        intent.needs_condense !== false &&
        (intent.needs_condense === true || humanTurns > 1 || hasSummary) &&
        queryForRetrieval;
      if (shouldCondense) {
        try {
          queryForRetrieval = await condenseRetrievalQuery({
            summary: state.summary,
            messages: state.messages,
            draftQuery: queryForRetrieval,
          });
        } catch (e) {
          console.warn("[Condense@forceRoute] failed, using raw question:", e);
        }
      }
      const forcedToolCall: any = {
        name: "retrieve",
        args: { query: queryForRetrieval || question, rawQuery: question },
        id: `tool_call_${Date.now()}`,
      };
      return { messages: [new AIMessage({ content: "", tool_calls: [forcedToolCall] })] };
    }

    const agenticActive = isRagAgenticToolLoopActive();
    const toolRound = getRagAgenticToolRounds();
    const maxToolRounds = getRagAgentEnv().agenticToolMaxRounds;
    const systemPrompt = new SystemMessage(
      [
        agenticActive
          ? "你是文档知识库 Agentic RAG Agent。把检索当工具，自主规划是否检索、检哪些源、是否多跳。"
          : "你是一个工具路由 Agent。你必须在需要时调用工具，否则直接回答。",
        "可用工具：",
        "- kb_catalog：查看知识库目录与摘要（复杂问题优先调用）。",
        "- retrieve：主题检索（混合检索+重排）。",
        "- retrieve_scoped：限定 sources[] 文档再检。",
        "- document_query：retrieve 兼容别名。",
        "- document_list：列出已上传文档。",
        "- document_upload：告诉用户如何上传文档。",
        "路由原则：",
        "1) 复杂对比/跨文档/多步调研：先 kb_catalog，再 retrieve 或 retrieve_scoped。",
        "2) 简单单事实：可直接 retrieve。",
        "3) 用户问有哪些文档 -> document_list。",
        "4) 用户问怎么上传 -> document_upload。",
        "5) 与文档无关 -> 直接简短回答，不要编造文档内容。",
        "6) 证据不足时可换问句或换源再检索；不要在无证据时硬答。",
        agenticActive
          ? `7) 当前是 Agentic 多跳模式，已用工具轮次 ${toolRound}/${maxToolRounds}；接近上限时根据已有证据作答或澄清。`
          : "",
        state.summary ? `历史对话摘要（仅供参考，勿复述给用户）：${state.summary}` : "历史对话摘要：暂无",
      ]
        .filter(Boolean)
        .join("\n")
    );

    const response = await withRetry(() => model.invoke([systemPrompt, ...state.messages.slice(-8)]));

    if (!(response instanceof AIMessage) || !response.tool_calls?.length) {
      return { messages: [response] };
    }

    const humanTurns = state.messages.filter((m) => m instanceof HumanMessage).length;
    const hasSummary = Boolean(String(state.summary || "").trim());
    const cachedIntent = getRagRequestIntent();
    const shouldRunCondense =
      getRagAgentEnv().enableQueryCondense &&
      cachedIntent?.needs_condense !== false &&
      (cachedIntent?.needs_condense === true || humanTurns > 1 || hasSummary) &&
      response.tool_calls.some((tc: any) => RETRIEVAL_TOOL_NAMES.has(String(tc?.name || "")));

    if (!shouldRunCondense) {
      return { messages: [response] };
    }

    const newToolCalls: any[] = [];
    for (const tc of response.tool_calls as any[]) {
      if (RETRIEVAL_TOOL_NAMES.has(String(tc?.name || "")) && tc?.args && typeof tc.args.query === "string") {
        const draft = tc.args.query.trim();
        if (draft) {
          try {
            const condensed = await condenseRetrievalQuery({
              summary: state.summary,
              messages: state.messages,
              draftQuery: draft,
            });
            newToolCalls.push({ ...tc, args: { ...tc.args, query: condensed, rawQuery: question } });
          } catch (e) {
            console.warn("[Condense] failed, using draft query:", e);
            newToolCalls.push(tc);
          }
        } else {
          newToolCalls.push(tc);
        }
      } else {
        newToolCalls.push(tc);
      }
    }

    const patched = new AIMessage({
      content: response.content,
      tool_calls: newToolCalls,
      additional_kwargs: response.additional_kwargs,
      response_metadata: response.response_metadata,
      id: response.id,
    });
    return { messages: [patched] };
  };

  const summarizeNode = async (state: typeof GraphState.State) => {
    const summary = state.summary;
    const summaryGuard = [
      "摘要规则（必须遵守）：",
      "1) 只保留：对话中已确认的客观事实、用户持续关注主题（禁止写入「用户偏好」标题或复述路由摘要）。",
      "2) 禁止写入：某一具体问题「在文档中未找到/无法确定/检索无结果/证据不足」等检索失败类表述；不要把某一题的否定答复写成全局事实。",
      "3) 不要记录助手对旧问题的补充说明、道歉或与当前主题无关的套话。",
      "4) 输出一段简洁中文摘要。",
    ].join("\n");
    let summaryPrompt = "";
    if (summary) {
      summaryPrompt = `${summaryGuard}\n\n以下是之前的对话摘要：${summary}\n\n请将以下新消息集成到摘要中，并输出符合上述规则的最新、简洁摘要。`;
    } else {
      summaryPrompt = `${summaryGuard}\n\n请根据以下对话，总结出符合上述规则的关键信息，并输出一个简洁的摘要。`;
    }

    const response = await withRetry(() =>
      createRagChatOpenAI({
        modelName: process.env.SUMMARY_MODEL ?? getRagAgentEnv().summaryModel ?? chatModelName(),
      }).invoke([new SystemMessage(summaryPrompt), ...state.messages.slice(-6)])
    );

    const messageText = (m: BaseMessage) => {
      const c = m.content;
      if (typeof c === "string") return c.trim();
      if (Array.isArray(c)) {
        return c
          .map((p) => (typeof p === "string" ? p : typeof (p as { text?: string })?.text === "string" ? (p as { text: string }).text : ""))
          .join("\n")
          .trim();
      }
      return "";
    };
    const lastAi = [...state.messages]
      .reverse()
      .find((m) => m instanceof AIMessage && !m.tool_calls?.length && messageText(m));
    const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
    const keptMessages = [lastHuman, lastAi].filter(Boolean).map((m) => {
      m!.additional_kwargs = { ...m!.additional_kwargs, replace: true };
      return m!;
    });
    return {
      summary: response.content.toString(),
      messages: keptMessages,
    };
  };

  const shouldSummarize = (state: typeof GraphState.State) => {
    if (state.messages.length > 6) {
      return "summarize";
    }
    return END;
  };

  const afterGenerate = (state: typeof GraphState.State) => {
    if (state.messages.length > 6) return "summarize";
    return END;
  };

  const shouldContinue = (state: typeof GraphState.State) => {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
      return "tools";
    }
    return END;
  };

  const afterTools = (state: typeof GraphState.State) => {
    const round = bumpRagAgenticToolRound();
    const maxRounds = getRagAgentEnv().agenticToolMaxRounds;
    const agentic = isRagAgenticToolLoopActive() && getRagAgentEnv().enableAgenticToolLoop;

    let toolNames: string[] = [];
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) {
        toolNames = msg.tool_calls.map((c: any) => String(c?.name || "")).filter(Boolean);
        break;
      }
    }

    if (toolNames.some((n) => PRESENT_TOOL_NAMES.has(n))) {
      return "present_tool";
    }

    // catalog / 规划类工具：Agentic 模式下回 agent 继续决策
    if (agentic && toolNames.some((n) => LOOP_TOOL_NAMES.has(n)) && round < maxRounds) {
      console.log(`[AgenticLoop] round=${round}/${maxRounds} tools=${toolNames.join(",")} → agent`);
      return "agent";
    }

    const didRetrieve = toolNames.some((n) => RETRIEVAL_TOOL_NAMES.has(n));
    if (didRetrieve) {
      const toolMessages = state.messages.filter((m) => m instanceof ToolMessage);
      const lastTool = toolMessages[toolMessages.length - 1];
      const meta = parseRetrievalMetaFromTool(String(lastTool?.content ?? ""));
      const evidenceCount = Number(meta?.evidenceCount ?? 0);
      const needsClarify = Boolean(meta?.needsClarify);

      // 弱证据且未达预算：允许再规划一跳
      if (agentic && (needsClarify || evidenceCount <= 0) && round < maxRounds) {
        console.log(
          `[AgenticLoop] weak evidence round=${round}/${maxRounds} evidence=${evidenceCount} → agent`
        );
        return "agent";
      }
      return "generate";
    }

    if (agentic && round < maxRounds) {
      return "agent";
    }
    return END;
  };

  const presentToolNode = async (state: typeof GraphState.State) => {
    const toolMessages = state.messages.filter((m) => m instanceof ToolMessage);
    const lastToolMessage = toolMessages[toolMessages.length - 1];
    const raw = String(lastToolMessage?.content ?? "").trim();
    if (!raw) {
      return { messages: [new AIMessage({ content: "已完成操作，但未返回可用内容。" })] };
    }
    return { messages: [new AIMessage({ content: raw })] };
  };

  const generateNode = async (state: typeof GraphState.State) => {
    const toolMessages = state.messages.filter((m) => m instanceof ToolMessage);
    // 多跳：合并所有检索类工具输出的证据
    const retrievalToolTexts = toolMessages
      .map((m) => String(m.content ?? ""))
      .filter((t) => t.includes("[evidence_json]") || t.includes("[retrieval_meta]"));
    const rawToolText =
      retrievalToolTexts.length > 0
        ? retrievalToolTexts.join("\n\n---\n\n")
        : String(toolMessages[toolMessages.length - 1]?.content ?? "");

    const humanMessages = state.messages.filter((m) => m instanceof HumanMessage);
    const lastHumanMessage = humanMessages[humanMessages.length - 1] as HumanMessage | undefined;
    const questionText = String(lastHumanMessage?.content ?? "");
    const rawIncoming = String(
      (lastHumanMessage?.additional_kwargs as { raw_incoming?: string } | undefined)?.raw_incoming ?? questionText
    );

    const retrievalMeta = parseRetrievalMetaFromTool(
      retrievalToolTexts[retrievalToolTexts.length - 1] || rawToolText
    );
    const retrievalEvidenceCount = Number(retrievalMeta?.evidenceCount ?? 0);
    if (retrievalMeta?.needsClarify && retrievalEvidenceCount === 0 && !isRagAgenticToolLoopActive()) {
      const clarifyMsg =
        parseClarifyMessageFromTool(rawToolText) || (await buildClarifyMessage(questionText));
      return { messages: [new AIMessage({ content: clarifyMsg })] };
    }

    const uploadedDocs = await getUploadedDocuments();
    const genIntent = getRagRequestIntent() ?? (await judgeDocScope(questionText || rawIncoming, uploadedDocs));
    if (genIntent.missing_documents.length > 0) {
      const msg = buildExplicitDocNotFoundMessage(genIntent.missing_documents, uploadedDocs);
      return { messages: [new AIMessage({ content: msg })] };
    }

    const contextText = await buildContextForGenerateByModel({
      toolText: rawToolText,
      question: questionText,
    });
    const evidenceCount = Number(retrievalMeta?.evidenceCount ?? 0);
    const fallbackItems = parseEvidenceJsonFromTool(rawToolText);
    // 合并多段 evidence_json
    const mergedItems = [...fallbackItems];
    for (const chunk of retrievalToolTexts.slice(0, -1)) {
      for (const it of parseEvidenceJsonFromTool(chunk)) {
        mergedItems.push(it);
      }
    }
    const envGen = getRagAgentEnv();
    let effectiveContext = contextText;
    if (!effectiveContext.trim() && mergedItems.length) {
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const it of mergedItems.slice(0, envGen.maxContextSnippets * 2)) {
        const content = String(it?.content ?? "").trim();
        const source = String(it?.source ?? "unknown").trim();
        if (!content) continue;
        const key = `${source}::${content.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`[内容]: ${content}`);
        lines.push(`[来源]: ${source}`);
        lines.push("");
      }
      effectiveContext = lines.join("\n").trim();
    }
    if (!effectiveContext.trim() || (evidenceCount === 0 && !mergedItems.length)) {
      const notFoundMsg = `当前知识库暂未找到与「${questionText}」直接相关的内容。请指定左侧已有文档名称，或上传新文档后再查。`;
      return { messages: [new AIMessage({ content: notFoundMsg })] };
    }

    const managerStyle = looksLikeManagerRetrievalTask(rawIncoming);
    const promptAbVariant = envGen.enablePromptAbTest
      ? resolvePromptAbVariant(getRetrievalUserKey(), questionText || rawIncoming)
      : "control";
    const generatePatches = envGen.enablePromptEvolution
      ? getRagPromptPatchesForStage("generate", 2, promptAbVariant)
      : "";
    const promptTemplate = buildGeneratePromptTemplate(managerStyle, generatePatches);

    const prompt = ChatPromptTemplate.fromTemplate(promptTemplate);

    const chain = prompt.pipe(
      createRagChatOpenAI({
        modelName: chatModelName(),
        streaming: true,
      })
    );

    const response = await withRetry(() =>
      chain.invoke({
        context: wrapRagUntrustedContext("rag_evidence", effectiveContext, envGen.maxContextChars + 400),
        question: questionText,
      })
    );

    return { messages: [response] };
  };

  const workflow = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("generate", generateNode)
    .addNode("present_tool", presentToolNode)
    .addNode("summarize", summarizeNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      [END]: END,
    })
    .addConditionalEdges("tools", afterTools, {
      generate: "generate",
      present_tool: "present_tool",
      agent: "agent",
      [END]: "summarize",
    })
    .addConditionalEdges("generate", afterGenerate, {
      summarize: "summarize",
      [END]: END,
    })
    .addEdge("present_tool", "summarize")
    .addConditionalEdges("summarize", shouldSummarize, {
      summarize: "summarize",
      [END]: END,
    });

  return workflow.compile();
};
