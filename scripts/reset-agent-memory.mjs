#!/usr/bin/env node
/**
 * 清空 Agent 记忆/经验/进化数据（保留 RAG 文档向量库 rag_pgvector 中的检索文档）
 * 用法：node scripts/reset-agent-memory.mjs [--yes]
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
if (!args.has('--yes')) {
  console.error('将清空 clawhive PG 记忆表、Redis checkpoint、Agent .data 卷中的 jsonl/会话文件。')
  console.error('RAG 文档向量库（rag_pgvector）不受影响。')
  console.error('确认请加 --yes')
  process.exit(1)
}

const pgUrl =
  process.env.AGENT_DATABASE_URL || 'postgresql://postgres:postgres@localhost:15432/clawhive'
const redisUrl = process.env.AGENT_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:16379/0'

const TRUNCATE_SQL = `
DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'mgr_session_turns',
    'mgr_session_summaries',
    'mgr_session_turns_archive',
    'mgr_memory_embeddings',
    'mgr_memory_entries',
    'db_learning_signals',
    'db_route_stats',
    'db_query_experience',
    'db_experience_vectors',
    'db_user_preferences',
    'rag_learning_signals',
    'rag_route_preferences',
    'rag_session_memory',
    'evo_policy_versions',
    'evo_audit_runs',
    'evo_curator_state',
    'adm_session_turns',
    'adm_session_task_contexts',
    'mgr_sessions',
    'agent_session_feedback'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', t);
      RAISE NOTICE 'truncated %', t;
    END IF;
  END LOOP;
END $$;
`

function runPsql(sql) {
  const isDocker = pgUrl.includes('clawhive_postgres') || pgUrl.includes('@localhost:15432')
  if (isDocker) {
    execSync(`docker exec -i clawhive_postgres psql -U postgres -d clawhive -v ON_ERROR_STOP=1`, {
      input: sql,
      stdio: ['pipe', 'inherit', 'inherit']
    })
  } else {
    execSync(`psql "${pgUrl}" -v ON_ERROR_STOP=1`, { input: sql, stdio: ['pipe', 'inherit', 'inherit'] })
  }
}

function clearVolumeData(container, subdir = '/app/.data') {
  try {
    execSync(`docker exec ${container} sh -c "rm -rf ${subdir}/* ${subdir}/.[!.]* 2>/dev/null; mkdir -p ${subdir}"`, {
      stdio: 'inherit'
    })
    console.log(`cleared ${container}:${subdir}`)
  } catch (e) {
    console.warn(`skip ${container}: ${e?.message || e}`)
  }
}

function flushRedis() {
  try {
    execSync('docker exec clawhive_redis redis-cli FLUSHDB', { stdio: 'inherit' })
    console.log('redis FLUSHDB ok')
  } catch {
    console.warn('skip redis flush (container not running?)')
  }
}

console.log('reset: truncating clawhive memory tables...')
runPsql(TRUNCATE_SQL)

flushRedis()

for (const c of ['manager_agent', 'db_agent', 'rag_agent', 'ai_admin_agent', 'vanna_db_agent']) {
  clearVolumeData(c)
}

// 本机 .data（若存在）
for (const rel of ['Manager_Agent/.data', 'DB_Agent/.data', 'RAG_Agent/.data']) {
  const dir = path.join(process.cwd(), rel)
  if (!fs.existsSync(dir)) continue
  for (const ent of fs.readdirSync(dir)) {
    if (ent === '.gitkeep') continue
    fs.rmSync(path.join(dir, ent), { recursive: true, force: true })
  }
  console.log(`cleared local ${rel}`)
}

console.log('reset-agent-memory: done')
