import { z } from "zod";
import { listRagSessionFeedback } from "../../utils/ragSessionFeedback";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const QuerySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export default defineEventHandler(async (event) => {
  const query = QuerySchema.parse(getQuery(event));
  const auth = resolveRagHttpUser(event, query.userId);
  await assertRagSessionAccess({ sessionId: query.sessionId, userId: auth.userId });
  const items = await listRagSessionFeedback("rag", query.sessionId);
  return {
    items: items.map((it) => ({
      feedbackKey: it.feedbackKey,
      turnId: it.turnId,
      userMessageIndex: it.userMessageIndex,
      runId: it.runId,
      score: it.score,
      question: it.question,
      updatedAt: it.updatedAt,
    })),
  };
});
