-- 集群运行时 Agent 形态快照（planned / final），与 jsonl 双写
CREATE TABLE IF NOT EXISTS mgr_agent_morphology (
  id BIGSERIAL PRIMARY KEY,
  run_id VARCHAR(80) NOT NULL,
  session_id VARCHAR(120),
  tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  kind VARCHAR(16) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_mgr_agent_morphology_ts ON mgr_agent_morphology (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mgr_agent_morphology_run ON mgr_agent_morphology (run_id);
