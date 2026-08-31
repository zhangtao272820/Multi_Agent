import { z } from "zod";
import { readRagSession } from "../../utils/ragSessionStore";
import { getSessionMemory } from "../../utils/session_memory";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const QuerySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export default defineEventHandler(async (event) => {
  const query = QuerySchema.parse(getQuery(event));
  const auth = resolveRagHttpUser(event, query.userId);
  await assertRagSessionAccess({ sessionId: query.sessionId, userId: auth.userId });
  const session = await readRagSession(query.sessionId);
  const memory = getSessionMemory(query.sessionId);
  return {
    sessionId: query.sessionId,
    messages: session.messages,
    summary: memory.summary || "",
    topics: memory.topics || [],
  };
});
