-- 021: mgr_memory_embeddings UNIQUE 含 tenant_id（禁止跨租户同 key 覆盖）
-- 对齐 020 精神；存量空 tenant 回填 default

ALTER TABLE IF EXISTS mgr_memory_embeddings
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

UPDATE mgr_memory_embeddings
SET tenant_id = 'default'
WHERE tenant_id IS NULL OR btrim(tenant_id) = '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mgr_memory_embeddings_memory_key_key'
  ) THEN
    ALTER TABLE mgr_memory_embeddings DROP CONSTRAINT mgr_memory_embeddings_memory_key_key;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'mgr_memory_embeddings'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mgr_memory_embeddings_tenant_memory_key'
  ) THEN
    ALTER TABLE mgr_memory_embeddings
      ADD CONSTRAINT mgr_memory_embeddings_tenant_memory_key UNIQUE (tenant_id, memory_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS mgr_memory_embeddings_tenant_ts_idx
  ON mgr_memory_embeddings (tenant_id, ts DESC);
