-- Phase 17：记忆 / 学习 / 进化多租户隔离（共享库 + tenant_id 列）

-- ── Manager 记忆 ──
ALTER TABLE mgr_memory_entries ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE mgr_memory_entries ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_mgr_memory_entries_tenant_type_ts
  ON mgr_memory_entries(tenant_id, entry_type, ts DESC);

ALTER TABLE mgr_memory_embeddings ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_mgr_memory_embeddings_tenant_user
  ON mgr_memory_embeddings(tenant_id, user_key, entry_type, ts DESC);

ALTER TABLE mgr_user_profiles ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_mgr_user_profiles_tenant
  ON mgr_user_profiles(tenant_id, updated_at DESC);

ALTER TABLE db_user_preferences ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_db_user_preferences_tenant
  ON db_user_preferences(tenant_id, updated_at DESC);

-- ── RAG session / memory ──
ALTER TABLE rag_sessions ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_rag_sessions_tenant_user
  ON rag_sessions(tenant_id, user_id, updated_at DESC);

ALTER TABLE rag_session_memory ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_rag_session_memory_tenant
  ON rag_session_memory(tenant_id, updated_at DESC);

-- ── DB / RAG learning ──
ALTER TABLE db_learning_signals ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_db_learning_signals_tenant_ts
  ON db_learning_signals(tenant_id, ts DESC);

ALTER TABLE db_query_experience ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_db_query_experience_tenant_norm
  ON db_query_experience(tenant_id, question_norm);

ALTER TABLE db_route_stats ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
-- 旧 UNIQUE(context_key, path) → 租户维度
ALTER TABLE db_route_stats DROP CONSTRAINT IF EXISTS db_route_stats_context_key_path_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'db_route_stats_tenant_context_path_key'
  ) THEN
    ALTER TABLE db_route_stats
      ADD CONSTRAINT db_route_stats_tenant_context_path_key UNIQUE (tenant_id, context_key, path);
  END IF;
END $$;

ALTER TABLE rag_learning_signals ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_rag_learning_signals_tenant_at
  ON rag_learning_signals(tenant_id, at DESC);

-- rag_route_preferences：从单行全局改为 per-tenant
ALTER TABLE rag_route_preferences DROP CONSTRAINT IF EXISTS rag_route_preferences_id_check;
ALTER TABLE rag_route_preferences ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
DO $$
BEGIN
  -- 若仍是 id SMALLINT PK，改为以 tenant_id 为主键语义
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rag_route_preferences' AND column_name = 'id'
  ) THEN
    -- 保留 id 列但放宽；用 tenant_id UNIQUE
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'rag_route_preferences_tenant_id_key'
    ) THEN
      ALTER TABLE rag_route_preferences ADD CONSTRAINT rag_route_preferences_tenant_id_key UNIQUE (tenant_id);
    END IF;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_rag_route_preferences_tenant
  ON rag_route_preferences(tenant_id);

ALTER TABLE db_experience_vectors ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_db_experience_vectors_tenant
  ON db_experience_vectors(tenant_id, question_norm);

ALTER TABLE mgr_tool_memory ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE mgr_tool_memory DROP CONSTRAINT IF EXISTS mgr_tool_memory_agent_tool_name_context_key_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mgr_tool_memory_tenant_agent_tool_ctx_key'
  ) THEN
    ALTER TABLE mgr_tool_memory
      ADD CONSTRAINT mgr_tool_memory_tenant_agent_tool_ctx_key
      UNIQUE (tenant_id, agent, tool_name, context_key);
  END IF;
END $$;

-- ── 进化策略版本（双轨：租户 + _global_ / global_candidate）──
ALTER TABLE evo_policy_versions ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE evo_policy_versions DROP CONSTRAINT IF EXISTS evo_policy_versions_agent_stage_version_key;
ALTER TABLE evo_policy_versions DROP CONSTRAINT IF EXISTS evo_policy_versions_status_check;
ALTER TABLE evo_policy_versions
  ADD CONSTRAINT evo_policy_versions_status_check
  CHECK (status IN ('shadow', 'active', 'rolled_back', 'global_candidate', 'discarded'));
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evo_policy_versions_tenant_agent_stage_version_key'
  ) THEN
    ALTER TABLE evo_policy_versions
      ADD CONSTRAINT evo_policy_versions_tenant_agent_stage_version_key
      UNIQUE (tenant_id, agent, stage, version);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_evo_policy_tenant_active
  ON evo_policy_versions(tenant_id, agent, stage, status);

ALTER TABLE evo_curator_state ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_evo_curator_state_tenant
  ON evo_curator_state(tenant_id);

ALTER TABLE evo_audit_runs ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_evo_audit_runs_tenant
  ON evo_audit_runs(tenant_id, started_at DESC);

-- ── 全局合入审核队列 ──
CREATE TABLE IF NOT EXISTS evo_global_candidates (
  id BIGSERIAL PRIMARY KEY,
  source_tenant_id VARCHAR(64) NOT NULL,
  agent VARCHAR(32) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  policy_version_id BIGINT,
  sanitized_payload JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer VARCHAR(128),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_evo_global_candidates_status
  ON evo_global_candidates(status, created_at DESC);
