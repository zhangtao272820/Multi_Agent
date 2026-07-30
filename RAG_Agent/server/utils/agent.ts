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

const documentQuerySkill = tool(
  async ({ query, rawQuery }: { query: string; rawQuery?: string }) => {
    const intent = getRagRequestIntent();
    const docs = await getUploadedDocuments();
    const mode = resolveRagRetrievalMode({
      intent,
      corpusSize: docs.length,
      isManagerOrchestrated: isOrchestratedByManager(),
    });
    const runParams = resolveRetrievalRunParams(mode);
    const result = await runDocumentRetrieval({
      query,
      rawQuery,
      skipCondense: true,
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
    };
    return `${result.output}\n[retrieval_meta]\n${JSON.stringify(meta)}`;
  },
  {
    name: "document_query",
    description: skillToolDescription(
      documentQueryDesc,
      "从上传的非结构化文档中搜索信息。当用户提问关于文档内容的问题时使用。"
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

const skills = [documentListSkill, documentQuerySkill, documentUploadSkill];
const toolNode = new ToolNode(skills);

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
      docs.length > 0
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
        name: "document_query",
        args: { query: queryForRetrieval || question, rawQuery: question },
        id: `tool_call_${Date.now()}`,
      };
      return { messages: [new AIMessage({ content: "", tool_calls: [forcedToolCall] })] };
    }

    const systemPrompt = new SystemMessage(
      [
        "你是一个工具路由 Agent。你必须在需要时调用工具，否则直接回答。",
        "可用工具：",
        "- document_query：从用户上传文档中检索并返回相关片段（用于回答具体条款/定义/流程/事实）。",
        "- document_list：列出已上传文档。",
        "- document_upload：告诉用户如何上传文档。",
        "路由原则：",
        "1) 用户在问文档内容/制度/手册/SOP/条款/定义/流程 -> document_query",
        "2) 用户在问有哪些文档 -> document_list",
        "3) 用户在问怎么上传/导入 -> document_upload",
        "4) 若与文档无关 -> 直接简短回答，不要调用工具，也不要编造“文档里写了什么”。",
        "5) 调用 document_query 时，query 填写用户当前问题即可（可用自然语言）；若存在多轮或指代，系统会在检索前自动改写为自包含检索问句。",
        state.summary ? `历史对话摘要（仅供参考，勿复述给用户）：${state.summary}` : "历史对话摘要：暂无",
      ].join("\n")
    );

    const response = await withRetry(() => model.invoke([systemPrompt, ...state.messages.slice(-6)]));

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
      response.tool_calls.some((tc: any) => tc?.name === "document_query");

    if (!shouldRunCondense) {
      return { messages: [response] };
    }

    const newToolCalls: any[] = [];
    for (const tc of response.tool_calls as any[]) {
      if (tc?.name === "document_query" && tc?.args && typeof tc.args.query === "string") {
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
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolNames = msg.tool_calls.map((c: any) => c?.name).filter(Boolean);
        if (toolNames.includes("document_query")) return "generate";
        if (toolNames.includes("document_list") || toolNames.includes("document_upload")) {
          return "present_tool";
        }
        break;
      }
    }
    return END;
  };

  const presentToolNode = async (state: typeof GraphState.State) => {
    const toolMessages = state.messages.filter((m) => m instanceof ToolMessage);
    const lastToolMessage = toolMessages[toolMessages.length - 1];
    const raw = String(lastToolMessage?.content ?? "").trim();
    const humanMessages = state.messages.filter((m) => m instanceof HumanMessage);
    const question = String(humanMessages[humanMessages.length - 1]?.content ?? "").trim();
    if (!raw) {
      return { messages: [new AIMessage({ content: "已完成操作，但未返回可用内容。" })] };
    }
    const presenter = createRagChatOpenAI({
      modelName: chatModelName(),
      streaming: true,
    });
    const response = await withRetry(() =>
      presenter.invoke([
        new SystemMessage(
          "你是文档助手。根据工具返回结果，用自然、简洁的中文直接回答用户，不要提 Skill、路由或工具名称。"
        ),
        new HumanMessage(`用户问题：${question || "（无）"}\n\n工具结果：${raw}`),
      ])
    );
    return { messages: [response] };
  };

  const generateNode = async (state: typeof GraphState.State) => {
    const toolMessages = state.messages.filter((m) => m instanceof ToolMessage);
    const lastToolMessage = toolMessages[toolMessages.length - 1];
    const rawToolText = String(lastToolMessage?.content ?? "");

    const humanMessages = state.messages.filter((m) => m instanceof HumanMessage);
    const lastHumanMessage = humanMessages[humanMessages.length - 1] as HumanMessage | undefined;
    const questionText = String(lastHumanMessage?.content ?? "");
    const rawIncoming = String(
      (lastHumanMessage?.additional_kwargs as { raw_incoming?: string } | undefined)?.raw_incoming ?? questionText
    );

    const retrievalMeta = parseRetrievalMetaFromTool(rawToolText);
    const retrievalEvidenceCount = Number(retrievalMeta?.evidenceCount ?? 0);
    if (retrievalMeta?.needsClarify && retrievalEvidenceCount === 0) {
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
    const envGen = getRagAgentEnv();
    let effectiveContext = contextText;
    if (!effectiveContext.trim() && fallbackItems.length) {
      const lines: string[] = [];
      for (const it of fallbackItems.slice(0, envGen.maxContextSnippets)) {
        const content = String(it?.content ?? "").trim();
        const source = String(it?.source ?? "unknown").trim();
        if (!content) continue;
        lines.push(`[内容]: ${content}`);
        lines.push(`[来源]: ${source}`);
        lines.push("");
      }
      effectiveContext = lines.join("\n").trim();
    }
    if (!effectiveContext.trim() || (evidenceCount === 0 && !fallbackItems.length)) {
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
