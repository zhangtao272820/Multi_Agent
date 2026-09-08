/**
 * 进程内倒排 BM25：查询走 postings，禁止每次全库扫 chunk。
 * 复用 bm25_lexical.tokenizeBm25；不依赖外部搜索引擎。
 */
import { tokenizeBm25, type Bm25Doc, type Bm25Hit } from "./bm25_lexical";

export type Bm25IndexDoc = Bm25Doc & {
  id: string;
};

type Posting = { id: string; tf: number };

export type Bm25IndexStats = {
  docCount: number;
  termCount: number;
  avgDl: number;
  /** 最近一次 search 触及的 posting 条目数（非全库 N） */
  lastSearchPostingTouches: number;
};

const K1 = 1.2;
const B = 0.75;

function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function docIdFrom(doc: Bm25Doc, fallbackIndex: number): string {
  const meta = doc.metadata ?? {};
  const explicit =
    String(meta.chunk_id ?? meta.chunkId ?? meta.id ?? "").trim() ||
    "";
  if (explicit) return explicit;
  const source = String(meta.source ?? "unknown");
  const page = meta.page != null ? String(meta.page) : "";
  const hash = String(meta.content_hash ?? "").slice(0, 8);
  const head = String(doc.pageContent ?? "")
    .slice(0, 48)
    .replace(/\s+/g, "_");
  return `${source}::${page}::${hash || fallbackIndex}::${head.length}`;
}

export class Bm25InvertedIndex {
  private docs = new Map<
    string,
    {
      pageContent: string;
      metadata: Record<string, unknown>;
      dl: number;
      tf: Map<string, number>;
    }
  >();
  private postings = new Map<string, Posting[]>();
  private sumDl = 0;
  private lastSearchPostingTouches = 0;

  get size(): number {
    return this.docs.size;
  }

  getStats(): Bm25IndexStats {
    const n = this.docs.size;
    return {
      docCount: n,
      termCount: this.postings.size,
      avgDl: n > 0 ? this.sumDl / n : 0,
      lastSearchPostingTouches: this.lastSearchPostingTouches,
    };
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.sumDl = 0;
    this.lastSearchPostingTouches = 0;
  }

  upsertDoc(doc: Bm25Doc, id?: string): string {
    const docId = id || docIdFrom(doc, this.docs.size);
    if (this.docs.has(docId)) {
      this.removeDocById(docId);
    }
    const tokens = tokenizeBm25(String(doc.pageContent ?? ""));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = tokens.length;
    this.docs.set(docId, {
      pageContent: String(doc.pageContent ?? ""),
      metadata: { ...(doc.metadata ?? {}) },
      dl,
      tf,
    });
    this.sumDl += dl;
    for (const [term, f] of tf) {
      const list = this.postings.get(term) ?? [];
      list.push({ id: docId, tf: f });
      this.postings.set(term, list);
    }
    return docId;
  }

  removeDocById(id: string): boolean {
    const row = this.docs.get(id);
    if (!row) return false;
    this.sumDl -= row.dl;
    this.docs.delete(id);
    for (const term of row.tf.keys()) {
      const list = this.postings.get(term);
      if (!list) continue;
      const next = list.filter((p) => p.id !== id);
      if (next.length) this.postings.set(term, next);
      else this.postings.delete(term);
    }
    return true;
  }

  removeBySource(source: string): number {
    const src = String(source ?? "").trim();
    if (!src) return 0;
    const ids: string[] = [];
    for (const [id, row] of this.docs) {
      if (String(row.metadata?.source ?? "") === src) ids.push(id);
    }
    for (const id of ids) this.removeDocById(id);
    return ids.length;
  }

  rebuildFromDocs(docs: Bm25Doc[]): number {
    this.clear();
    let i = 0;
    for (const d of docs) {
      const content = String(d.pageContent ?? "").trim();
      if (!content) continue;
      this.upsertDoc(d, docIdFrom(d, i));
      i += 1;
    }
    return this.docs.size;
  }

  search(queryTerms: string[], limit = 24, sources?: string[]): Bm25Hit[] {
    const terms = [
      ...new Set(
        queryTerms
          .map((t) => String(t ?? "").trim().toLowerCase())
          .filter((t) => t.length >= 2)
      ),
    ];
    this.lastSearchPostingTouches = 0;
    if (!terms.length || !this.docs.size) return [];

    const sourceFilters = new Set(
      (sources ?? []).map((s) => String(s || "").trim()).filter(Boolean)
    );
    const N = this.docs.size;
    const avgDl = this.sumDl / Math.max(1, N);
    const scores = new Map<string, number>();

    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list?.length) continue;
      this.lastSearchPostingTouches += list.length;
      const df = list.length;
      const termIdf = idf(N, df);
      for (const { id, tf: f } of list) {
        const row = this.docs.get(id);
        if (!row) continue;
        if (sourceFilters.size > 0) {
          const src = String(row.metadata?.source ?? "");
          if (!sourceFilters.has(src)) continue;
        }
        const dl = row.dl;
        const denom = f + K1 * (1 - B + (B * dl) / Math.max(1, avgDl));
        const add = termIdf * ((f * (K1 + 1)) / Math.max(1e-6, denom));
        scores.set(id, (scores.get(id) ?? 0) + add);
      }
    }

    return [...scores.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, limit))
      .map(([id, bm25Score]) => {
        const row = this.docs.get(id)!;
        return {
          pageContent: row.pageContent,
          metadata: row.metadata,
          bm25Score,
        };
      });
  }

  /** 序列化（精简：只存 docs，启动后 rebuild postings） */
  toJSON(): { version: 1; docs: Bm25IndexDoc[] } {
    const docs: Bm25IndexDoc[] = [];
    for (const [id, row] of this.docs) {
      docs.push({
        id,
        pageContent: row.pageContent,
        metadata: row.metadata,
      });
    }
    return { version: 1, docs };
  }

  loadFromJSON(raw: unknown): number {
    const obj = raw as { version?: number; docs?: Bm25IndexDoc[] };
    if (!obj || !Array.isArray(obj.docs)) return 0;
    this.clear();
    for (const d of obj.docs) {
      if (!d?.pageContent) continue;
      this.upsertDoc(
        { pageContent: d.pageContent, metadata: d.metadata },
        String(d.id || "").trim() || undefined
      );
    }
    return this.docs.size;
  }
}

/** 单测 / smoke 用工厂 */
export function createBm25InvertedIndex(): Bm25InvertedIndex {
  return new Bm25InvertedIndex();
}
