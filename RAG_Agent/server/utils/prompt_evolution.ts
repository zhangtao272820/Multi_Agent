/**
 * P3/P4 Prompt 进化：影子补丁 → hits 达阈值晋级稳定配置。
 * 收敛期：仅进化检索/扩展/生成措辞（EVO_AGENT_PROMPT_EXECUTION_ONLY）；不修改 Manager 路由 cap。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getRagAgentEnv } from "./rag_agent_env";
import { appendEvolvedHint, listEvolvedHints } from "./rag_evolved_config";
import type { PromptAbVariant } from "./prompt_ab_router";
import { verifyBeforePromote } from "#agent-shared/evolutionVerify";
import { promoteEvoPolicy, writeEvoShadowPolicy } from "#agent-shared/evoPolicyStore";
import { isAgentEvolutionStageAllowed, isPromoteVerifyRequired, resolveCurateAutoPromote } from "#agent-shared/evolutionPromotePolicy";

export type RagPromptPatch = {
  id: string;
  ts: string;
  stage: "retrieval" | "expansion" | "generate";
  text: string;
  source: "feedback" | "weak_evidence";
  hits: number;
  promotedAt?: string;
  promotedHintId?: string;
};

type PatchStore = { patches: RagPromptPatch[] };

function patchFile() {
  const dir = join(process.cwd(), ".data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "rag-prompt-patches.shadow.json");
}

function loadStore(): PatchStore {
  const p = patchFile();
  if (!existsSync(p)) return { patches: [] };
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as PatchStore;
    return { patches: Array.isArray(o?.patches) ? o.patches : [] };
  } catch {
    return { patches: [] };
  }
}

function saveStore(store: PatchStore) {
  writeFileSync(patchFile(), JSON.stringify({ patches: store.patches.slice(-30) }, null, 2), "utf8");
}

export function appendRagPromptPatch(input: {
  stage: RagPromptPatch["stage"];
  text: string;
  source: RagPromptPatch["source"];
}) {
  if (!isAgentEvolutionStageAllowed("rag", input.stage)) return;
  const t = String(input.text ?? "").trim().slice(0, 200);
  if (!t) return;
  const store = loadStore();
  const dup = store.patches.find((p) => !p.promotedAt && p.stage === input.stage && p.text === t);
  if (dup) {
    dup.hits += 1;
    dup.ts = new Date().toISOString();
  } else {
    store.patches.push({
      id: `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      stage: input.stage,
      text: t,
      source: input.source,
      hits: 1,
    });
  }
  saveStore(store);
  void writeEvoShadowPolicy("rag", input.stage, { text: t, source: input.source }).catch(() => undefined);
  // feedback 写 shadow 后：仅当 curate 双门（专家自动晋级 + 显式请求）才尝试晋级
  if (getRagAgentEnv().enableAutoCurateOnFeedback && resolveCurateAutoPromote(true)) {
    void autoPromoteEligiblePatchesVerified()
      .then(() => undefined)
      .catch(() => undefined);
  }
}

export function getRagPromptPatchesForStage(
  stage: RagPromptPatch["stage"],
  max = 3,
  abVariant: PromptAbVariant = "treatment"
): string {
  const evolved = abVariant === "treatment" ? listEvolvedHints(stage) : [];
  const shadow = loadStore()
    .patches.filter((p) => !p.promotedAt && p.stage === stage)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max);
  const lines: string[] = [];
  for (const h of evolved.slice(0, 2)) {
    lines.push(`- [已晋级] ${h.text}`);
  }
  for (const p of shadow) {
    lines.push(`- ${p.text}`);
  }
  if (!lines.length) return "";
  return `[进化提示·${stage}]\n${lines.join("\n")}`;
}

export function evolveFromNegativeFeedback(question: string, comment?: string) {
  const q = String(question ?? "").trim();
  if (!q) return;
  if (comment?.includes("来源")) {
    appendRagPromptPatch({
      stage: "retrieval",
      text: "负反馈涉及来源不准：优先核对文档路由与关键词召回，必要时扩大 sub_queries。",
      source: "feedback",
    });
  } else {
    appendRagPromptPatch({
      stage: "expansion",
      text: `类似「${q.slice(0, 40)}」的问法需生成更多同义检索词以提高召回。`,
      source: "feedback",
    });
  }
}

export function listPromptPatches() {
  return loadStore().patches;
}

export function listPromotablePatches(minHits?: number) {
  const env = getRagAgentEnv();
  const threshold = minHits ?? env.promptPromoteMinHits;
  return loadStore().patches.filter((p) => !p.promotedAt && p.hits >= threshold);
}

export function promotePromptPatch(
  patchId: string
): { ok: true; hintId: string } | { ok: false; reason: string } {
  const store = loadStore();
  const patch = store.patches.find((p) => p.id === patchId);
  if (!patch) return { ok: false, reason: "patch_not_found" };
  if (patch.promotedAt) return { ok: false, reason: "already_promoted" };

  const hintId = `evolved_${patch.stage}_${patch.id.slice(-8)}`;
  appendEvolvedHint({
    id: hintId,
    stage: patch.stage,
    text: patch.text,
    sourcePatchId: patch.id,
  });

  patch.promotedAt = new Date().toISOString();
  patch.promotedHintId = hintId;
  saveStore(store);
  return { ok: true, hintId };
}

export async function promotePromptPatchVerified(
  patchId: string
): Promise<{ ok: true; hintId: string } | { ok: false; reason: string }> {
  const verify = await verifyBeforePromote("rag");
  if (!verify.ok) return { ok: false, reason: `verify_failed:${verify.reason || verify.gate}` };

  const store = loadStore();
  const patch = store.patches.find((p) => p.id === patchId);
  if (!patch) return { ok: false, reason: "patch_not_found" };
  if (patch.promotedAt) return { ok: false, reason: "already_promoted" };

  const hintId = `evolved_${patch.stage}_${patch.id.slice(-8)}`;
  appendEvolvedHint({
    id: hintId,
    stage: patch.stage,
    text: patch.text,
    sourcePatchId: patch.id,
  });

  patch.promotedAt = new Date().toISOString();
  patch.promotedHintId = hintId;
  saveStore(store);

  await promoteEvoPolicy("rag", patch.stage, {
    verifyOk: true,
    shadowPayload: { hintId, text: patch.text, stage: patch.stage, sourcePatchId: patch.id },
  }).catch(() => undefined);

  return { ok: true, hintId };
}

export function autoPromoteEligiblePatches(minHits?: number) {
  if (isPromoteVerifyRequired()) return [] as string[];
  const eligible = listPromotablePatches(minHits);
  const promoted: string[] = [];
  for (const p of eligible) {
    const res = promotePromptPatch(p.id);
    if (res.ok) promoted.push(res.hintId);
  }
  return promoted;
}

export async function autoPromoteEligiblePatchesVerified(minHits?: number) {
  const verify = await verifyBeforePromote("rag");
  if (!verify.ok) return { promoted: [] as string[], verify };
  const eligible = listPromotablePatches(minHits);
  const promoted: string[] = [];
  for (const p of eligible) {
    const res = await promotePromptPatchVerified(p.id);
    if (res.ok) promoted.push(res.hintId);
  }
  return { promoted, verify };
}

export function getPromptEvolutionSummary() {
  const patches = listPromptPatches();
  const env = getRagAgentEnv();
  const minHits = env.promptPromoteMinHits;
  return {
    patchCount: patches.filter((p) => !p.promotedAt).length,
    shadowCount: patches.filter((p) => !p.promotedAt).length,
    promotedCount: patches.filter((p) => p.promotedAt).length,
    evolvedHintCount: listEvolvedHints().length,
    promotableCount: listPromotablePatches(minHits).length,
    promoteMinHits: minHits,
    retrieval: patches.filter((p) => p.stage === "retrieval" && !p.promotedAt).length,
    expansion: patches.filter((p) => p.stage === "expansion" && !p.promotedAt).length,
  };
}

export function clearPromptPatches() {
  saveStore({ patches: [] });
}
