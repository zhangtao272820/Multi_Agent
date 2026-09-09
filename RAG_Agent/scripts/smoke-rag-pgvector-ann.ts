/**
 * pgvector ANN 契约：SQL 模板 / 定维决策 / health softWarnings。
 * 对照八股 §5 与 doc/向量数据库与ANN.md；不连真库、不调 embedding。
 */
import assert from "node:assert/strict";
import {
  annSoftWarnings,
  decideAlterEmbeddingDims,
  parseAnnInspectFromRows,
  parseVectorTypeDims,
  sqlAlterEmbeddingDims,
  sqlCreateHnswIndex,
  sqlCreateSourceMetadataIndex,
  sqlSetHnswEfSearch,
} from "../server/utils/pgvector_ann";

function main() {
  const ann = {
    tableName: "rag_documents",
    vectorColumn: "embedding",
    metadataColumn: "metadata",
    dimensions: 1024,
    m: 16,
    efConstruction: 64,
    efSearch: 40,
  };

  const hnsw = sqlCreateHnswIndex(ann);
  assert.match(hnsw, /USING hnsw/i);
  assert.match(hnsw, /vector_cosine_ops/);
  assert.match(hnsw, /m = 16/);
  assert.match(hnsw, /ef_construction = 64/);
  assert.match(hnsw, /CREATE INDEX IF NOT EXISTS/);

  const src = sqlCreateSourceMetadataIndex(ann);
  assert.match(src, /"metadata"->>'source'/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS/);

  const alter = sqlAlterEmbeddingDims(ann);
  assert.match(alter, /vector\(1024\)/);
  assert.match(alter, /ALTER COLUMN "embedding"/);

  const ef = sqlSetHnswEfSearch(40);
  assert.equal(ef, "SET hnsw.ef_search = 40");

  assert.equal(parseVectorTypeDims("vector(1024)"), 1024);
  assert.equal(parseVectorTypeDims("vector"), null);

  // 空表 → 可定维
  assert.equal(
    decideAlterEmbeddingDims({
      targetDims: 1024,
      columnDims: null,
      probedRowDims: null,
      rowCount: 0,
    }).alter,
    true
  );
  // 已定维 → 不重复 ALTER
  assert.equal(
    decideAlterEmbeddingDims({
      targetDims: 1024,
      columnDims: 1024,
      probedRowDims: 1024,
      rowCount: 10,
    }).alter,
    false
  );
  // 行维不匹配 → 禁 ALTER（不删数据）
  const mismatch = decideAlterEmbeddingDims({
    targetDims: 1024,
    columnDims: null,
    probedRowDims: 1536,
    rowCount: 10,
  });
  assert.equal(mismatch.alter, false);
  assert.equal(mismatch.reason, "embedding_dim_mismatch");

  const missing = parseAnnInspectFromRows({
    indexRows: [{ indexname: "rag_documents_content_trgm_idx", indexdef: "CREATE INDEX ... gin_trgm_ops" }],
    formatType: "vector",
  });
  assert.equal(missing.hasHnsw, false);
  assert.equal(missing.hasSourceIndex, false);
  const soft = annSoftWarnings(missing, 1024);
  assert.ok(soft.includes("missing_hnsw_index"));
  assert.ok(soft.includes("embedding_dims_unconstrained"));

  const ready = parseAnnInspectFromRows({
    indexRows: [
      {
        indexname: "rag_documents_embedding_hnsw_idx",
        indexdef: 'CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)',
      },
      {
        indexname: "rag_documents_metadata_source_idx",
        indexdef: "CREATE INDEX ... ((metadata->>'source'))",
      },
    ],
    formatType: "vector(1024)",
  });
  assert.equal(ready.hasHnsw, true);
  assert.equal(ready.hasSourceIndex, true);
  assert.equal(ready.dims, 1024);
  assert.deepEqual(annSoftWarnings(ready, 1024), []);

  // 八股常见问：ef_search 调大 → 召回↑延迟↑（契约侧只保证 SQL 可配置）
  assert.match(sqlSetHnswEfSearch(80), /ef_search = 80/);

  console.log("smoke-rag-pgvector-ann OK: hnsw/source/dims/ef_search + softWarnings");
}

main();
