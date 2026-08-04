/**
 * SessionMeta workbenchMode 读写契约：
 * - 写 mode 保留 title
 * - 写 title 保留 mode
 * - sanitizeWorkbenchMode 归一化
 *
 * 用法：cd Manager_Agent && npx --yes tsx --tsconfig tsconfig.smoke.json scripts/smoke/gate/smoke-session-meta-workbench-mode.ts
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  readSessionMeta,
  sanitizeWorkbenchMode,
  writeSessionMeta,
  writeSessionWorkbenchMode
} from '../../../server/utils/session/managerSessionMeta'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-session-meta-workbench-mode] ${msg}`)
}

async function main() {
  console.log('smoke-session-meta-workbench-mode: start')
  assert(sanitizeWorkbenchMode('professional') === 'professional', 'pro mode')
  assert(sanitizeWorkbenchMode('pro') === 'professional', 'pro alias')
  assert(sanitizeWorkbenchMode('chat') === 'chat', 'chat mode')
  assert(sanitizeWorkbenchMode('dialog') === 'chat', 'dialog alias')
  assert(sanitizeWorkbenchMode('nope') === undefined, 'invalid mode')

  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-meta-'))
  const sid = `smoke_meta_${Date.now()}`

  await writeSessionWorkbenchMode(dataRoot, sid, 'professional')
  let meta = await readSessionMeta(dataRoot, sid)
  assert(meta.workbenchMode === 'professional', 'mode-only write')
  assert(!meta.title, 'mode-only has no title')

  await writeSessionMeta(dataRoot, sid, { title: '足底查询', customTitle: true })
  meta = await readSessionMeta(dataRoot, sid)
  assert(meta.title === '足底查询', 'title write')
  assert(meta.customTitle === true, 'customTitle')
  assert(meta.workbenchMode === 'professional', 'rename keeps mode')

  await writeSessionWorkbenchMode(dataRoot, sid, 'chat')
  meta = await readSessionMeta(dataRoot, sid)
  assert(meta.workbenchMode === 'chat', 'mode update')
  assert(meta.title === '足底查询', 'mode write keeps title')

  await fs.rm(dataRoot, { recursive: true, force: true })
  console.log('smoke-session-meta-workbench-mode: PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
