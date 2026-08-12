import {
  autoPromoteEligiblePatches,
  autoPromoteEligiblePatchesVerified,
  promotePromptPatch,
  promotePromptPatchVerified,
} from "../../utils/prompt_evolution";
import {
  isExpertAutoPromoteAllowed,
  isPromoteVerifyRequired,
} from "#agent-shared/evolutionPromotePolicy";
import { getRagAgentEnv } from "../../utils/rag_agent_env";

/**
 * RAG Prompt shadow 人审晋级（对标 DB）。
 * auto=true 仍受 EVO_ALLOW_EXPERT_AUTO_PROMOTE 门禁。
 */
export default defineEventHandler(async (event) => {
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
      : getRagAgentEnv().promptPromoteMinHits;
    if (isPromoteVerifyRequired()) {
      const verified = await autoPromoteEligiblePatchesVerified(minHits);
      return {
        ok: true,
        promoted: verified.promoted,
        count: verified.promoted.length,
        verify: verified.verify,
      };
    }
    const promoted = autoPromoteEligiblePatches(minHits);
    return { ok: true, promoted, count: promoted.length };
  }

  const patchId = String(body?.patchId ?? "").trim();
  if (!patchId) {
    throw createError({ statusCode: 400, statusMessage: "请提供 patchId 或 auto=true" });
  }

  const res = isPromoteVerifyRequired()
    ? await promotePromptPatchVerified(patchId)
    : promotePromptPatch(patchId);
  if (!res.ok) {
    throw createError({ statusCode: 400, statusMessage: res.reason });
  }
  return { ok: true, hintId: res.hintId };
});
