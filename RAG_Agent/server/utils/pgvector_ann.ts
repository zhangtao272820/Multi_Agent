/**
 * pgvector ANN 辅助：定维 / HNSW / ef_search / source 元数据索引。
 * 纯函数可契约 smoke；不连库、不调 embedding。
 */

export type PgvectorAnnParams = {
  tableName: string;
  vectorColumn: string;
  metadataColumn: string;
  dimensions: number;
  m: number;
  efConstruction: number;
  efSearch: number;
};

export type PgvectorAnnInspect = {
  hasHnsw: boolean;
  hasSourceIndex: boolean;
  embeddingType: string | null;
  /** 从 format_type / vector(N) 解析；无约束 vector 为 null */
  dims: number | null;
};

export function sanitizePgIdent(raw: string, fallback: string): string {
  const s = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_");
  return s || fallback;
}

export function parseVectorTypeDims(formatType: string | null | undefined): number | null {
  const s = String(formatType ?? "").trim().toLowerCase();
  if (!s) return null;
  const m = /^vector\((\d+)\)$/.exec(s);
  if (m) return Number(m[1]);
  if (s === "vector") return null;
  return null;
}

export function parseAnnInspectFromRows(opts: {
  indexRows: Array<{ indexname?: string; indexdef?: string }>;
  formatType?: string | null;
}): PgvectorAnnInspect {
  let hasHnsw = false;
  let hasSourceIndex = false;
  for (const row of opts.indexRows) {
    const def = String(row.indexdef ?? "").toLowerCase();
    const name = String(row.indexname ?? "").toLowerCase();
    if (def.includes("using hnsw") || name.includes("hnsw")) hasHnsw = true;
    if (
      (def.includes("metadata") && def.includes("source")) ||
      name.includes("metadata_source") ||
      name.endsWith("_source_idx")
    ) {
      hasSourceIndex = true;
    }
  }
  const embeddingType = opts.formatType != null ? String(opts.formatType) : null;
  return {
    hasHnsw,
    hasSourceIndex,
    embeddingType,
    dims: parseVectorTypeDims(embeddingType),
  };
}

export function buildHnswIndexName(tableName: string, vectorColumn: string): string {
  return sanitizePgIdent(`${tableName}_${vectorColumn}_hnsw_idx`, "rag_documents_embedding_hnsw_idx");
}

export function buildSourceIndexName(tableName: string, metadataColumn: string): string {
  return sanitizePgIdent(`${tableName}_${metadataColumn}_source_idx`, "rag_documents_metadata_source_idx");
}

/** 将无约束 vector 列定为 vector(N)；空表或维一致时由调用方执行。 */
export function sqlAlterEmbeddingDims(params: Pick<PgvectorAnnParams, "tableName" | "vectorColumn" | "dimensions">): string {
  const t = sanitizePgIdent(params.tableName, "rag_documents");
  const c = sanitizePgIdent(params.vectorColumn, "embedding");
  const d = Math.max(1, Math.floor(params.dimensions));
  return `ALTER TABLE "${t}" ALTER COLUMN "${c}" TYPE vector(${d}) USING "${c}"::vector(${d})`;
}

export function sqlCreateHnswIndex(params: PgvectorAnnParams): string {
  const t = sanitizePgIdent(params.tableName, "rag_documents");
  const c = sanitizePgIdent(params.vectorColumn, "embedding");
  const idx = buildHnswIndexName(t, c);
  const m = Math.max(2, Math.floor(params.m));
  const ef = Math.max(4, Math.floor(params.efConstruction));
  return (
    `CREATE INDEX IF NOT EXISTS "${idx}" ON "${t}" ` +
    `USING hnsw ("${c}" vector_cosine_ops) WITH (m = ${m}, ef_construction = ${ef})`
  );
}

export function sqlCreateSourceMetadataIndex(
  params: Pick<PgvectorAnnParams, "tableName" | "metadataColumn">
): string {
  const t = sanitizePgIdent(params.tableName, "rag_documents");
  const m = sanitizePgIdent(params.metadataColumn, "metadata");
  const idx = buildSourceIndexName(t, m);
  return `CREATE INDEX IF NOT EXISTS "${idx}" ON "${t}" (("${m}"->>'source'))`;
}

export function sqlSetHnswEfSearch(efSearch: number): string {
  const ef = Math.max(1, Math.floor(efSearch));
  return `SET hnsw.ef_search = ${ef}`;
}

export function sqlListTableIndexes(tableName: string): string {
  const t = sanitizePgIdent(tableName, "rag_documents");
  return (
    `SELECT indexname, indexdef FROM pg_indexes ` +
    `WHERE schemaname = 'public' AND tablename = '${t}'`
  );
}

export function sqlEmbeddingColumnFormatType(tableName: string, vectorColumn: string): string {
  const t = sanitizePgIdent(tableName, "rag_documents");
  const c = sanitizePgIdent(vectorColumn, "embedding");
  return (
    `SELECT format_type(a.atttypid, a.atttypmod) AS format_type ` +
    `FROM pg_attribute a ` +
    `JOIN pg_class r ON a.attrelid = r.oid ` +
    `JOIN pg_namespace n ON r.relnamespace = n.oid ` +
    `WHERE n.nspname = 'public' AND r.relname = '${t}' AND a.attname = '${c}' AND NOT a.attisdropped`
  );
}

/** 抽样一行向量维；空表返回 null。 */
export function sqlProbeEmbeddingDims(tableName: string, vectorColumn: string): string {
  const t = sanitizePgIdent(tableName, "rag_documents");
  const c = sanitizePgIdent(vectorColumn, "embedding");
  return `SELECT vector_dims("${c}")::int AS dims FROM "${t}" WHERE "${c}" IS NOT NULL LIMIT 1`;
}

export function decideAlterEmbeddingDims(opts: {
  targetDims: number;
  columnDims: number | null;
  probedRowDims: number | null;
  rowCount: number;
}): { alter: boolean; reason: string } {
  const target = Math.max(1, Math.floor(opts.targetDims));
  if (opts.columnDims === target) {
    return { alter: false, reason: "already_fixed_dims" };
  }
  if (opts.rowCount === 0) {
    return { alter: true, reason: "empty_table" };
  }
  if (opts.probedRowDims != null && opts.probedRowDims === target) {
    return { alter: true, reason: "rows_match_target_dims" };
  }
  if (opts.probedRowDims != null && opts.probedRowDims !== target) {
    return { alter: false, reason: "embedding_dim_mismatch" };
  }
  // 有行但探不到维（异常）→ 不强制 ALTER
  return { alter: false, reason: "probe_dims_unavailable" };
}

export function annSoftWarnings(inspect: PgvectorAnnInspect, targetDims: number): string[] {
  const out: string[] = [];
  if (!inspect.hasHnsw) out.push("missing_hnsw_index");
  if (!inspect.hasSourceIndex) out.push("missing_metadata_source_index");
  if (inspect.dims != null && inspect.dims !== targetDims) {
    out.push("embedding_dim_mismatch");
  }
  if (inspect.dims == null && inspect.embeddingType) {
    out.push("embedding_dims_unconstrained");
  }
  return out;
}
