import path from "node:path";
import { z } from "zod";
import { writeRagSessionMeta, sanitizeRagSessionTitle } from "../../utils/ragSessionMeta";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";

const BodySchema = z.object({
  sessionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  title: z.string().min(1).max(80),
});

export default defineEventHandler(async (event) => {
  const body = BodySchema.parse(await readBody(event));
  const auth = resolveRagHttpUser(event, body.userId);
  await assertRagSessionAccess({ sessionId: body.sessionId, userId: auth.userId });

  const title = sanitizeRagSessionTitle(body.title);
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: "标题不能为空" });
  }
  const dataRoot = path.join(process.cwd(), ".data");
  await writeRagSessionMeta(dataRoot, body.sessionId, { title, customTitle: true });
  return { ok: true, sessionId: body.sessionId, title, customTitle: true };
});
