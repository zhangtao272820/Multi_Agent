/**
 * H2：子块召回后按 parent_id 扩展为父块文本，并去重。
 */
import { createHash } from "node:crypto";

export type ExpandableDoc = {
  pageContent: string;
  metadata?: Record<string, unknown>;
};

export function expandDocsToParent<T extends ExpandableDoc>(docs: T[], enabled = true): T[] {
  if (!enabled || !docs.length) return docs;
  const seenParent = new Set<string>();
  const seenFlat = new Set<string>();
  const out: T[] = [];

  for (const d of docs) {
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    const parentId = String(meta.parent_id ?? "").trim();
    const parentText = String(meta.parent_text ?? "").trim();

    if (parentId && parentText) {
      if (seenParent.has(parentId)) continue;
      seenParent.add(parentId);
      out.push({
        ...d,
        pageContent: parentText,
        metadata: {
          ...meta,
          chunk_level: "parent_expanded",
          expanded_from_child: true,
        },
      });
      continue;
    }

    const flatKey = `${String(meta.source ?? "")}:${String(d.pageContent ?? "").slice(0, 96)}`;
    if (seenFlat.has(flatKey)) continue;
    seenFlat.add(flatKey);
    out.push(d);
  }
  return out;
}

export function createParentId(parts: {
  source?: string;
  sectionIndex?: number | string;
  sectionHeading?: string;
  parentText: string;
}): string {
  const base = [
    String(parts.source ?? ""),
    String(parts.sectionIndex ?? ""),
    String(parts.sectionHeading ?? "").slice(0, 80),
    String(parts.parentText ?? "").slice(0, 240),
  ].join("|");
  return createHash("sha256").update(base, "utf8").digest("hex").slice(0, 16);
}
