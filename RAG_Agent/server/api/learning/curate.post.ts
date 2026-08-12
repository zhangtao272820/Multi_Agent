import { runRagLearningCurator } from "../../utils/learning_curator";

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => null)) as {
    autoPromote?: boolean;
    minHits?: number;
  } | null;
  const report = await runRagLearningCurator({
    autoPromote: body?.autoPromote === true,
    minHits: Number.isFinite(body?.minHits) ? Number(body!.minHits) : undefined,
  });
  return { ok: true, report };
});
