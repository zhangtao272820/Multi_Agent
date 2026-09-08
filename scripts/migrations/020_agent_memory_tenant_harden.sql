-- Phase 20：上线收紧 — Process/Tool/Profile/Fold/Artifacts 租户硬隔离
-- AGENT_DATABASE_URL=postgresql://postgres:postgres@localhost:15432/clawhive

-- ── Process / SOP 记忆 ──
ALTER TABLE mgr_process_memory ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE mgr_process_memory DROP CONSTRAINT IF EXISTS mgr_process_memory_scenario_key_question_norm_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mgr_process_memory_tenant_scenario_norm_key'
  ) THEN
    ALTER TABLE mgr_process_memory
      ADD CONSTRAINT mgr_process_memory_tenant_scenario_norm_key
      UNIQUE (tenant_id, scenario_key, question_norm);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_mgr_process_memory_tenant_scenario
  ON mgr_process_memory(tenant_id, scenario_key, hits DESC);

-- ── Tool memory：确保 UNIQUE 含 tenant（016 已改；幂等再确认）──
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
CREATE INDEX IF NOT EXISTS idx_mgr_tool_memory_tenant_agent
  ON mgr_tool_memory(tenant_id, agent, updated_at DESC);

-- ── 用户画像 / 偏好：复合唯一 (tenant_id, user_key) ──
ALTER TABLE mgr_user_profiles ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE mgr_user_profiles DROP CONSTRAINT IF EXISTS mgr_user_profiles_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mgr_user_profiles_tenant_user_key'
  ) THEN
    ALTER TABLE mgr_user_profiles
      ADD CONSTRAINT mgr_user_profiles_tenant_user_key UNIQUE (tenant_id, user_key);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_mgr_user_profiles_tenant_updated
  ON mgr_user_profiles(tenant_id, updated_at DESC);

ALTER TABLE db_user_preferences ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE db_user_preferences DROP CONSTRAINT IF EXISTS db_user_preferences_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'db_user_preferences_tenant_user_key'
  ) THEN
    ALTER TABLE db_user_preferences
      ADD CONSTRAINT db_user_preferences_tenant_user_key UNIQUE (tenant_id, user_key);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_db_user_preferences_tenant_updated
  ON db_user_preferences(tenant_id, updated_at DESC);

DROP VIEW IF EXISTS shared_user_context_view CASCADE;
CREATE VIEW shared_user_context_view AS
SELECT
  COALESCE(d.tenant_id, m.tenant_id, 'default') AS tenant_id,
  COALESCE(d.user_key, m.user_key) AS user_key,
  d.payload AS db_preferences,
  d.updated_at AS db_updated_at,
  m.payload AS mgr_profile,
  m.updated_at AS mgr_updated_at
FROM db_user_preferences d
FULL OUTER JOIN mgr_user_profiles m
  ON d.user_key = m.user_key AND d.tenant_id = m.tenant_id;

-- ── Fold / Artifacts：带租户列，便于按租户扫与审计 ──
ALTER TABLE mgr_session_fold_state ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_mgr_session_fold_state_tenant
  ON mgr_session_fold_state(tenant_id, folded_at DESC);

ALTER TABLE mgr_run_artifacts ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_mgr_run_artifacts_tenant
  ON mgr_run_artifacts(tenant_id, updated_at DESC);

-- 回填 fold / artifacts tenant（从 mgr_sessions）
UPDATE mgr_session_fold_state f
SET tenant_id = COALESCE(NULLIF(s.tenant_id, ''), 'default')
FROM mgr_sessions s
WHERE f.session_id = s.id
  AND (f.tenant_id IS NULL OR f.tenant_id = 'default')
  AND COALESCE(NULLIF(s.tenant_id, ''), 'default') <> 'default';

UPDATE mgr_run_artifacts a
SET tenant_id = COALESCE(NULLIF(s.tenant_id, ''), 'default')
FROM mgr_sessions s
WHERE a.session_id = s.id
  AND (a.tenant_id IS NULL OR a.tenant_id = 'default')
  AND COALESCE(NULLIF(s.tenant_id, ''), 'default') <> 'default';
