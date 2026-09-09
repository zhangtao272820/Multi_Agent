/**
 * 执行 Agent 记忆 schema 迁移（001–008，幂等）
 * 用法：cd Manager_Agent && npx tsx ../scripts/run-agent-memory-migrations.ts
 * 无 pg 模块时自动 fallback 到 docker exec psql
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getAgentPgPool, isAgentPgConfigured, pingAgentPg } from '../shared/agentPgClient'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(__dirname, 'migrations')

const MIGRATION_FILES = [
  '001_agent_memory_schema.sql',
  '002_agent_memory_phase2_phase3.sql',
  '003_agent_memory_phase4_phase5.sql',
  '004_agent_memory_phase6.sql',
  '005_agent_memory_phase7.sql',
  '006_agent_memory_phase8.sql',
  '007_agent_memory_phase11.sql',
  '008_agent_session_feedback.sql',
  '009_agent_memory_phase12_p0.sql',
  '010_agent_memory_phase13_p1.sql',
  '011_agent_memory_phase13_14.sql',
  '012_agent_memory_phase15_p2.sql',
  '013_embedding_dim_v1_1536.sql',
  '014_agent_memory_phase16_p3.sql',
  '015_mgr_user_profiles.sql',
  '016_agent_memory_multitenant.sql',
  '019_mgr_agent_morphology.sql',
  '020_agent_memory_tenant_harden.sql',
  '021_mgr_memory_embeddings_tenant_unique.sql'
]

function applyViaDocker(fileName: string, sql: string): boolean {
  const container = String(process.env.CLAWHIVE_PG_CONTAINER || 'clawhive_postgres').trim()
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'clawhive', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout)
    return false
  }
  if (r.stdout?.trim()) process.stdout.write(r.stdout)
  return true
}

async function main() {
  if (!isAgentPgConfigured()) {
    console.error('AGENT_DATABASE_URL not set')
    process.exit(1)
  }

  const pool = await getAgentPgPool()
  const useDocker = !pool || !(await pingAgentPg())
  if (useDocker) {
    console.log('run-agent-memory-migrations: using docker psql fallback')
  } else {
    console.log('run-agent-memory-migrations: connected via pg pool')
  }

  for (const file of MIGRATION_FILES) {
    const fp = path.join(migrationsDir, file)
    const sql = await fs.readFile(fp, 'utf8')
    console.log(`Applying ${file}...`)
    if (useDocker) {
      if (!applyViaDocker(file, sql)) process.exit(1)
    } else {
      await pool!.query(sql)
    }
    console.log('  OK')
  }

  if (pool && !useDocker) await pool.end()
  console.log('All migrations applied.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
