/**
 * PG jsonb / text 入库消毒：Postgres 拒绝 JSON 中的 \u0000（unsupported Unicode escape sequence）。
 * docx/OCR/旧 OLE 抽取偶发夹带 NUL 与其它 C0 控制符。
 */

/** 去掉 PG jsonb 不接受的码点；保留 \t \n \r */
export function sanitizeTextForPgJson(input: string): string {
  return String(input ?? "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "");
}

export function sanitizeMetadataForPgJson(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = sanitizeTextForPgJson(String(k));
    if (typeof v === "string") {
      out[key] = sanitizeTextForPgJson(v);
    } else if (Array.isArray(v)) {
      out[key] = v.map((item) =>
        typeof item === "string"
          ? sanitizeTextForPgJson(item)
          : item && typeof item === "object"
            ? sanitizeMetadataForPgJson(item as Record<string, unknown>)
            : item,
      );
    } else if (v && typeof v === "object") {
      out[key] = sanitizeMetadataForPgJson(v as Record<string, unknown>);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** LangChain Document 形态：写入 pgvector 前统一消毒 */
export function sanitizeDocumentForPgJson<T extends { pageContent?: string; metadata?: Record<string, unknown> }>(
  doc: T,
): T {
  const pageContent = sanitizeTextForPgJson(String(doc?.pageContent ?? ""));
  const metadata = sanitizeMetadataForPgJson(doc?.metadata ?? {});
  return { ...doc, pageContent, metadata };
}
