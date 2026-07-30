-- 跨会话用户画像 / 偏好（左辅 Memory 产品化：user_key 权威，非纯 session 文件）
CREATE TABLE IF NOT EXISTS mgr_user_profiles (
  user_key VARCHAR(64) PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgr_user_profiles_updated
  ON mgr_user_profiles(updated_at DESC);

CREATE OR REPLACE VIEW shared_user_context_view AS
SELECT
  COALESCE(d.user_key, m.user_key) AS user_key,
  d.payload AS db_preferences,
  d.updated_at AS db_updated_at,
  m.payload AS mgr_profile,
  m.updated_at AS mgr_updated_at
FROM db_user_preferences d
FULL OUTER JOIN mgr_user_profiles m ON d.user_key = m.user_key;
