import { getLearningSummary } from "../utils/rag_learning";
import { getRagExperienceSummary } from "../utils/experience_vectors";
import {
  getPromptEvolutionSummary,
  listPromptPatches,
  listPromotablePatches,
} from "../utils/prompt_evolution";
import { listEvolvedHints } from "../utils/rag_evolved_config";
import { getUserPreferencesSummary } from "../utils/user_preferences";
import { getRagAgentEnv } from "../utils/rag_agent_env";

/** GET /api/learning — 供 Evolution Hub / 控制面人审列表 */
export default defineEventHandler(() => {
  const minHits = getRagAgentEnv().promptPromoteMinHits;
  return {
    learning: getLearningSummary(),
    experience: getRagExperienceSummary(),
    promptPatches: listPromptPatches().slice(-15),
    promotablePatches: listPromotablePatches(minHits),
    evolvedHints: listEvolvedHints().slice(-10),
    evolution: getPromptEvolutionSummary(),
    userPreferences: getUserPreferencesSummary(),
    promoteMinHits: minHits,
  };
});
