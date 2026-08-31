import { applyFeedbackToSignal } from "../../utils/query_learning";
import { removeSqlTemplatesForQuestion } from "../../utils/query_sql_templates";
import { appendPromptPatch } from "../../utils/prompt_evolution";
import { ensureRateLimit } from "../../utils/rate";
import { turnFeedbackKey, upsertDbSessionFeedback, userMessageFeedbackKey } from "../utils/dbSessionFeedback";
import { handleDbAgentFeedback } from "#agent-shared/artifactFeedbackOrchestrator";
import { normalizeArtifact } from "#agent-shared/artifactFeedbackPolicy";
import { assertDbSessionAccess, resolveDbHttpUser } from "../utils/dbRequestUser";

export default defineEventHandler(async (event) => {
  ensureRateLimit(event, { max: 40, refillPerSec: 20 });
  const body = await readBody<{
    question?: string;
    score?: number;
    comment?: string;
    session_id?: string;
    sessionId?: string;
    userId?: string;
    user_id?: string;
    turn_id?: number;
    turnId?: number;
    run_id?: string;
    runId?: string;
    user_message_index?: number;
    userMessageIndex?: number;
    artifact?: Record<string, unknown>;
  }>(event);

  const question = String(body?.question ?? "").trim();
  const score = Number(body?.score);
  const sessionId = String(body?.session_id ?? body?.sessionId ?? "").trim();
  const turnIdRaw = body?.turn_id ?? body?.turnId;
  const turnId = typeof turnIdRaw === "number" && Number.isFinite(turnIdRaw) ? Math.floor(turnIdRaw) : null;
  const runId = String(body?.run_id ?? body?.runId ?? "").trim() || null;
  const userMessageIndexRaw = body?.user_message_index ?? body?.userMessageIndex;
  const userMessageIndex =
    typeof userMessageIndexRaw === "number" && Number.isFinite(userMessageIndexRaw)
      ? Math.floor(userMessageIndexRaw)
      : null;
  const artifact = normalizeArtifact(body?.artifact);

  if (!question) {
    throw createError({ statusCode: 400, statusMessage: "question 不能为空" });
  }
  if (!Number.isFinite(score) || (score !== 1 && score !== -1)) {
    throw createError({ statusCode: 400, statusMessage: "score 须为 1 或 -1" });
  }

  if (sessionId) {
    const auth = resolveDbHttpUser(event, body?.userId ?? body?.user_id);
    await assertDbSessionAccess({ sessionId, userId: auth.userId });
  }

  applyFeedbackToSignal(question, score);
  const artifactAction = await handleDbAgentFeedback({ score, question, runId, artifact });
  if (score < 0) {
    removeSqlTemplatesForQuestion(question);
  }
  if (score < 0 && body?.comment?.trim()) {
    appendPromptPatch({
      stage: "sql",
      text: String(body.comment).trim().slice(0, 200),
      source: "feedback",
    });
  }

  if (sessionId) {
    const feedbackKey =
      userMessageIndex != null && userMessageIndex >= 0
        ? userMessageFeedbackKey(userMessageIndex)
        : runId || (turnId != null ? turnFeedbackKey(turnId) : "");
    if (feedbackKey) {
      await upsertDbSessionFeedback({
        agent: "db",
        sessionId,
        feedbackKey,
        score,
        turnId,
        userMessageIndex,
        runId,
        question: question.slice(0, 4000),
        comment: body?.comment?.trim()?.slice(0, 2000) || null,
        artifact: artifact ?? undefined,
      });
    }
  }

  return { ok: true, artifactAction: artifactAction.action };
});
