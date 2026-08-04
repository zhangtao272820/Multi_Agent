-- Manager session turns: persist run_id + ui_meta (thinking/process snapshot) for hydrate
ALTER TABLE mgr_session_turns
  ADD COLUMN IF NOT EXISTS run_id VARCHAR(80);

ALTER TABLE mgr_session_turns
  ADD COLUMN IF NOT EXISTS ui_meta JSONB;

ALTER TABLE mgr_session_turns_archive
  ADD COLUMN IF NOT EXISTS run_id VARCHAR(80);

ALTER TABLE mgr_session_turns_archive
  ADD COLUMN IF NOT EXISTS ui_meta JSONB;

CREATE INDEX IF NOT EXISTS idx_mgr_session_turns_run_id
  ON mgr_session_turns(run_id)
  WHERE run_id IS NOT NULL;
