import { clearLearningSignals } from "../../utils/rag_learning";
import { clearPromptPatches } from "../../utils/prompt_evolution";
import { clearEvolvedHints } from "../../utils/rag_evolved_config";
import { clearRagExperienceVectors } from "../../utils/experience_vectors";
import { clearUserPreferences } from "../../utils/user_preferences";
import { clearRetrievalBandit } from "../../utils/retrieval_bandit";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";

type ResetScope =
  | "all"
  | "learning"
  | "prompts"
  | "evolved"
  | "experience"
  | "preferences"
  | "eval"
  | "bandit";

function clearEvalBaseline() {
  const p = join(process.cwd(), ".data", "rag-eval-baseline.json");
  if (existsSync(p)) unlinkSync(p);
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ scope?: ResetScope; tenant_id?: string; tenantId?: string }>(event).catch(() => ({}));
  const scope: ResetScope = body?.scope ?? "all";
  const tenantId = String(body?.tenant_id || body?.tenantId || "").trim() || undefined;

  if (scope === "all" || scope === "learning") clearLearningSignals(tenantId);
  if (scope === "all" || scope === "prompts") clearPromptPatches();
  if (scope === "all" || scope === "evolved") clearEvolvedHints();
  if (scope === "all" || scope === "experience") clearRagExperienceVectors();
  if (scope === "all" || scope === "preferences") clearUserPreferences();
  if (scope === "all" || scope === "bandit") clearRetrievalBandit();
  if (scope === "all" || scope === "eval") clearEvalBaseline();

  return { ok: true, scope, tenantId: tenantId || "default" };
});
