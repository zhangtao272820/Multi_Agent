/**
 * 过程累积 + 文件会话 ui_meta 往返。
 * 用法：cd Manager_Agent && npx --yes tsx --tsconfig tsconfig.smoke.json scripts/smoke/gate/smoke-session-ui-meta.ts
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  noteRunProcessEvent,
  takeRunProcessUiMeta,
  resetRunProcessAccumulatorForTests
} from '../../../server/utils/session/runProcessAccumulator'
import {
  readManagerSession,
  writeManagerSession
} from '../../../server/utils/session/managerSessionStore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-session-ui-meta] ${msg}`)
}

async function main() {
  console.log('smoke-session-ui-meta: start')

  // --- source contracts ---
  const setupSrc = fs.readFileSync(
    path.join(repoRoot, 'server/api/manager-ws/handlers/setup.ts'),
    'utf8'
  )
  assert(setupSrc.includes('createWsOutboundFlusher'), 'setup must use outbound flusher')
  assert(setupSrc.includes('noteRunProcessEvent'), 'setup must note process events')

  const chatSrc = fs.readFileSync(
    path.join(repoRoot, 'server/api/manager-ws/handlers/handleChat.ts'),
    'utf8'
  )
  assert(chatSrc.includes('takeRunProcessUiMeta'), 'handleChat must persist uiMeta')
  assert(chatSrc.includes('uiMeta'), 'handleChat assistant write includes uiMeta')

  const storeSrc = fs.readFileSync(
    path.join(repoRoot, 'server/utils/session/managerSessionStore.ts'),
    'utf8'
  )
  assert(storeSrc.includes('ui_meta'), 'store must read/write ui_meta')
  assert(storeSrc.includes('run_id'), 'store must read/write run_id')

  const hydrateSrc = fs.readFileSync(
    path.join(repoRoot, 'app/composables/useManagerSession.ts'),
    'utf8'
  )
  assert(hydrateSrc.includes('uiMeta'), 'hydrate must restore uiMeta.process')
  assert(/kind.*thinking|process/.test(hydrateSrc), 'hydrate rebuilds process kinds')

  const schemaSrc = fs.readFileSync(
    path.join(repoRoot, '../shared/agentMemorySchema.ts'),
    'utf8'
  )
  assert(schemaSrc.includes('ui_meta JSONB'), 'schema includes ui_meta')
  assert(
    schemaSrc.includes('ALTER TABLE mgr_session_turns ADD COLUMN IF NOT EXISTS ui_meta'),
    'schema ALTER for existing DBs'
  )

  const migPath = path.join(repoRoot, '../scripts/migrations/018_mgr_session_turn_ui_meta.sql')
  assert(fs.existsSync(migPath), 'migration 018 exists')
  console.log('ok: source contracts')

  // --- accumulator ---
  resetRunProcessAccumulatorForTests()
  const runId = `smoke_run_${Date.now()}`
  noteRunProcessEvent(runId, 'thinking', '总管 Agent：开始处理…', 'manager')
  noteRunProcessEvent(runId, 'thinking', '路由：LLM 异常', 'manager') // may filter? no, note all thinking
  noteRunProcessEvent(runId, 'delta', '流式正文', 'synth') // not persistable
  noteRunProcessEvent(runId, 'thought_delta', '正在查询数据库…', 'manager')
  noteRunProcessEvent(runId, 'final', '最终答案', 'manager') // not process kind

  const uiMeta = takeRunProcessUiMeta(runId)
  assert(uiMeta?.process?.length === 3, `expected 3 process events, got ${uiMeta?.process?.length}`)
  assert(uiMeta!.process![0]!.kind === 'thinking', 'first thinking')
  assert(uiMeta!.process![2]!.kind === 'thought_delta', 'last thought_delta')
  assert(!takeRunProcessUiMeta(runId), 'take clears accumulator')
  console.log('ok: process accumulator')

  // --- file roundtrip ---
  const prevBackend = process.env.MANAGER_STORAGE_BACKEND
  process.env.MANAGER_STORAGE_BACKEND = 'file'
  const sid = `smoke_uimeta_${Date.now()}`
  const sessionsDir = path.join(process.cwd(), '.data', 'sessions')
  await fsp.mkdir(sessionsDir, { recursive: true })

  await writeManagerSession(sid, {
    messages: [
      { role: 'user', content: '帮我总结压测结果' },
      {
        role: 'assistant',
        content: '结论：对称性正常。',
        runId,
        uiMeta: {
          process: [
            { kind: 'thinking', text: '总管 Agent：开始处理…', from: 'manager' },
            { kind: 'thought_delta', text: '正在汇总草稿…', from: 'manager' }
          ]
        }
      }
    ]
  })

  const loaded = await readManagerSession(sid)
  assert(loaded.messages.length === 2, 'expected 2 messages')
  const asst = loaded.messages[1]!
  assert(asst.role === 'assistant', 'assistant role')
  assert(asst.runId === runId, 'runId roundtrip')
  assert(asst.uiMeta?.process?.length === 2, 'uiMeta.process roundtrip')
  assert(asst.uiMeta!.process![0]!.text.includes('开始处理'), 'thinking text preserved')

  await fsp.unlink(path.join(sessionsDir, `${sid}.json`)).catch(() => undefined)
  if (prevBackend != null) process.env.MANAGER_STORAGE_BACKEND = prevBackend
  else delete process.env.MANAGER_STORAGE_BACKEND

  console.log('ok: file ui_meta roundtrip')
  console.log('smoke-session-ui-meta: PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
