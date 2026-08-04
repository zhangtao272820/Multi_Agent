import { clearLearningData } from "../../../utils/query_learning";
import { clearRoutePreferences } from "../../../utils/query_route_policy";
import { clearPromptPatches } from "../../../utils/prompt_evolution";
import { clearQueryMetrics } from "../../../utils/query_metrics";
import { clearEvolvedBlueprint } from "../../../utils/blueprint_config";
import { clearSqlTemplates } from "../../../utils/query_sql_templates";
import { clearUserPreferences } from "../../../utils/user_preferences";
import { ensureRateLimit } from "../../../utils/rate";

type ResetScope = "all" | "learning" | "route" | "prompts" | "metrics" | "templates" | "evolved" | "preferences";

export default defineEventHandler(async (event) => {
  ensureRateLimit(event, { max: 12, refillPerSec: 2 });
  const body = await readBody<{ scope?: ResetScope; tenant_id?: string; tenantId?: string }>(event).catch(() => ({}));
  const scope: ResetScope = body?.scope ?? "all";
  const tenantId = String(body?.tenant_id || body?.tenantId || "").trim() || undefined;

  if (scope === "all" || scope === "learning") clearLearningData(tenantId);
  if (scope === "all" || scope === "route") clearRoutePreferences();
  if (scope === "all" || scope === "prompts") clearPromptPatches();
  if (scope === "all" || scope === "metrics") clearQueryMetrics();
  if (scope === "all" || scope === "templates") clearSqlTemplates();
  if (scope === "all" || scope === "evolved") clearEvolvedBlueprint();
  if (scope === "all" || scope === "preferences") clearUserPreferences();

  return { ok: true, scope, tenantId: tenantId || "default" };
});
