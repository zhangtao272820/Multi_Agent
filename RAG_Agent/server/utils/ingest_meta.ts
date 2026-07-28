import { createHash } from "node:crypto";

/** 规范化正文后再哈希，避免换行差异导致无意义重嵌 */
export function normalizeCorpusText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hashCorpusText(text: string): string {
  return createHash("sha256").update(normalizeCorpusText(text), "utf8").digest("hex");
}

/** 短版本号：优先调用方传入，否则用 hash 前 12 位 */
export function resolveSourceVersion(opts: {
  explicit?: string;
  contentHash: string;
}): string {
  const explicit = String(opts.explicit ?? "").trim();
  if (explicit) return explicit.slice(0, 128);
  return opts.contentHash.slice(0, 12);
}

export function buildIngestTimestamps(now = new Date()): { ingest_at: string; processedAt: string } {
  const iso = now.toISOString();
  return { ingest_at: iso, processedAt: iso };
}

export function shortContentHash(hash: string): string {
  return String(hash || "").slice(0, 12);
}
