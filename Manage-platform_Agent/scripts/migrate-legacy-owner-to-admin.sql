-- =============================================================================
-- One-shot: assign pre-login unowned sessions/memory to admin
-- (MANAGER_LEGACY_OWNER_USER=admin). Idempotent for already-bound users.
-- PowerShell (from Manage-platform_Agent):
--   Get-Content .\scripts\migrate-legacy-owner-to-admin.sql -Raw |
--     docker exec -i clawhive_postgres psql -U postgres -d clawhive
-- =============================================================================

BEGIN;

SELECT 'mgr_sessions_null_or_self' AS metric, COUNT(*) AS n
FROM mgr_sessions
WHERE user_id IS NULL OR BTRIM(user_id) = '' OR user_id = id;

SELECT 'mgr_memory_embeddings_global' AS metric, COUNT(*) AS n
FROM mgr_memory_embeddings
WHERE user_key IS NULL OR BTRIM(user_key) = '' OR user_key = '__global__';

SELECT 'mgr_user_profiles_global' AS metric, COUNT(*) AS n
FROM mgr_user_profiles
WHERE user_key IS NULL OR BTRIM(user_key) = '' OR user_key = '__global__';

SELECT 'db_user_preferences_global' AS metric, COUNT(*) AS n
FROM db_user_preferences
WHERE user_key IS NULL OR BTRIM(user_key) = '' OR user_key = '__global__';

UPDATE mgr_sessions
SET user_id = 'admin',
    updated_at = NOW()
WHERE user_id IS NULL
   OR BTRIM(user_id) = ''
   OR user_id = id;

UPDATE mgr_memory_embeddings
SET user_key = 'admin'
WHERE user_key IS NULL
   OR BTRIM(user_key) = ''
   OR user_key = '__global__';

DELETE FROM mgr_user_profiles p
WHERE (p.user_key IS NULL OR BTRIM(p.user_key) = '' OR p.user_key = '__global__')
  AND EXISTS (SELECT 1 FROM mgr_user_profiles a WHERE a.user_key = 'admin');

UPDATE mgr_user_profiles
SET user_key = 'admin',
    updated_at = NOW()
WHERE user_key IS NULL
   OR BTRIM(user_key) = ''
   OR user_key = '__global__';

DELETE FROM db_user_preferences p
WHERE (p.user_key IS NULL OR BTRIM(p.user_key) = '' OR p.user_key = '__global__')
  AND EXISTS (SELECT 1 FROM db_user_preferences a WHERE a.user_key = 'admin');

UPDATE db_user_preferences
SET user_key = 'admin',
    updated_at = NOW()
WHERE user_key IS NULL
   OR BTRIM(user_key) = ''
   OR user_key = '__global__';

UPDATE mgr_memory_embeddings m
SET user_key = s.user_id
FROM mgr_sessions s
WHERE m.user_key = s.id
  AND s.user_id IS NOT NULL
  AND BTRIM(s.user_id) <> ''
  AND m.user_key <> s.user_id;

DELETE FROM mgr_user_profiles p
USING mgr_sessions s
WHERE p.user_key = s.id
  AND s.user_id IS NOT NULL
  AND BTRIM(s.user_id) <> ''
  AND EXISTS (SELECT 1 FROM mgr_user_profiles a WHERE a.user_key = s.user_id);

UPDATE mgr_user_profiles p
SET user_key = s.user_id,
    updated_at = NOW()
FROM mgr_sessions s
WHERE p.user_key = s.id
  AND s.user_id IS NOT NULL
  AND BTRIM(s.user_id) <> ''
  AND p.user_key <> s.user_id;

SELECT 'mgr_sessions_admin' AS metric, COUNT(*) AS n
FROM mgr_sessions
WHERE user_id = 'admin';

SELECT 'mgr_memory_embeddings_admin' AS metric, COUNT(*) AS n
FROM mgr_memory_embeddings
WHERE user_key = 'admin';

COMMIT;
