import {
  autoPromoteEligiblePatches,
  autoPromoteEligiblePatchesVerified,
  promotePromptPatch,
  promotePromptPatchVerified,
} from "../../../utils/prompt_evolution";
import {
  isExpertAutoPromoteAllowed,
  isPromoteVerifyRequired,
} from "#agent-shared/evolutionPromotePolicy";
import { DB_AGENT_DEFAULTS } from "../../../utils/db_agent_env";
import { ensureRateLimit } from "../../../utils/rate";

export default defineEventHandler(async (event) => {
  ensureRateLimit(event, { max: 30, refillPerSec: 10 });
  const body = (await readBody(event).catch(() => null)) as {
    patchId?: string;
    auto?: boolean;
    minHits?: number;
  } | null;

  if (body?.auto) {
    if (!isExpertAutoPromoteAllowed()) {
      return {
        ok: false,
        reason: "expert_auto_promote_disabled",
        promoted: [],
        count: 0,
      };
    }
    const minHits = Number.isFinite(body.minHits)
      ? Number(body.minHits)
      : DB_AGENT_DEFAULTS.promptPromoteMinHits;
    if (isPromoteVerifyRequired()) {
      const verified = await autoPromoteEligiblePatchesVerified(minHits);
      return { ok: true, promoted: verified.promoted, count: verified.promoted.length, verify: verified.verify };
    }
    const promoted = autoPromoteEligiblePatches(minHits);
    return { ok: true, promoted, count: promoted.length };
  }

  const patchId = String(body?.patchId ?? "").trim();
  if (!patchId) {
    throw createError({ statusCode: 400, statusMessage: "请提供 patchId 或 auto=true" });
  }

  // 人审单条：默认 verify；仅 EVO_ALLOW_UNVERIFIED_PROMOTE=1 可裸晋级
  const res = isPromoteVerifyRequired()
    ? await promotePromptPatchVerified(patchId)
    : promotePromptPatch(patchId);
  if (!res.ok) {
    throw createError({ statusCode: 400, statusMessage: res.reason });
  }
  return { ok: true, hintId: res.hintId };
});
