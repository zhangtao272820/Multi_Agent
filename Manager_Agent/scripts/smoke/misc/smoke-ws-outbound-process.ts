/**
 * Manager WS 出站 flush + 过程累积 smoke
 * 用法：cd Manager_Agent && npx --yes tsx --tsconfig tsconfig.smoke.json scripts/smoke/misc/smoke-ws-outbound-process.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWsOutboundFlusher } from '../../../server/utils/ws/wsOutboundFlusher'
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
  if (!cond) throw new Error(`[smoke-ws-outbound-process] ${msg}`)
}

async function main() {
  console.log('smoke-ws-outbound-process: start')

  // --- source contracts ---
  const setupSrc = fs.readFileSync(
    path.join(repoRoot, 'server/api/manager-ws/handlers/setup.ts'),
    'utf8'
  )
  assert(setupSrc.includes('createWsOutboundFlusher'), 'setup must use outbound flusher')
  assert(setupSrc.includes('noteRunProcessEvent'), 'setup must accumulate process events')
  const chatSrc = fs.readFileSync(
    path.join(repoRoot, 'server/api/manager-ws/handlers/handleChat.ts'),
    'utf8'
  )
  assert(chatSrc.includes('takeRunProcessUiMeta'), 'handleChat must persist ui_meta')
  const schemaSrc = fs.readFileSync(
    path.join(repoRoot, '../shared/agentMemorySchema.ts'),
    'utf8'
  )
  assert(schemaSrc.includes('ui_meta JSONB'), 'schema must declare ui_meta')
  const migPath = path.join(repoRoot, '../scripts/migrations/018_mgr_session_turn_ui_meta.sql')
  assert(fs.existsSync(migPath), 'migration 018 must exist')
  console.log('ok: source contracts')

  // --- outbound flusher drains across setImmediate ---
  const sent: Array<{ event: string; data?: unknown }> = []
  const flush = createWsOutboundFlusher({
    send: (raw) => {
      const parsed = JSON.parse(raw) as { event?: string; data?: unknown }
      sent.push({ event: String(parsed.event || ''), data: parsed.data })
    }
  })
  flush({ event: 'thinking', data: '步骤一', from: 'manager', runId: 'r1' })
  flush({ event: 'delta', data: '你好', from: 'synth', runId: 'r1' })
  flush({ event: 'final', data: '完整回答', from: 'manager', runId: 'r1' })
  assert(sent.length === 0, 'frames must not send synchronously before setImmediate')
  await new Promise<void>((r) => setTimeout(r, 40))
  assert(sent.length === 3, `expected 3 frames, got ${sent.length}`)
  assert(sent[0]?.event === 'thinking' && sent[0]?.data === '步骤一', 'thinking order')
  assert(sent[1]?.event === 'delta' && sent[1]?.data === '你好', 'delta order')
  assert(sent[2]?.event === 'final', 'final order')
  console.log('ok: outbound flusher order')

  // --- process accumulator + file session roundtrip ---
  resetRunProcessAccumulatorForTests()
  noteRunProcessEvent('run_smoke_1', 'thinking', '总管 Agent：开始处理…', 'manager')
  noteRunProcessEvent('run_smoke_1', 'thinking', '正在撰写回复…', 'manager')
  noteRunProcessEvent('run_smoke_1', 'delta', 'should-skip', 'synth')
  const uiMeta = takeRunProcessUiMeta('run_smoke_1')
  assert(uiMeta?.process?.length === 2, 'only persistable process events')
  assert(uiMeta!.process![0]!.text.includes('开始处理'), 'first thinking text')

  const prevBackend = process.env.MANAGER_STORAGE_BACKEND
  process.env.MANAGER_STORAGE_BACKEND = 'file'
  const sid = `smoke_ui_meta_${Date.now()}`
  await writeManagerSession(sid, {
    messages: [
      { role: 'user', content: '请总结压测结果' },
      {
        role: 'assistant',
        content: '压测结论正文',
        runId: 'run_smoke_1',
        uiMeta
      }
    ]
  })
  const loaded = await readManagerSession(sid)
  assert(loaded.messages.length === 2, 'roundtrip message count')
  assert(loaded.messages[1]?.runId === 'run_smoke_1', 'runId persisted')
  assert(
    Array.isArray(loaded.messages[1]?.uiMeta?.process) &&
      loaded.messages[1]!.uiMeta!.process!.length === 2,
    'ui_meta.process persisted'
  )
  const filePath = path.join(process.cwd(), '.data', 'sessions', `${sid}.json`)
  await fs.promises.unlink(filePath).catch(() => undefined)
  if (prevBackend != null) process.env.MANAGER_STORAGE_BACKEND = prevBackend
  else delete process.env.MANAGER_STORAGE_BACKEND
  console.log('ok: session ui_meta file roundtrip')

  // --- hydrate frontend source contract ---
  const sessionUiSrc = fs.readFileSync(
    path.join(repoRoot, 'app/composables/useManagerSession.ts'),
    'utf8'
  )
  assert(sessionUiSrc.includes('uiMeta'), 'frontend hydrate must read uiMeta')
  assert(sessionUiSrc.includes('process'), 'frontend hydrate must restore process')
  console.log('ok: frontend hydrate contract')

  console.log('smoke-ws-outbound-process: PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
