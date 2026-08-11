-- 联邦经验平面隔离：独立端召回可排除 manager_orchestrated
ALTER TABLE db_query_experience ADD COLUMN IF NOT EXISTS source VARCHAR(80);
ALTER TABLE db_query_experience ADD COLUMN IF NOT EXISTS source_plane VARCHAR(32) NOT NULL DEFAULT 'standalone';
CREATE INDEX IF NOT EXISTS idx_db_query_experience_plane
  ON db_query_experience(tenant_id, source_plane);

ALTER TABLE rag_learning_signals ADD COLUMN IF NOT EXISTS source_plane VARCHAR(32) NOT NULL DEFAULT 'standalone';
CREATE INDEX IF NOT EXISTS idx_rag_learning_signals_plane
  ON rag_learning_signals(tenant_id, source_plane);

ALTER TABLE adm_tool_experience ADD COLUMN IF NOT EXISTS source_plane VARCHAR(32) NOT NULL DEFAULT 'standalone';
ALTER TABLE adm_tool_experience ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_adm_tool_experience_tenant_plane
  ON adm_tool_experience(tenant_id, source_plane);
