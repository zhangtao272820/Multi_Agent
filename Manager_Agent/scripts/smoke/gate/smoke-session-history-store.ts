/**
 * 会话历史读路径 smoke：
 * 1) 源码契约：热表空时回读 archive；PG 写失败强制落盘
 * 2) PG 空/不可达时回退 .data/sessions 文件
 * 3) postgres backend 下 PG 写失败 → 强制落盘文件
 *
 * 用法：cd Manager_Agent && npx --yes tsx --tsconfig tsconfig.smoke.json scripts/smoke/gate/smoke-session-history-store.ts
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isAgentPgConfigured,
  resetAgentPgPoolForTests
} from '#agent-shared/agentPgClient'
import {
  readManagerSession,
  writeManagerSession
} from '../../../server/utils/session/managerSessionStore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-session-history-store] ${msg}`)
}

async function main() {
  console.log('smoke-session-history-store: start')
  const prevBackend = process.env.MANAGER_STORAGE_BACKEND
  process.env.MANAGER_STORAGE_BACKEND = 'postgres'
  const sessionsDir = path.join(process.cwd(), '.data', 'sessions')
  await fsp.mkdir(sessionsDir, { recursive: true })

  // --- source contracts ---
  const storeSrc = fs.readFileSync(
    path.join(repoRoot, 'server/utils/session/managerSessionStore.ts'),
    'utf8'
  )
  assert(storeSrc.includes('mgr_session_turns_archive'), 'read must fall back to archive table')
  assert(storeSrc.includes('needFile'), 'write must compute needFile for PG-fail force file')
  assert(storeSrc.includes('ui_meta'), 'store must persist ui_meta')
  assert(storeSrc.includes('run_id'), 'store must persist run_id')
  assert(
    /shouldWritePostgres\(backend\)\s*&&\s*!pgOk/.test(storeSrc),
    'PG write failure must force file write'
  )
  assert(
    !/if \(backend === 'postgres' && pg\) return pg/.test(storeSrc),
    'empty PG must not short-circuit file fallback'
  )
  assert(storeSrc.includes('ui_meta'), 'store must persist ui_meta for thinking process')
  assert(storeSrc.includes('run_id'), 'store must persist run_id')
  console.log('ok: source contracts')

  // --- file fallback when PG has no turns / unreachable ---
  const fileOnlyId = `smoke_hist_file_${Date.now()}`
  const filePath = path.join(sessionsDir, `${fileOnlyId}.json`)
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      messages: [
        { role: 'user', content: 'file-fallback-user' },
        { role: 'assistant', content: 'file-fallback-assistant' }
      ]
    }),
    'utf8'
  )
  const fromFile = await readManagerSession(fileOnlyId)
  assert(fromFile.messages.length === 2, `expected 2 msgs from file, got ${fromFile.messages.length}`)
  assert(fromFile.messages[0]?.content === 'file-fallback-user', 'file user content mismatch')
  await fsp.unlink(filePath).catch(() => undefined)
  console.log('ok: empty/unreachable PG → file fallback')

  // --- PG write failure → force file ---
  const failWriteId = `smoke_hist_write_${Date.now()}`
  const prevUrl = process.env.AGENT_DATABASE_URL
  const prevAlt = process.env.CLAWHIVE_DATABASE_URL
  const prevDb = process.env.DATABASE_URL
  process.env.AGENT_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/none'
  delete process.env.CLAWHIVE_DATABASE_URL
  delete process.env.DATABASE_URL
  resetAgentPgPoolForTests()
  await writeManagerSession(failWriteId, {
    messages: [
      { role: 'user', content: 'pg-fail-user' },
      { role: 'assistant', content: 'pg-fail-assistant' }
    ]
  })
  const failFile = path.join(sessionsDir, `${failWriteId}.json`)
  const failText = await fsp.readFile(failFile, 'utf8')
  const failJson = JSON.parse(failText) as { messages: Array<{ content: string }> }
  assert(failJson.messages?.length === 2, 'PG fail must force file write')
  assert(failJson.messages[0]?.content === 'pg-fail-user', 'forced file content mismatch')
  await fsp.unlink(failFile).catch(() => undefined)
  if (prevUrl != null) process.env.AGENT_DATABASE_URL = prevUrl
  else delete process.env.AGENT_DATABASE_URL
  if (prevAlt != null) process.env.CLAWHIVE_DATABASE_URL = prevAlt
  else delete process.env.CLAWHIVE_DATABASE_URL
  if (prevDb != null) process.env.DATABASE_URL = prevDb
  else delete process.env.DATABASE_URL
  resetAgentPgPoolForTests()
  console.log('ok: PG write fail → force file')

  if (isAgentPgConfigured()) {
    console.log('note: archive e2e uses Docker SQL (live=0 / archive>0); smoke runtime has no pg driver')
  }

  if (prevBackend != null) process.env.MANAGER_STORAGE_BACKEND = prevBackend
  else delete process.env.MANAGER_STORAGE_BACKEND

  console.log('smoke-session-history-store: PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
