/**
 * 多源证据保槽：pool 中对问句有正分的多个 source，focused 至少各留 1 条。
 * 解决近义「验收 md + 规范 docx」并存时引用全塌缩到单一文件。
 */
import type { EvidenceItem } from "./retrieval_shared";
import {
  distinctiveSubQueryTerms,
  scoreDocByQueryTerms,
  tokenizeForKeywordSearch,
} from "./retrieval_shared";

function evidenceKey(item: EvidenceItem): string {
  return `${item.source}:${String(item.content ?? "").slice(0, 48)}`;
}

function scoreAgainstQueries(content: string, queries: string[]): number {
  const parts = queries.map((q) => String(q || "").trim()).filter((q) => q.length >= 2);
  if (!parts.length) return scoreDocByQueryTerms(content, tokenizeForKeywordSearch(content));
  let best = 0;
  if (parts.length >= 2) {
    for (const sq of parts) {
      const terms = distinctiveSubQueryTerms(sq, parts);
      best = Math.max(best, scoreDocByQueryTerms(content, terms));
    }
  }
  for (const q of parts) {
    best = Math.max(best, scoreDocByQueryTerms(content, tokenizeForKeywordSearch(q)));
  }
  return best;
}

/**
 * 在已有 focused 上，为 pool 内「与问句相关」且尚未出现的 source 各补 1 条最优证据。
 */
export function ensureMultiSourceEvidenceSlots(
  focused: EvidenceItem[],
  pool: EvidenceItem[],
  query: string,
  subQueries: string[] = [],
  max = 6,
): EvidenceItem[] {
  const cap = Math.max(2, max);
  const list = (pool || []).filter((e) => String(e.content ?? "").trim().length >= 4);
  const base = (focused || []).filter((e) => String(e.content ?? "").trim().length >= 4);
  if (!list.length) return base.slice(0, cap);

  const queries = [
    ...subQueries.map((q) => String(q || "").trim()).filter((q) => q.length >= 4),
    String(query || "").trim(),
  ].filter(Boolean);

  const relevantBySource = new Map<string, EvidenceItem[]>();
  for (const item of list) {
    const src = String(item.source || "").trim() || "unknown";
    const score = scoreAgainstQueries(String(item.content ?? ""), queries);
    if (score <= 0) continue;
    const rows = relevantBySource.get(src) ?? [];
    rows.push(item);
    relevantBySource.set(src, rows);
  }
  if (relevantBySource.size < 2) return base.slice(0, cap);

  // 每源按相关度排序
  for (const [src, rows] of relevantBySource) {
    rows.sort(
      (a, b) =>
        scoreAgainstQueries(String(b.content ?? ""), queries) -
        scoreAgainstQueries(String(a.content ?? ""), queries),
    );
    relevantBySource.set(src, rows);
  }

  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  // 去重 focused 重复块，避免占满槽导致无法补其它源
  for (const item of base) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  const present = new Set(out.map((e) => String(e.source || "").trim() || "unknown"));

  const tryAdd = (item: EvidenceItem): boolean => {
    const key = evidenceKey(item);
    if (seen.has(key)) return false;
    if (out.length >= cap) {
      // 腾槽：丢掉末尾「同 source 已有多条」的块
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const row = out[i]!;
        const src = String(row.source || "").trim() || "unknown";
        const count = out.filter((e) => (String(e.source || "").trim() || "unknown") === src).length;
        if (count <= 1) continue;
        seen.delete(evidenceKey(row));
        out.splice(i, 1);
        break;
      }
    }
    if (out.length >= cap) return false;
    seen.add(key);
    out.push(item);
    present.add(String(item.source || "").trim() || "unknown");
    return true;
  };

  for (const [src, rows] of relevantBySource) {
    if (present.has(src)) continue;
    const best = rows[0];
    if (best) tryAdd(best);
  }

  return out.slice(0, cap);
}
