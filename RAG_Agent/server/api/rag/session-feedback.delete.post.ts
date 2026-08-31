import { z } from "zod";
import {
  deleteRagSessionFeedbackAll,
  deleteRagSessionFeedbackAtUserMessageIndex,
  deleteRagSessionFeedbackFromTurn,
  deleteRagSessionFeedbackFromUserIndex,
} from "../../utils/ragSessionFeedback";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  fromTurnId: z.number().int().min(0).max(500).optional(),
  fromUserIndex: z.number().int().min(0).max(500).optional(),
  atUserIndexOnly: z.boolean().optional(),
  deleteAll: z.boolean().optional(),
});

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event));
  const auth = resolveRagHttpUser(event, body.userId);
  await assertRagSessionAccess({ sessionId: body.sessionId, userId: auth.userId });

  let deleted = 0;
  if (body.deleteAll) {
    deleted = await deleteRagSessionFeedbackAll("rag", body.sessionId);
  } else if (body.fromTurnId != null) {
    deleted = await deleteRagSessionFeedbackFromTurn("rag", body.sessionId, body.fromTurnId);
  } else if (body.atUserIndexOnly && body.fromUserIndex != null) {
    deleted = await deleteRagSessionFeedbackAtUserMessageIndex("rag", body.sessionId, body.fromUserIndex);
  } else if (body.fromUserIndex != null) {
    deleted = await deleteRagSessionFeedbackFromUserIndex("rag", body.sessionId, body.fromUserIndex);
  } else {
    throw createError({ statusCode: 400, statusMessage: "请指定 fromTurnId、fromUserIndex 或 deleteAll" });
  }
  return { ok: true, deleted };
});
