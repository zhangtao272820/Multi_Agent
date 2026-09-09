/**
 * 契约：purge 不得误删 sessionStorage 有用/无用缓存（F5 丢反馈根因）。
 * 不调 LLM、不连库。
 * 运行：cd Manager_Agent && npm run smoke:feedback-session-storage-purge
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_SESSION_FEEDBACK_PREFIXES,
  isClientSessionFeedbackCacheKey,
  purgeForbiddenClientSessionStorage
} from '../../../agent-repo-shared/agentSessionClientStorage.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

/** 最小 in-memory Storage，供纯函数 purge 测 */
function makeMemoryStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial))
  const storage = {
    get length() {
      return map.size
    },
    key(i: number) {
      return [...map.keys()][i] ?? null
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null
    },
    setItem(k: string, v: string) {
      map.set(k, String(v))
    },
    removeItem(k: string) {
      map.delete(k)
    },
    clear() {
      map.clear()
    }
  }
  return storage as Storage
}

console.log('smoke-feedback-session-storage-purge: start')

assert.equal(CLIENT_SESSION_FEEDBACK_PREFIXES.length, 4)
assert.equal(isClientSessionFeedbackCacheKey('manager_session_feedback:abc'), true)
assert.equal(isClientSessionFeedbackCacheKey('rag_session_feedback:x'), true)
assert.equal(isClientSessionFeedbackCacheKey('db_session_feedback:x'), true)
assert.equal(isClientSessionFeedbackCacheKey('admin_session_feedback:x'), true)
assert.equal(isClientSessionFeedbackCacheKey('manager_session_history'), false)
assert.equal(isClientSessionFeedbackCacheKey('manager_session_id'), false)

{
  const session = makeMemoryStorage({
    'manager_session_feedback:s1': JSON.stringify({ scores: { 'umidx:0': 1 } }),
    'rag_session_feedback:s1': '{}',
    'db_session_feedback:s1': '{}',
    'admin_session_feedback:s1': '{}',
    manager_session_id: 's1',
    manager_session_history: '[]',
    chat_logs: '[]',
    'manager_chat_logs:s1': '[]'
  })
  const { removed } = purgeForbiddenClientSessionStorage(session, { storageKind: 'session' })
  assert.ok(session.getItem('manager_session_feedback:s1'), 'keep manager feedback cache')
  assert.ok(session.getItem('rag_session_feedback:s1'), 'keep rag feedback cache')
  assert.ok(session.getItem('db_session_feedback:s1'), 'keep db feedback cache')
  assert.ok(session.getItem('admin_session_feedback:s1'), 'keep admin feedback cache')
  assert.ok(session.getItem('manager_session_id'), 'keep tab session pointer')
  assert.equal(session.getItem('manager_session_history'), null, 'purge real history dirty key')
  assert.equal(session.getItem('chat_logs'), null, 'purge chat_logs')
  assert.ok(removed.includes('manager_session_history') || removed.includes('chat_logs'), 'removed dirty keys')
}

{
  const local = makeMemoryStorage({
    'manager_session_feedback:s1': '{}',
    clawhive_access_token: 'tok'
  })
  const { removed } = purgeForbiddenClientSessionStorage(local, { storageKind: 'local' })
  assert.equal(local.getItem('manager_session_feedback:s1'), null, 'localStorage must not keep feedback')
  assert.ok(removed.includes('manager_session_feedback:s1'))
  assert.ok(local.getItem('clawhive_access_token'), 'keep auth token')
}

const shared = readSource('shared/agentSessionClientStorage.ts')
assert.ok(shared.includes('CLIENT_SESSION_FEEDBACK_PREFIXES'), 'shared exports feedback prefixes')
assert.ok(shared.includes('isClientSessionFeedbackCacheKey'), 'shared helper')

const mgrPage = readSource('Manager_Agent/app/composables/useManagerChatPage.ts')
assert.ok(mgrPage.includes('clawhiveAuthReady'), 'manager watches auth ready')
assert.ok(mgrPage.includes('historyHydrateFailed'), 'manager tracks history hydrate failure')
assert.ok(mgrPage.includes('hasLocalFeedbackScores'), 'manager warm on local scores')

const mgrSession = readSource('Manager_Agent/app/composables/useManagerSession.ts')
assert.ok(mgrSession.includes('hist === \'error\''), 'switchSession warm on history error')
assert.ok(mgrSession.includes('hydrateFeedbackWithRetry'), 'switchSession shares hydrateFeedbackWithRetry')

const ws = readSource('Manager_Agent/app/composables/managerWsInbound.ts')
assert.ok(ws.includes('hydrateFeedbackWithRetry'), 'WS resumed uses shared hydrate+watch')
assert.ok(!/retryFeedbackHydrate\b/.test(ws) || ws.includes('hydrateFeedbackWithRetry'), 'WS not stuck on bare retry only')

console.log('smoke-feedback-session-storage-purge: ok')
