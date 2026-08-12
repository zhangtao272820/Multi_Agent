import { runLearningCurator } from "../../../utils/learning_curator";
import { ensureRateLimit } from "../../../utils/rate";

export default defineEventHandler(async (event) => {
  ensureRateLimit(event, { max: 20, refillPerSec: 5 });
  const body = (await readBody(event).catch(() => null)) as {
    autoPromote?: boolean;
    minHits?: number;
  } | null;
  // 默认不晋级：仅当请求显式 autoPromote=true 且 EVO_ALLOW_EXPERT_AUTO_PROMOTE=1 时才可能晋级
  const report = await runLearningCurator({
    autoPromote: body?.autoPromote === true,
    minHits: Number.isFinite(body?.minHits) ? Number(body!.minHits) : undefined,
  });
  return { ok: true, report };
});
