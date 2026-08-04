CREATE TABLE IF NOT EXISTS db_sessions (
  id VARCHAR(120) PRIMARY KEY,
  user_id VARCHAR(64),
  title VARCHAR(120),
  custom_title BOOLEAN NOT NULL DEFAULT false,
  tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_db_sessions_user ON db_sessions(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS db_session_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(120) NOT NULL REFERENCES db_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_db_session_turns_session ON db_session_turns(session_id, turn_index);
CREATE TABLE IF NOT EXISTS adm_sessions (
  id VARCHAR(120) PRIMARY KEY,
  user_id VARCHAR(64),
  title VARCHAR(120),
  custom_title BOOLEAN NOT NULL DEFAULT false,
  tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adm_sessions_user ON adm_sessions(user_id, updated_at DESC);
