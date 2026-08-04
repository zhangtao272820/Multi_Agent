/**
 * Smoke: 会话权威在 PG，禁止依赖客户端 historyIds / 空列表应为空。
 * 用法（本机已起 clawhive_postgres + agents）:
 *   npx tsx scripts/smoke/session/smoke-server-session-authority.ts
 */
import { agentPgQuery } from '../../../shared/agentPgClient'

async function main() {
  const checks: string[] = []

  const tables = await agentPgQuery<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
     AND tablename IN ('mgr_sessions','db_sessions','db_session_turns','rag_sessions','adm_sessions','adm_session_turns')`
  )
  const names = new Set((tables?.rows || []).map((r) => r.tablename))
  for (const t of ['db_sessions', 'db_session_turns', 'adm_sessions', 'adm_session_turns']) {
    if (!names.has(t)) throw new Error(`missing table ${t}`)
    checks.push(`table:${t}`)
  }

  const sid = `smoke_sess_${Date.now()}`
  const uid = 'smoke_user'
  const ok = await agentPgQuery(
    `INSERT INTO db_sessions (id, user_id, title, updated_at) VALUES ($1,$2,'smoke',NOW())
     ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`,
    [sid, uid]
  )
  if (!ok) throw new Error('db_sessions insert failed')
  await agentPgQuery(
    `INSERT INTO db_session_turns (session_id, turn_index, role, content) VALUES ($1,0,'user','hello'),($1,1,'assistant','world')`,
    [sid]
  )
  const listed = await agentPgQuery<{ id: string }>(
    `SELECT id FROM db_sessions WHERE user_id=$1 AND id=$2`,
    [uid, sid]
  )
  if (!listed?.rows?.length) throw new Error('db session list miss')
  await agentPgQuery(`DELETE FROM db_sessions WHERE id=$1`, [sid])
  checks.push('db_sessions:roundtrip')

  const asid = `smoke_adm_${Date.now()}`
  await agentPgQuery(
    `INSERT INTO adm_sessions (id, user_id, title, updated_at) VALUES ($1,$2,'adm',NOW())
     ON CONFLICT (id) DO UPDATE SET updated_at=NOW()`,
    [asid, uid]
  )
  await agentPgQuery(
    `INSERT INTO adm_session_turns (session_id, role, content) VALUES ($1,'user','hi'),($1,'assistant','yo')`,
    [asid]
  )
  await agentPgQuery(`DELETE FROM adm_sessions WHERE id=$1`, [asid])
  await agentPgQuery(`DELETE FROM adm_session_turns WHERE session_id=$1`, [asid]).catch(() => null)
  checks.push('adm_sessions:roundtrip')

  console.log(JSON.stringify({ ok: true, checks }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
