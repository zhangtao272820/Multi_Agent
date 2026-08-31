import { z } from "zod";
import { truncateRagSessionFromUserIndex } from "../../utils/ragSessionStore";
import {
  deleteRagSessionFeedbackAtUserMessageIndex,
  deleteRagSessionFeedbackFromTurn,
  deleteRagSessionFeedbackFromUserIndex,
} from "../../utils/ragSessionFeedback";
import { supersedeRagLearningSignalsForRevision } from "../../../utils/learning_signal_store";
import { supersedeRagPromptPatchesForRevision } from "../../utils/prompt_evolution";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  fromUserIndex: z.number().int().min(0).max(500).optional(),
  fromTurnId: z.number().int().min(0).max(500).optional(),
  replaceUserText: z.string().max(8000).optional(),
  fallbackUserText: z.string().max(8000).optional(),
  userId: z.string().max(120).optional(),
});

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event));
  const auth = resolveRagHttpUser(event, body.userId);
  await assertRagSessionAccess({ sessionId: body.sessionId, userId: auth.userId });
  const fallback = String(body.fallbackUserText || body.replaceUserText || "").trim();
  if (typeof body.fromUserIndex !== "number" && !fallback) {
    throw createError({ statusCode: 400, statusMessage: "需要 fromUserIndex 或用户原文" });
  }
  const result = await truncateRagSessionFromUserIndex(
    body.sessionId,
    typeof body.fromUserIndex === "number" ? body.fromUserIndex : -1,
    {
      userId: auth.userId,
      replaceUserText: body.replaceUserText,
      fallbackUserText: fallback || undefined,
    }
  );
  if (!result.ok) {
    throw createError({ statusCode: 404, statusMessage: "找不到对应用户消息，无法截断会话" });
  }
  let feedbackDeleted = 0;
  const resolvedIdx = result.resolvedUserIndex >= 0 ? result.resolvedUserIndex : body.fromUserIndex ?? 0;
  const isRegenOrEdit = body.replaceUserText != null && body.replaceUserText !== "";
  if (isRegenOrEdit) {
    feedbackDeleted += await deleteRagSessionFeedbackAtUserMessageIndex(
      "rag",
      body.sessionId,
      resolvedIdx
    );
  } else {
    if (body.fromTurnId != null) {
      feedbackDeleted += await deleteRagSessionFeedbackFromTurn("rag", body.sessionId, body.fromTurnId);
    }
    feedbackDeleted += await deleteRagSessionFeedbackFromUserIndex("rag", body.sessionId, resolvedIdx);
  }

  // 对齐总管：撤回作废 >= idx；重生/编辑仅作废同轮
  const reason = isRegenOrEdit ? "regenerate" : "withdraw";
  const learning = await supersedeRagLearningSignalsForRevision({
    sessionId: body.sessionId,
    userMessageIndex: resolvedIdx,
    fromUserMessageIndex: isRegenOrEdit ? null : resolvedIdx,
    reason,
  });
  const patches = supersedeRagPromptPatchesForRevision({
    sessionId: body.sessionId,
    userMessageIndex: resolvedIdx,
    fromUserMessageIndex: isRegenOrEdit ? null : resolvedIdx,
    reason,
  });

  return {
    ok: true,
    sessionId: body.sessionId,
    userCount: result.userCount,
    messageCount: result.messages.length,
    feedbackDeleted,
    learningSuperseded: learning.superseded,
    patchesVoided: patches.voided,
    resolvedUserIndex: resolvedIdx,
  };
});
