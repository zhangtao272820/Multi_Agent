/**
 * Y 波：当 Hybrid top-k 未召回附录/废止块时，按同源 + 主题锚点关键词回填，
 * 供 mergeVersionConflictEvidence 使用（非用户原话路由）。
 */
import type { EvidenceItem } from "./retrieval_shared";
import {
  collectVersionBackfillTerms,
  filterStaleVersionBackfillHits,
  isStaleVersionEvidence,
} from "./retrieval_shared";
import { searchKeywordCandidates } from "./vectorStore";

export async function backfillStaleVersionEvidence(params: {
  focused: EvidenceItem[];
  pool: EvidenceItem[];
  limit?: number;
}): Promise<EvidenceItem[]> {
  const focused = params.focused || [];
  const pool = params.pool || [];
  if (!focused.length) return pool;

  const alreadyHasStale =
    focused.some((e) => isStaleVersionEvidence(String(e.content ?? ""))) ||
    pool.some((e) => isStaleVersionEvidence(String(e.content ?? "")));
  // pool 已有废止块时仍可合并；仅当 focused+pool 都无废止时才打库回填
  if (alreadyHasStale) return pool;

  const { sources, terms } = collectVersionBackfillTerms(focused);
  if (!sources.length || !terms.length) return pool;

  try {
    const hits = await searchKeywordCandidates({
      terms,
      sources,
      limit: Math.max(8, Math.min(24, params.limit ?? 16)),
    });
    const asEvidence: EvidenceItem[] = hits.map((h) => ({
      content: String(h.pageContent ?? ""),
      source: String(h.metadata?.source ?? sources[0] ?? ""),
      ingest_at: h.metadata?.ingest_at ? String(h.metadata.ingest_at) : undefined,
      source_version: h.metadata?.source_version
        ? String(h.metadata.source_version)
        : undefined,
    }));
    const filtered = filterStaleVersionBackfillHits(focused, asEvidence);
    if (!filtered.length) return pool;
    return [...pool, ...filtered];
  } catch (e) {
    console.warn("[VersionBackfill] keyword search skipped:", e);
    return pool;
  }
}
