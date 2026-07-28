/**
 * H5：确定性引用/数字 grounding 检查（非完整 RAGAS）。
 */

export type EvidenceLike = { content?: string; source?: string };

/** 从答案抽取需核对的「主张数字」（含中文量词邻接） */
export function extractClaimTokens(answer: string): string[] {
  const s = String(answer ?? "");
  const found = new Set<string>();

  for (const m of s.match(/\d+(?:\.\d+)?%|\d+(?:\.\d+)?/g) ?? []) {
    if (m.length >= 1) found.add(m);
  }
  // 条款号：第X条 / 第X章
  for (const m of s.match(/第[一二三四五六七八九十百千\d]+[条款章节项]/g) ?? []) {
    found.add(m);
  }
  return [...found];
}

export function checkAnswerGroundedInEvidence(
  answer: string,
  evidence: EvidenceLike[],
  opts?: { minClaimsToCheck?: number; maxMissingRatio?: number }
): { ok: boolean; claims: string[]; missing: string[]; reason?: string } {
  const corpus = evidence.map((e) => String(e?.content ?? "")).join("\n");
  const claims = extractClaimTokens(answer);
  const minClaims = opts?.minClaimsToCheck ?? 1;
  const maxMissingRatio = opts?.maxMissingRatio ?? 0.5;

  if (claims.length < minClaims) {
    return { ok: true, claims, missing: [], reason: "no_numeric_claims" };
  }
  if (!corpus.trim()) {
    return { ok: false, claims, missing: claims, reason: "empty_evidence" };
  }

  const missing = claims.filter((c) => !corpus.includes(c));
  const ratio = missing.length / claims.length;
  if (ratio > maxMissingRatio && missing.length > 0) {
    return {
      ok: false,
      claims,
      missing,
      reason: "ungrounded_claims",
    };
  }
  return { ok: true, claims, missing };
}

/** 无充分 grounding 时的降级回答：只列证据要点 */
export function buildEvidenceOnlyFallback(
  question: string,
  evidence: EvidenceLike[],
  missing: string[]
): string {
  const lines = evidence
    .slice(0, 4)
    .map((e, i) => {
      const src = String(e.source ?? "unknown");
      const content = String(e.content ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      return `${i + 1}. [${src}] ${content}${content.length >= 220 ? "…" : ""}`;
    })
    .join("\n");
  const miss =
    missing.length > 0
      ? `\n\n（答案中的 ${missing.slice(0, 5).join("、")} 未能在证据原文中核对，已改为仅列出相关摘录。）`
      : "\n\n（未能在证据中充分核对答案要点，已改为仅列出相关摘录。）";
  return `根据知识库证据，与「${String(question || "").slice(0, 80)}」相关的摘录如下：\n${lines}${miss}`;
}
