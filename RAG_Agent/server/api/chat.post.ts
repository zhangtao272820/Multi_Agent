import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { resolveOrchestratedClientHistory, allowsOrchestratedDialogMerge } from "#agent-shared/turnScope";
import { createAgent } from "../utils/agent";
import { sanitizeIncomingQuestion, looksLikeManagerRetrievalTask, parseManagerRagTaskFromJson } from "../utils/incoming_question";
import { getRagAgentEnv } from "../utils/rag_agent_env";
import {
  buildFilteredAgentSummaryInjection,
  extractTopicKeywords,
  getSessionMemory,
  mergeTopics,
  updateSessionMemory,
} from "../utils/session_memory";
import { resolveUserKeyFromRequest } from "../utils/user_preferences";
import { resolveAgentUserId, checkUserAccess } from "../utils/agent_identity";
import {
  clearRetrievalUserKey,
  setRetrievalUserKey,
  setOrchestratedByManager,
  setManagerRagTask,
  setRetrievalCondenseContext,
  setRagMergedUnderstand,
} from "../utils/retrieval_context";
import { mergeRagMultiTurnUnderstand } from "../utils/rag_merged_understand";
import {
  buildRagSessionRetrievalAnchor,
  formatSessionRetrievalAnchorBlock,
} from "../utils/rag_multi_turn";
import {
  getRagSessionRetrievalAnchor,
  setRagSessionRetrievalAnchor,
} from "../utils/rag_session_anchor";
import { buildRagAgentResult, buildRagFailureResult } from "../utils/agent_result";
import { resolveAgentUsage } from "#agent-shared/agentUsage";
import { classifyRagThrownError } from "../utils/vectorReady";
import {
  findExplicitMissingDocs,
  formatDialogPreview,
  isInadequateRagAnswer,
  judgeRagPreflight,
  setRagRequestIntent,
  type RagIntentJudgment,
} from "../utils/doc_scope_judge";
import { buildExplicitDocNotFoundMessage, parseClarifyMessageFromTool } from "../utils/retrieval_shared";
import { getUploadedDocuments } from "../utils/vectorStore";
import { applyPlatformModelOverrides } from "../utils/platform_config";
import {
  extractToolOutputText,
  isUnsafeStreamToken,
  pickAssistantMessageText,
  sanitizeUserFacingAnswer,
} from "../utils/answer_sanitize";
import { runRetrieveFirstChatStream } from "../utils/retrieve_first_chat";
import { appendRagSessionTurns, readRagSession } from "../utils/ragSessionStore";
import { summarizeSessionFromTurns } from "../utils/session_summarize";

const genConversationId = () => {
  const anyCrypto: any = (globalThis as any).crypto;
  if (anyCrypto && typeof anyCrypto.randomUUID === "function") return anyCrypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

type ChatHistoryItem =
  | { role: "user" | "assistant" | "system"; content: string }
  | { type: "user" | "assistant" | "system"; content: string }
  | { role: string; content: string };

const normalizeHistory = (history: any): ChatHistoryItem[] => {
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => {
      if (!h || typeof h !== "object") return null;
      const content = typeof (h as any).content === "string" ? (h as any).content : "";
      const roleRaw = (h as any).role ?? (h as any).type ?? "";
      const role = String(roleRaw || "").toLowerCase();
      const cleaned =
        role === "assistant" || role === "ai"
          ? sanitizeUserFacingAnswer(content)
          : content;
      if (!cleaned.trim()) return null;
      return { role: role as any, content: cleaned };
    })
    .filter(Boolean) as ChatHistoryItem[];
};

const STREAM_BLOCK_NODES = new Set(["agent", "summarize"]);

function parseEvidenceFromToolOutput(outText: string): { source?: string; content?: string }[] {
  const raw = String(outText ?? "").trim();
  if (!raw) return [];

  const jsonMatch = raw.match(/\[evidence_json\]\s*([\s\S]*?)(?:\n\[|$)/);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim()) as { evidence?: Array<{ source?: string; content?: string; quote?: string }> };
      const items = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
      return items
        .map((it) => ({
          source: String(it?.source ?? "").trim() || undefined,
          content: String(it?.content ?? it?.quote ?? "").trim() || undefined,
        }))
        .filter((it) => it.source || it.content)
        .slice(0, 12);
    } catch {
      /* fall through */
    }
  }

  const blocks = raw.split(/\n{2,}/g).map((b) => b.trim()).filter(Boolean);
  const out: { source?: string; content?: string }[] = [];
  for (const b of blocks) {
    const m = b.match(/\[内容\]:\s*([\s\S]*?)(?:\n\[来源\]:\s*([\s\S]*))?$/);
    if (m) {
      const content = String(m[1] ?? "").trim();
      const source = String(m[2] ?? "").trim();
      if (content) out.push({ content, source: source || undefined });
    }
  }
  return out.slice(0, 12);
}

function stripRetrievalMeta(text: string): string {
  const marker = "[retrieval_meta]";
  const idx = String(text || "").indexOf(marker);
  return (idx >= 0 ? String(text).slice(0, idx) : String(text || "")).trim();
}

function pickStreamChunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Array.isArray(chunk)) {
    return chunk
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .join("");
  }
  return chunk != null ? String(chunk) : "";
}

const historyToMessages = (items: ChatHistoryItem[]): BaseMessage[] => {
  const out: BaseMessage[] = [];
  for (const it of items) {
    const role = String((it as any).role ?? (it as any).type ?? "").toLowerCase();
    const content = String((it as any).content ?? "");
    if (!content.trim()) continue;
    if (role === "system") out.push(new SystemMessage(content));
    else if (role === "assistant" || role === "ai") out.push(new AIMessage(content));
    else out.push(new HumanMessage(content));
  }
  return out;
};

async function persistStandaloneTurn(params: {
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
  userKey?: string;
  isManagerOrchestrated: boolean;
  enableLayeredSessionMemory: boolean;
  existingSummary?: string;
}) {
  if (params.isManagerOrchestrated) return;
  const user = String(params.userMessage || "").trim();
  const assistant = sanitizeUserFacingAnswer(String(params.assistantMessage || "").trim());
  if (!user || !assistant) return;

  await appendRagSessionTurns(
    params.sessionId,
    [
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
    { userId: params.userKey }
  );

  if (!params.enableLayeredSessionMemory) return;
  try {
    const summary = await summarizeSessionFromTurns({
      existingSummary: params.existingSummary,
      userMessage: user,
      assistantMessage: assistant,
    });
    if (summary) updateSessionMemory(params.sessionId, { summary });
  } catch (e) {
    console.warn("[RagChat] summary update failed:", e);
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { message, history = [], conversationId, userId: bodyUserId, manager_rag_task_json } = body;

  if (!message) {
    throw createError({
      statusCode: 400,
      statusMessage: "No message provided",
    });
  }

  setResponseHeader(event, "Content-Type", "text/event-stream");
  setResponseHeader(event, "Cache-Control", "no-cache");
  setResponseHeader(event, "Connection", "keep-alive");

  let aborted = false;
  event.node.req.on("close", () => {
    aborted = true;
  });

  const sendData = (data: any) => {
    if (aborted) return;
    try {
      event.node.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      aborted = true;
    }
  };

  try {
    const startedAt = Date.now();
    sendData({
      type: "phase",
      phase: "accepted",
      content: "请求已接收，正在准备检索…",
      startedAt,
    });

    await applyPlatformModelOverrides({});
    const env = getRagAgentEnv();
    let isInToolCall = false;
    let lastUsage: any = null;
    let streamedAnswer = "";
    let graphFinalAnswer = "";
    let lastToolOutput = "";
    let lastToolName = "";
    let retrievalNeedsClarify = false;
    const evidenceRows: { source?: string; content?: string }[] = [];
    const traceId = String(event.node.req.headers["x-trace-id"] ?? "").trim() || undefined;

    const providedSessionId =
      String(conversationId || "").trim() ||
      String(event.node.req.headers["x-conversation-id"] || "").trim() ||
      String(event.node.req.headers["x-session-id"] || "").trim();

    const sessionId = providedSessionId || genConversationId();
    const normalizedHistory = normalizeHistory(history);
    const hasClientHistory = normalizedHistory.length > 0;

    const rawMessage = String(message).trim();
    const managerTask = parseManagerRagTaskFromJson(
      typeof manager_rag_task_json === "string" ? manager_rag_task_json : undefined,
    );
    setManagerRagTask(managerTask);
    const sanitizedMessage = sanitizeIncomingQuestion(rawMessage, managerTask) || rawMessage;
    const isManagerOrchestrated =
      looksLikeManagerRetrievalTask(rawMessage) ||
      Boolean(managerTask) ||
      String(event.node.req.headers["x-manager-orchestrated"] ?? "").trim() === "1";
    setOrchestratedByManager(isManagerOrchestrated);

    let serverHistoryItems: ChatHistoryItem[] = [];
    if (providedSessionId && !hasClientHistory && !isManagerOrchestrated) {
      const serverSession = await readRagSession(sessionId);
      serverHistoryItems = serverSession.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    const mergedHistory = hasClientHistory ? normalizedHistory : serverHistoryItems;

    const orchestratedHistory = resolveOrchestratedClientHistory(
      managerTask?.turn_scope ?? null,
      normalizedHistory,
    );
    const effectiveHistory = isManagerOrchestrated ? orchestratedHistory : mergedHistory;
    const historyMessages = historyToMessages(effectiveHistory).slice(-12);

    let session = providedSessionId && env.enableLayeredSessionMemory && !isManagerOrchestrated
      ? getSessionMemory(sessionId)
      : { summary: "", topics: [], updatedAt: Date.now() };

    if (!isManagerOrchestrated && providedSessionId && env.enableLayeredSessionMemory) {
      const topics = mergeTopics(
        session.topics,
        extractTopicKeywords(sanitizedMessage),
        env.sessionMemoryMaxTopics
      );
      if (topics.length) updateSessionMemory(sessionId, { topics });
      session = { ...session, topics };
    }

    const hasDialogContext =
      historyMessages.length > 0 || Boolean(String(session.summary || "").trim());
    const dialogPreview = formatDialogPreview(historyMessages);

    const userKey = resolveUserKeyFromRequest({
      userId: await resolveAgentUserId({
        headerUserId: String(event.node.req.headers["x-user-id"] ?? "").trim() || undefined,
        bodyUserId: bodyUserId,
        sessionId: providedSessionId || sessionId,
        conversationId: sessionId,
        authorization: String(event.node.req.headers.authorization ?? ""),
      }),
      conversationId: providedSessionId || sessionId,
      headerUserId: String(event.node.req.headers["x-user-id"] ?? "").trim() || undefined,
      sessionId: providedSessionId || sessionId,
    });
    const access = checkUserAccess(userKey);
    if (!access.allowed) {
      throw createError({ statusCode: 403, statusMessage: access.reason || "forbidden" });
    }
    setRetrievalUserKey(userKey);

    const sessionRetrievalAnchor =
      !isManagerOrchestrated && providedSessionId
        ? getRagSessionRetrievalAnchor(sessionId)
        : null;

    const [docsForScope, mergedUnderstand] = await Promise.all([
      getUploadedDocuments(),
      mergeRagMultiTurnUnderstand({
        messages: historyMessages,
        lastUser: sanitizedMessage,
        summary: [session.summary, formatSessionRetrievalAnchorBlock(sessionRetrievalAnchor)]
          .filter(Boolean)
          .join("\n"),
        sessionAnchor: sessionRetrievalAnchor,
        skipMerge: isManagerOrchestrated && !allowsOrchestratedDialogMerge(managerTask?.turn_scope ?? null),
        suppressAnchor: Boolean(managerTask?.turn_scope?.suppress_anchor),
      }),
    ]);
    setRagMergedUnderstand(mergedUnderstand);

    const queryForPipeline =
      mergedUnderstand.effectiveQuery || sanitizedMessage;

    const preflightStartedAt = Date.now();
    sendData({ type: "phase", phase: "preflight", content: "理解问题意图…", startedAt: preflightStartedAt });
    const [ragPreflight, summaryInjection] = await Promise.all([
      judgeRagPreflight({
        query: queryForPipeline,
        uploadedDocs: docsForScope,
        hasDialogContext,
        dialogPreview,
      }),
      !isManagerOrchestrated && providedSessionId
        ? buildFilteredAgentSummaryInjection(session, sanitizedMessage)
        : Promise.resolve(""),
    ]);
    const preflightMs = Date.now() - preflightStartedAt;
    const routeLabel =
      ragPreflight.route_action === "document_query"
        ? "文档检索"
        : ragPreflight.route_action === "document_list"
          ? "文档列表"
          : ragPreflight.route_action === "document_upload"
            ? "上传指引"
            : ragPreflight.is_chitchat
              ? "直接回答"
              : ragPreflight.route_action;
    sendData({
      type: "phase",
      phase: "preflight_done",
      content: `意图：${routeLabel}${ragPreflight.route_action === "document_query" ? "，RAGFlow 检索管线" : ""}`,
      ms: preflightMs,
      detail: {
        route: ragPreflight.route_action,
        retrieveFirstOk: ragPreflight.retrieve_first_ok !== false,
        preflightMs,
      },
    });
    setRagRequestIntent(ragPreflight);

    setRetrievalCondenseContext({
      summary:
        summaryInjection ||
        String(managerTask?.dialog_anchor ?? "").trim().slice(0, 400) ||
        formatSessionRetrievalAnchorBlock(sessionRetrievalAnchor),
      messages: [
        ...(isManagerOrchestrated && managerTask?.dialog_anchor
          ? [new HumanMessage({ content: String(managerTask.dialog_anchor).slice(0, 600) })]
          : historyMessages),
        new HumanMessage({
          content: queryForPipeline,
          additional_kwargs: { raw_incoming: rawMessage },
        }),
      ],
    });

    try {
    const retrieveFirst = await runRetrieveFirstChatStream(
      {
        sanitizedMessage: queryForPipeline,
        rawMessage,
        historyMessages,
        summaryInjection,
        userKey,
        isManagerOrchestrated,
        preflight: ragPreflight,
      },
      sendData
    );

    if (retrieveFirst) {
      if (aborted) {
        sendData({ type: "aborted", ms: Date.now() - startedAt });
        event.node.res.end();
        return;
      }
      let finalAnswer = sanitizeUserFacingAnswer(retrieveFirst.answer.trim());
      const evidenceRows = retrieveFirst.evidence;

      if (!finalAnswer.trim()) {
        finalAnswer =
          "未能生成有效回答。请换一种问法，或在左侧指定已有文档名称后再试。";
      }

      if (retrieveFirst.usage) sendData({ type: "usage", usage: retrieveFirst.usage });
      const agentResult = buildRagAgentResult({
        query: sanitizedMessage,
        answer: finalAnswer,
        ms: Date.now() - startedAt,
        evidence: evidenceRows,
        trace_id: traceId,
        needsClarify: Boolean(retrieveFirst.clarifyOnly),
        usage: resolveAgentUsage({ llmUsage: retrieveFirst.usage, answerText: finalAnswer }),
        retrievalFailureMode: retrieveFirst.retrievalFailureMode,
      });
      sendData({
        type: "phase",
        phase: "done",
        content: retrieveFirst.clarifyOnly ? "检索澄清完成" : "回答完成",
        ms: Date.now() - startedAt,
        detail: { path: "rag_pipeline", mode: retrieveFirst.workflowMode },
      });
      sendData({ type: "agentResult", agentResult, evidence: evidenceRows });
      sendData({ type: "done", conversationId: sessionId, answer: finalAnswer, ms: Date.now() - startedAt });
      if (!aborted) {
        await persistStandaloneTurn({
          sessionId,
          userMessage: sanitizedMessage,
          assistantMessage: finalAnswer,
          userKey,
          isManagerOrchestrated,
          enableLayeredSessionMemory: env.enableLayeredSessionMemory,
          existingSummary: session.summary,
        });
      }
      event.node.res.end();
      return;
    }

    if (aborted) {
      sendData({ type: "aborted", ms: Date.now() - startedAt });
      event.node.res.end();
      return;
    }

    const useLangGraphFallback =
      ragPreflight.route_action !== "document_query" ||
      docsForScope.length === 0 ||
      ragPreflight.is_chitchat;

    if (!useLangGraphFallback) {
      const clarify =
        "知识库中暂未找到与问题直接相关的文档内容，请补充文档或调整问法。";
      sendData({ type: "token", content: clarify });
      sendData({
        type: "phase",
        phase: "done",
        content: "检索澄清完成",
        ms: Date.now() - startedAt,
        detail: { path: "rag_pipeline_empty" },
      });
      sendData({
        type: "agentResult",
        agentResult: buildRagAgentResult({
          query: sanitizedMessage,
          answer: clarify,
          ms: Date.now() - startedAt,
          evidence: [],
          trace_id: traceId,
          needsClarify: true,
          usage: resolveAgentUsage({ answerText: clarify }),
          retrievalFailureMode: "weak_evidence",
        }),
        evidence: [],
      });
      sendData({ type: "done", conversationId: sessionId, answer: clarify, ms: Date.now() - startedAt });
      if (!aborted) {
        await persistStandaloneTurn({
          sessionId,
          userMessage: sanitizedMessage,
          assistantMessage: clarify,
          userKey,
          isManagerOrchestrated,
          enableLayeredSessionMemory: env.enableLayeredSessionMemory,
          existingSummary: session.summary,
        });
      }
      event.node.res.end();
      return;
    }

    sendData({
      type: "phase",
      phase: "agent_fallback",
      content: "非文档检索意图，走 Agent 路由",
      ms: Date.now() - startedAt,
    });

    const agent = await createAgent();
    const eventStream = agent.streamEvents(
      {
        messages: [
          ...historyMessages,
          new HumanMessage({
            content: sanitizedMessage,
            additional_kwargs: { raw_incoming: rawMessage },
          }),
        ],
        summary: summaryInjection,
      },
      { version: "v2" }
    );

    for await (const eventMsg of eventStream) {
      if (aborted) break;
      const eventType = eventMsg.event;

      if (eventType === "on_chain_start" && eventMsg.name === "LangGraph") {
        sendData({ type: "phase", phase: "agent_start", content: "Agent 图启动", ms: Date.now() - startedAt });
      } else if (eventType === "on_node_start") {
        const nodeLabels: Record<string, string> = {
          agent: "决策路由",
          tools: "执行文档检索",
          generate: "组织回答",
          summarize: "更新会话摘要",
          present_tool: "整理工具结果",
        };
        const nodeName = String(eventMsg.name || "");
        const label = nodeLabels[nodeName] || `执行节点 ${nodeName}`;
        sendData({ type: "phase", phase: "node", content: label, detail: { node: nodeName } });
      }

      if (eventType === "on_chat_model_stream" && !isInToolCall) {
        const lgNode = String(eventMsg.metadata?.langgraph_node ?? "").trim();
        // 屏蔽路由/摘要节点流式输出（避免会话摘要、用户偏好块泄漏到前端）
        if (STREAM_BLOCK_NODES.has(lgNode)) continue;
        const content = eventMsg.data?.chunk?.content;
        const tokenText = pickStreamChunkText(content);
        if (tokenText && !isUnsafeStreamToken(tokenText)) {
          streamedAnswer += tokenText;
          sendData({ type: "token", content: tokenText });
        }
      }

      if (eventType === "on_chat_model_end") {
        const usage =
          eventMsg.data?.output?.usage_metadata ??
          eventMsg.data?.output?.llmOutput?.tokenUsage ??
          eventMsg.data?.output?.llmOutput?.usage ??
          null;
        if (usage) lastUsage = usage;
      }

      if (eventType === "on_tool_start") {
        isInToolCall = true;
      }
      if (eventType === "on_tool_end") {
        isInToolCall = false;
        const output = eventMsg.data?.output;
        const toolText = extractToolOutputText(output);
        sendData({ type: "tool_output", name: eventMsg.name, output: toolText });
        const toolName = String(eventMsg.name || "").toLowerCase();
        lastToolName = toolName;
        if (toolName.includes("document_query") || toolName.includes("retriev") || toolName.includes("search")) {
          const outText = toolText;
          const parsedEvidence = parseEvidenceFromToolOutput(outText);
          const metaIdx = outText.indexOf("[retrieval_meta]");
          let retrievalMeta: { ms?: number; evidenceCount?: number; rerankMode?: string; needsClarify?: boolean } = {};
          if (metaIdx >= 0) {
            try {
              retrievalMeta = JSON.parse(outText.slice(metaIdx + "[retrieval_meta]".length).trim()) as typeof retrievalMeta;
              if (retrievalMeta.needsClarify) retrievalNeedsClarify = true;
            } catch {
              /* ignore */
            }
          }
          sendData({
            type: "phase",
            phase: "tool_retrieval",
            content: `检索返回 ${retrievalMeta.evidenceCount ?? parsedEvidence.length ?? 0} 条证据${retrievalMeta.rerankMode ? `，重排 ${retrievalMeta.rerankMode}` : ""}`,
            ms: retrievalMeta.ms,
            detail: retrievalMeta,
          });
          if (parsedEvidence.length) {
            evidenceRows.push(...parsedEvidence);
          } else {
            const rows = Array.isArray(output) ? output : output?.documents || output?.results || [];
            if (Array.isArray(rows)) {
              for (const row of rows.slice(0, 8)) {
                if (!row || typeof row !== "object") continue;
                const ref = String((row as any).source || (row as any).metadata?.source || "").trim();
                const content = String((row as any).page_content || (row as any).content || "").slice(0, 200);
                if (ref || content) evidenceRows.push({ source: ref, content });
              }
            }
          }
          lastToolOutput = stripRetrievalMeta(outText);
        }
      }

      if (eventType === "on_chain_end") {
        const nodeName = String(eventMsg.name || "");
        const out = eventMsg.data?.output;
        const msgs = Array.isArray(out?.messages) ? out.messages : [];
        const aiText = pickAssistantMessageText(msgs);
        if (aiText && (nodeName === "generate" || nodeName === "present_tool" || nodeName === "agent")) {
          graphFinalAnswer = aiText;
        }
        if (nodeName === "LangGraph") {
          if (aiText) graphFinalAnswer = aiText;
          const summary = typeof out?.summary === "string" ? out.summary : null;
          if (summary !== null && providedSessionId && env.enableLayeredSessionMemory && !isManagerOrchestrated) {
            updateSessionMemory(sessionId, { summary });
          }
        }
      }
    }

    if (aborted) {
      sendData({ type: "aborted", ms: Date.now() - startedAt });
      event.node.res.end();
      return;
    }

    const clarifyFallback =
      parseClarifyMessageFromTool(lastToolOutput) ||
      "知识库中暂未找到与问题直接相关的文档内容，请补充文档或调整问法。";

    let finalAnswer = sanitizeUserFacingAnswer(streamedAnswer.trim() || graphFinalAnswer.trim());

    const isListOrUploadPath = lastToolName.includes("document_list") || lastToolName.includes("document_upload");
    const hasEvidence = evidenceRows.length > 0;
    if (!finalAnswer.trim() && retrievalNeedsClarify && !hasEvidence) {
      finalAnswer = clarifyFallback;
    } else if (retrievalNeedsClarify && !hasEvidence) {
      finalAnswer = clarifyFallback;
    } else if (
      !isListOrUploadPath &&
      finalAnswer &&
      !hasEvidence &&
      (await isInadequateRagAnswer(sanitizedMessage, finalAnswer, {
        evidenceCount: evidenceRows.length,
      }))
    ) {
      finalAnswer = clarifyFallback;
    }

    if (!finalAnswer && ragPreflight?.is_chitchat) {
      finalAnswer = "你好！我是文档助手。请先在左侧上传 PDF、Word、TXT 等资料，然后向我提问文档内容。";
    }

    if (!finalAnswer.trim()) {
      const missing = ragPreflight?.missing_documents?.length
        ? ragPreflight.missing_documents
        : await findExplicitMissingDocs([sanitizedMessage, rawMessage], docsForScope);
      if (missing.length > 0) {
        finalAnswer = buildExplicitDocNotFoundMessage(missing, docsForScope);
      }
    }

    if (!finalAnswer.trim()) {
      finalAnswer =
        "未能生成有效回答。请换一种问法，或在左侧指定已有文档名称后再试。";
    }

    if (finalAnswer && !streamedAnswer.trim()) {
      sendData({ type: "token", content: finalAnswer });
      streamedAnswer = finalAnswer;
    }

    if (lastUsage) sendData({ type: "usage", usage: lastUsage });
    const agentResult = buildRagAgentResult({
      query: sanitizedMessage,
      answer: finalAnswer,
      ms: Date.now() - startedAt,
      evidence: evidenceRows,
      trace_id: traceId,
      needsClarify: retrievalNeedsClarify && !hasEvidence,
      usage: resolveAgentUsage({ llmUsage: lastUsage, answerText: finalAnswer }),
      retrievalFailureMode:
        retrievalNeedsClarify && !hasEvidence ? "weak_evidence" : undefined,
    });
    sendData({
      type: "phase",
      phase: "done",
      content: "回答完成",
      ms: Date.now() - startedAt,
      detail: { path: "agent" },
    });
    sendData({ type: "agentResult", agentResult, evidence: evidenceRows });
    sendData({ type: "done", conversationId: sessionId, answer: finalAnswer, ms: Date.now() - startedAt });
    if (!aborted) {
      await persistStandaloneTurn({
        sessionId,
        userMessage: sanitizedMessage,
        assistantMessage: finalAnswer,
        userKey,
        isManagerOrchestrated,
        enableLayeredSessionMemory: env.enableLayeredSessionMemory,
        existingSummary: session.summary,
      });
      if (
        !isManagerOrchestrated &&
        providedSessionId &&
        mergedUnderstand.multiTurn &&
        finalAnswer.trim() &&
        !retrievalNeedsClarify
      ) {
        setRagSessionRetrievalAnchor(
          sessionId,
          buildRagSessionRetrievalAnchor({
            coalescedTask: mergedUnderstand.coalesced || mergedUnderstand.effectiveQuery,
            lastIntent: ragPreflight.route_action,
            topics: mergeTopics(session.topics, mergedUnderstand.topics, env.sessionMemoryMaxTopics),
          }),
        );
      }
    }
    event.node.res.end();
    } finally {
      clearRetrievalUserKey();
    }
  } catch (error: any) {
    clearRetrievalUserKey();
    console.error("Error in agent execution:", error);
    const code = classifyRagThrownError(error);
    const detail = String(error?.message || error || "chat_failed").slice(0, 240);
    const agentResult = buildRagFailureResult({
      error_code: code,
      detail,
      ms: undefined,
    });
    sendData({ type: "error", content: detail, error_code: code });
    sendData({ type: "agentResult", agentResult });
    event.node.res.end();
  }
});
