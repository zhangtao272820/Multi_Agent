/**
 * Agent 记忆层 PostgreSQL schema（幂等 DDL）。
 */

export const AGENT_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mgr_sessions (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mgr_session_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(80) NOT NULL REFERENCES mgr_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_mgr_session_turns_session
  ON mgr_session_turns(session_id, turn_index);

CREATE TABLE IF NOT EXISTS mgr_memory_entries (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_type VARCHAR(32) NOT NULL DEFAULT 'experience',
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgr_memory_entries_type_ts
  ON mgr_memory_entries(entry_type, ts DESC);

CREATE TABLE IF NOT EXISTS db_learning_signals (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  question TEXT NOT NULL,
  question_norm VARCHAR(120) NOT NULL,
  path VARCHAR(32),
  ok BOOLEAN NOT NULL,
  empty BOOLEAN,
  data_domain VARCHAR(64),
  intent VARCHAR(64),
  tables JSONB,
  ms INTEGER,
  reason TEXT,
  feedback REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_db_learning_signals_ts ON db_learning_signals(ts DESC);
CREATE INDEX IF NOT EXISTS idx_db_learning_signals_norm ON db_learning_signals(question_norm);

CREATE TABLE IF NOT EXISTS db_route_stats (
  id BIGSERIAL PRIMARY KEY,
  context_key VARCHAR(128) NOT NULL,
  path VARCHAR(32) NOT NULL,
  trials INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  empty_count INTEGER NOT NULL DEFAULT 0,
  avg_ms REAL NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(context_key, path)
);

CREATE TABLE IF NOT EXISTS db_query_experience (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  question_norm VARCHAR(120) NOT NULL,
  path VARCHAR(32),
  data_domain VARCHAR(64),
  tables JSONB,
  hint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_db_query_experience_norm ON db_query_experience(question_norm);

CREATE TABLE IF NOT EXISTS rag_learning_signals (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  question TEXT NOT NULL,
  question_norm VARCHAR(120),
  score REAL NOT NULL,
  comment TEXT,
  path VARCHAR(64),
  source VARCHAR(256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_learning_signals_at ON rag_learning_signals(at DESC);

CREATE TABLE IF NOT EXISTS rag_route_preferences (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS rag_sessions (
  id VARCHAR(120) PRIMARY KEY,
  user_id VARCHAR(64),
  title VARCHAR(120),
  custom_title BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_sessions_user
  ON rag_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS rag_session_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(120) NOT NULL REFERENCES rag_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_rag_session_turns_session
  ON rag_session_turns(session_id, turn_index);

CREATE TABLE IF NOT EXISTS rag_session_memory (
  session_id VARCHAR(120) PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evo_policy_versions (
  id BIGSERIAL PRIMARY KEY,
  agent VARCHAR(32) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  version INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('shadow', 'active', 'rolled_back')),
  payload JSONB NOT NULL,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent, stage, version)
);

CREATE INDEX IF NOT EXISTS idx_evo_policy_active
  ON evo_policy_versions(agent, stage, status);

CREATE TABLE IF NOT EXISTS mgr_session_summaries (
  session_id VARCHAR(80) PRIMARY KEY REFERENCES mgr_sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  source VARCHAR(16) NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'llm')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mgr_memory_embeddings (
  id BIGSERIAL PRIMARY KEY,
  memory_key VARCHAR(64) NOT NULL,
  user_key VARCHAR(64) NOT NULL DEFAULT '__global__',
  entry_type VARCHAR(32) NOT NULL DEFAULT 'experience',
  embedding JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(memory_key)
);

CREATE INDEX IF NOT EXISTS idx_mgr_memory_embeddings_user
  ON mgr_memory_embeddings(user_key, entry_type, ts DESC);

CREATE TABLE IF NOT EXISTS db_user_preferences (
  user_key VARCHAR(64) PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mgr_user_profiles (
  user_key VARCHAR(64) PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgr_user_profiles_updated
  ON mgr_user_profiles(updated_at DESC);

CREATE TABLE IF NOT EXISTS evo_audit_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name VARCHAR(64) NOT NULL,
  agent VARCHAR(32),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  report JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_evo_audit_runs_job
  ON evo_audit_runs(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS evo_curator_state (
  job_key VARCHAR(64) PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_report JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE mgr_memory_embeddings ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);

CREATE INDEX IF NOT EXISTS idx_mgr_memory_embeddings_vec
  ON mgr_memory_embeddings USING hnsw (embedding_vec vector_cosine_ops);

CREATE TABLE IF NOT EXISTS db_experience_vectors (
  id BIGSERIAL PRIMARY KEY,
  experience_key VARCHAR(64) NOT NULL UNIQUE,
  question_norm VARCHAR(120) NOT NULL,
  hint TEXT NOT NULL,
  path VARCHAR(32),
  data_domain VARCHAR(64),
  embedding_vec vector(1536) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_db_experience_vectors_norm ON db_experience_vectors(question_norm);
CREATE INDEX IF NOT EXISTS idx_db_experience_vectors_vec
  ON db_experience_vectors USING hnsw (embedding_vec vector_cosine_ops);

CREATE TABLE IF NOT EXISTS adm_session_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(120) NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adm_session_turns_session ON adm_session_turns(session_id, id);

CREATE TABLE IF NOT EXISTS adm_session_task_contexts (
  session_id VARCHAR(120) PRIMARY KEY,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mgr_session_turns_archive (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(80) NOT NULL,
  turn_index INTEGER NOT NULL,
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgr_session_turns_archive_session
  ON mgr_session_turns_archive(session_id, turn_index);

CREATE OR REPLACE VIEW shared_user_context_view AS
SELECT
  COALESCE(d.user_key, m.user_key) AS user_key,
  d.payload AS db_preferences,
  d.updated_at AS db_updated_at,
  m.payload AS mgr_profile,
  m.updated_at AS mgr_updated_at
FROM db_user_preferences d
FULL OUTER JOIN mgr_user_profiles m ON d.user_key = m.user_key;

CREATE INDEX IF NOT EXISTS idx_mgr_sessions_user_id ON mgr_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_mgr_memory_entries_scenario
  ON mgr_memory_entries ((payload->>'scenarioKey'))
  WHERE entry_type = 'experience';

CREATE INDEX IF NOT EXISTS idx_mgr_memory_embeddings_session
  ON mgr_memory_embeddings ((metadata->>'sessionId'))
  WHERE metadata->>'sessionId' IS NOT NULL;

CREATE TABLE IF NOT EXISTS mgr_tool_memory (
  id BIGSERIAL PRIMARY KEY,
  agent VARCHAR(32) NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  context_key VARCHAR(128) NOT NULL DEFAULT '__global__',
  trials INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  avg_ms REAL NOT NULL DEFAULT 0,
  last_ok BOOLEAN,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent, tool_name, context_key)
);

CREATE INDEX IF NOT EXISTS idx_mgr_tool_memory_agent
  ON mgr_tool_memory(agent, updated_at DESC);

CREATE TABLE IF NOT EXISTS mgr_skill_drafts (
  skill_id VARCHAR(128) PRIMARY KEY,
  agent VARCHAR(32) NOT NULL,
  markdown TEXT NOT NULL,
  source_run_id VARCHAR(80),
  success_score REAL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'promoted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgr_skill_drafts_status
  ON mgr_skill_drafts(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mgr_session_fold_state (
  session_id VARCHAR(80) PRIMARY KEY,
  folded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fold_summary TEXT NOT NULL DEFAULT '',
  turn_count INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(16) NOT NULL DEFAULT 'archive' CHECK (source IN ('archive', 'summary', 'llm'))
);

CREATE INDEX IF NOT EXISTS idx_mgr_memory_entries_session_working
  ON mgr_memory_entries ((payload->>'sessionId'))
  WHERE entry_type = 'working';

CREATE INDEX IF NOT EXISTS idx_mgr_memory_entries_reflection_scenario
  ON mgr_memory_entries ((payload->>'scenarioKey'))
  WHERE entry_type = 'reflection';

CREATE TABLE IF NOT EXISTS mgr_task_stacks (
  session_id VARCHAR(80) PRIMARY KEY REFERENCES mgr_sessions(id) ON DELETE CASCADE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgr_task_stacks_updated
  ON mgr_task_stacks(updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_session_feedback (
  id BIGSERIAL PRIMARY KEY,
  agent VARCHAR(16) NOT NULL CHECK (agent IN ('manager', 'db', 'rag', 'admin')),
  session_id VARCHAR(120) NOT NULL,
  feedback_key VARCHAR(120) NOT NULL,
  turn_id INTEGER,
  user_message_index INTEGER,
  run_id VARCHAR(80),
  score SMALLINT NOT NULL,
  question TEXT,
  comment TEXT,
  artifact JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent, session_id, feedback_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_session_feedback_session
  ON agent_session_feedback (agent, session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_session_feedback_turn
  ON agent_session_feedback (agent, session_id, turn_id)
  WHERE turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_session_feedback_user_idx
  ON agent_session_feedback (agent, session_id, user_message_index)
  WHERE user_message_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_session_feedback_run
  ON agent_session_feedback (agent, run_id)
  WHERE run_id IS NOT NULL;
`
