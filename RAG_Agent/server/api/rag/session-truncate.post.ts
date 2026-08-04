import { z } from "zod";
import { truncateRagSessionFromUserIndex } from "../../utils/ragSessionStore";
import {
  deleteRagSessionFeedbackAtUserMessageIndex,
  deleteRagSessionFeedbackFromTurn,
  deleteRagSessionFeedbackFromUserIndex,
} from "../../utils/ragSessionFeedback";

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
  const fallback = String(body.fallbackUserText || body.replaceUserText || "").trim();
  if (typeof body.fromUserIndex !== "number" && !fallback) {
    throw createError({ statusCode: 400, statusMessage: "需要 fromUserIndex 或用户原文" });
  }
  const result = await truncateRagSessionFromUserIndex(
    body.sessionId,
    typeof body.fromUserIndex === "number" ? body.fromUserIndex : -1,
    {
      userId: body.userId,
      replaceUserText: body.replaceUserText,
      fallbackUserText: fallback || undefined,
    }
  );
  if (!result.ok) {
    throw createError({ statusCode: 404, statusMessage: "找不到对应用户消息，无法截断会话" });
  }
  let feedbackDeleted = 0;
  const resolvedIdx = result.resolvedUserIndex >= 0 ? result.resolvedUserIndex : body.fromUserIndex ?? 0;
  if (body.replaceUserText != null && body.replaceUserText !== "") {
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
  return {
    ok: true,
    sessionId: body.sessionId,
    userCount: result.userCount,
    messageCount: result.messages.length,
    feedbackDeleted,
    resolvedUserIndex: resolvedIdx,
  };
});
