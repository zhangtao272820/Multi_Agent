import { z } from "zod";
import { deleteRagSessionArtifacts } from "../../utils/ragSessionMeta";
import { deleteRagSession } from "../../utils/ragSessionStore";
import { clearSessionMemory } from "../../utils/session_memory";
import { deleteRagSessionFeedbackAll } from "../../utils/ragSessionFeedback";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event));
  const auth = resolveRagHttpUser(event, body.userId);
  await assertRagSessionAccess({ sessionId: body.sessionId, userId: auth.userId });

  const pgDelete = await deleteRagSession(body.sessionId);
  await deleteRagSessionArtifacts(body.sessionId);
  clearSessionMemory(body.sessionId);
  const feedbackDeleted = await deleteRagSessionFeedbackAll("rag", body.sessionId);
  return {
    ok: true,
    sessionId: body.sessionId,
    userId: auth.userId,
    pgDeleted: pgDelete.pg,
    feedbackDeleted,
  };
});
