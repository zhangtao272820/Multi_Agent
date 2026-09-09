-- 022：RAG 文档向量库 ANN（目标库 rag_vector / 服务 rag_pgvector，勿打到 clawhive）
-- RAG_PG_CONNECTION_STRING=postgresql://postgres:postgres@localhost:15433/rag_vector
-- text-embedding-v3 默认维 1024；若现网维不同，先 SELECT vector_dims(embedding) FROM rag_documents LIMIT 1;
-- 非 default 租户表 rag_documents_<seg> 由 RAG 进程首次打开时 ensure。
--
-- 推荐顺序：先定维，再建 HNSW。未定维时直接建 HNSW 可能失败。
-- 生产也可依赖应用启动 ensure（RAG_PG_ENSURE_HNSW=1），本文件作运维 SSOT。

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1) 定维（确认行维均为 1024 后再执行；冲突勿强行跑）
ALTER TABLE rag_documents
  ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector(1024);

-- 2) ANN + 过滤 + keyword
CREATE INDEX IF NOT EXISTS rag_documents_embedding_hnsw_idx
  ON rag_documents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS rag_documents_metadata_source_idx
  ON rag_documents ((metadata->>'source'));

CREATE INDEX IF NOT EXISTS rag_documents_content_trgm_idx
  ON rag_documents USING GIN (content gin_trgm_ops);

