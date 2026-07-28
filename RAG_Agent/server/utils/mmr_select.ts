/**
 * H3：MMR 去冗余（相关性 vs 多样性）。
 * 有向量时用余弦；否则用 token Jaccard 近似。
 */

export type MmrCandidate<T> = {
  item: T;
  /** 与 query 的相关性（越大越好），缺省时按输入顺序递减 */
  relevance?: number;
  text: string;
  vector?: number[];
};

function tokenize(text: string): Set<string> {
  const s = String(text || "").toLowerCase();
  const out = new Set<string>();
  const cjk = s.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const t of cjk) {
    out.add(t);
    if (t.length >= 4) {
      for (let i = 0; i <= t.length - 2; i++) out.add(t.slice(i, i + 2));
    }
  }
  for (const w of s.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n <= 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-12 ? dot / d : 0;
}

function redundancy(
  cand: MmrCandidate<unknown>,
  selected: MmrCandidate<unknown>[],
  tokenCache: Map<MmrCandidate<unknown>, Set<string>>
): number {
  if (!selected.length) return 0;
  let max = 0;
  for (const s of selected) {
    let sim = 0;
    if (cand.vector?.length && s.vector?.length) {
      sim = cosine(cand.vector, s.vector);
    } else {
      const ta = tokenCache.get(cand) ?? tokenize(cand.text);
      const tb = tokenCache.get(s) ?? tokenize(s.text);
      tokenCache.set(cand, ta);
      tokenCache.set(s, tb);
      sim = jaccard(ta, tb);
    }
    if (sim > max) max = sim;
  }
  return max;
}

/**
 * @param lambda 大偏相关，小偏多样；默认 0.7
 */
export function mmrSelect<T>(
  candidates: MmrCandidate<T>[],
  topK: number,
  lambda = 0.7
): T[] {
  const k = Math.max(0, Math.min(topK, candidates.length));
  if (k === 0) return [];
  if (k >= candidates.length) return candidates.map((c) => c.item);

  const lam = Math.max(0, Math.min(1, lambda));
  const remaining = candidates.map((c, i) => ({
    ...c,
    relevance: Number.isFinite(c.relevance) ? (c.relevance as number) : candidates.length - i,
  }));
  const selected: MmrCandidate<T>[] = [];
  const tokenCache = new Map<MmrCandidate<unknown>, Set<string>>();

  while (selected.length < k && remaining.length) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      const red = redundancy(c, selected as MmrCandidate<unknown>[], tokenCache);
      const score = lam * (c.relevance as number) - (1 - lam) * red;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected.map((s) => s.item);
}
