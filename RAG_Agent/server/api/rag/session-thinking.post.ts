import { z } from "zod";
import { patchLastAssistantThinking } from "../../utils/ragSessionStore";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const StepSchema = z.object({
  kind: z.string().max(40).optional(),
  phase: z.string().max(40).optional(),
  text: z.string().min(1).max(500),
  name: z.string().max(80).optional(),
  ms: z.number().finite().optional(),
  at: z.number().finite().optional(),
});

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  processSteps: z.array(StepSchema).max(80).optional(),
  reasoningText: z.string().max(20000).optional(),
});

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event));
  const auth = resolveRagHttpUser(event, body.userId);
  await assertRagSessionAccess({ sessionId: body.sessionId, userId: auth.userId });
  const ok = await patchLastAssistantThinking(
    body.sessionId,
    {
      processSteps: body.processSteps,
      reasoningText: body.reasoningText,
    },
    { userId: auth.userId }
  );
  return { ok, sessionId: body.sessionId };
});
