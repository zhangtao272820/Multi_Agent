import { recordLearningSignal, refreshArtifactPrefsCache } from "../utils/rag_learning";
import { evolveFromNegativeFeedback } from "../utils/prompt_evolution";
import { getRagAgentEnv } from "../utils/rag_agent_env";
import { turnFeedbackKey, upsertRagSessionFeedback, userMessageFeedbackKey } from "../utils/ragSessionFeedback";
import { handleRagAgentFeedback } from "#agent-shared/artifactFeedbackOrchestrator";
import { normalizeArtifact } from "#agent-shared/artifactFeedbackPolicy";
import { assertRagSessionAccess, resolveRagHttpUser } from "../utils/ragRequestUser";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    question?: string;
    score?: number;
    comment?: string;
    path?: string;
    source?: string;
    session_id?: string;
    sessionId?: string;
    conversation_id?: string;
    conversationId?: string;
    userId?: string;
    user_id?: string;
    turn_id?: number;
    turnId?: number;
    run_id?: string;
    runId?: string;
    user_message_index?: number;
    userMessageIndex?: number;
    artifact?: Record<string, unknown>;
    source_labels?: string[];
    chunk_ids?: string[];
  }>(event);

  const question = String(body?.question ?? "").trim();
  const score = Number(body?.score);
  const sessionId = String(
    body?.session_id ?? body?.sessionId ?? body?.conversation_id ?? body?.conversationId ?? ""
  ).trim();
  const turnIdRaw = body?.turn_id ?? body?.turnId;
  const turnId = typeof turnIdRaw === "number" && Number.isFinite(turnIdRaw) ? Math.floor(turnIdRaw) : null;
  const runId = String(body?.run_id ?? body?.runId ?? "").trim() || null;
  const userMessageIndexRaw = body?.user_message_index ?? body?.userMessageIndex;
  const userMessageIndex =
    typeof userMessageIndexRaw === "number" && Number.isFinite(userMessageIndexRaw)
      ? Math.floor(userMessageIndexRaw)
      : null;

  const artifactFromBody = normalizeArtifact(body?.artifact);
  const artifact =
    artifactFromBody ??
    normalizeArtifact({
      kind: "rag_retrieval",
      source_labels: body?.source_labels ?? (body?.source ? [body.source] : undefined),
      chunk_ids: body?.chunk_ids,
    });

  if (!question) {
    throw createError({ statusCode: 400, statusMessage: "question 不能为空" });
  }
  if (!Number.isFinite(score) || (score !== 1 && score !== -1)) {
    throw createError({ statusCode: 400, statusMessage: "score 须为 1 或 -1" });
  }

  if (sessionId) {
    const auth = resolveRagHttpUser(event, body?.userId ?? body?.user_id);
    await assertRagSessionAccess({ sessionId, userId: auth.userId });
  }

  recordLearningSignal({
    question: question.slice(0, 500),
    score,
    comment: String(body?.comment ?? "").trim().slice(0, 300) || undefined,
    path: String(body?.path ?? "document_query").trim() || "document_query",
    source: String(body?.source ?? artifact?.source_labels?.[0] ?? "").trim() || undefined,
    sessionId: sessionId || undefined,
    userMessageIndex: userMessageIndex ?? undefined,
    runId: runId || undefined,
  });

  const artifactAction = await handleRagAgentFeedback({ score, question, runId, artifact });
  await refreshArtifactPrefsCache(true);

  if (score === -1 && getRagAgentEnv().enablePromptEvolution) {
    evolveFromNegativeFeedback(question, String(body?.comment ?? ""), {
      sessionId: sessionId || undefined,
      userMessageIndex: userMessageIndex ?? undefined,
    });
  }

  if (sessionId) {
    const feedbackKey =
      userMessageIndex != null && userMessageIndex >= 0
        ? userMessageFeedbackKey(userMessageIndex)
        : runId || (turnId != null ? turnFeedbackKey(turnId) : "");
    if (feedbackKey) {
      await upsertRagSessionFeedback({
        agent: "rag",
        sessionId,
        feedbackKey,
        score,
        turnId,
        userMessageIndex,
        runId,
        question: question.slice(0, 4000),
        comment: body?.comment?.trim()?.slice(0, 2000) || null,
        artifact: artifact ?? (body?.source ? { source: String(body.source).slice(0, 256) } : null),
      });
    }
  }

  return { ok: true, artifactAction: artifactAction.action };
});
