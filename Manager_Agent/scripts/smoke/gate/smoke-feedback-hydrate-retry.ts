/**
 * 契约：有用/无用 hydrate 在 Docker 暖机失败后须退避重试 + dirty watch，避免「须重登才恢复」。
 * 不调 LLM、不连库。
 * 运行：cd Manager_Agent && npx tsx scripts/smoke/gate/smoke-feedback-hydrate-retry.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isFeedbackHydrateDirty,
  retryFeedbackHydrate,
  retryFeedbackHydrateThenWatch,
  shouldRetryFeedbackHydrate,
  watchFeedbackHydrateUntilOk,
  type FeedbackHydrateStatus
} from '../../../agent-repo-shared/feedbackHydrateRetry.ts'
import {
  FEEDBACK_PENDING_ACK,
  clearStaleFeedbackPendingAcks,
  isFeedbackPendingAck
} from '../../../agent-repo-shared/feedbackSubmitUi.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

console.log('smoke-feedback-hydrate-retry: start')

assert.equal(shouldRetryFeedbackHydrate('ok'), false)
assert.equal(shouldRetryFeedbackHydrate('auth'), true)
assert.equal(shouldRetryFeedbackHydrate('error'), true)
assert.equal(shouldRetryFeedbackHydrate('empty'), true)
assert.equal(shouldRetryFeedbackHydrate('empty', { retryEmpty: false }), false)
assert.equal(isFeedbackHydrateDirty('auth'), true)
assert.equal(isFeedbackHydrateDirty('ok'), false)

assert.equal(isFeedbackPendingAck(FEEDBACK_PENDING_ACK), true)
{
  const scores: Record<string, number> = { '1': 1 }
  const acks: Record<string, string> = { '1': FEEDBACK_PENDING_ACK }
  clearStaleFeedbackPendingAcks(scores, acks)
  assert.equal(scores['1'], undefined)
  assert.equal(acks['1'], undefined)
}

{
  let n = 0
  const delays: number[] = []
  const status = await retryFeedbackHydrate(
    async () => {
      n += 1
      return (n < 3 ? 'error' : 'ok') as FeedbackHydrateStatus
    },
    {
      attempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 50,
      sleep: async (ms) => {
        delays.push(ms)
      }
    }
  )
  assert.equal(status, 'ok')
  assert.equal(n, 3)
  assert.ok(delays.length >= 2, 'retried with backoff')
}

{
  let n = 0
  const status = await retryFeedbackHydrate(async () => {
    n += 1
    return 'empty'
  }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5, retryEmpty: false, sleep: async () => {} })
  assert.equal(status, 'empty')
  assert.equal(n, 1, 'empty without retryEmpty stops immediately')
}

{
  let n = 0
  const { stop, kick } = watchFeedbackHydrateUntilOk(
    async () => {
      n += 1
      return (n < 2 ? 'auth' : 'ok') as FeedbackHydrateStatus
    },
    {
      intervalMs: 15,
      maxMs: 2000,
      retryEmpty: true,
      isVisible: () => true
    }
  )
  kick()
  const deadline = Date.now() + 1500
  while (n < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(n >= 2, 'watch retries after auth until ok')
  stop()
}

{
  let n = 0
  const { status, stopWatch } = await retryFeedbackHydrateThenWatch(
    async () => {
      n += 1
      return 'ok' as FeedbackHydrateStatus
    },
    {
      attempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 5,
      retryEmpty: false,
      sleep: async () => {},
      intervalMs: 50,
      maxMs: 200
    }
  )
  assert.equal(status, 'ok')
  assert.equal(n, 1)
  stopWatch()
}

{
  // 同步阶段不对 empty 长退避；warm 时交给 dirty watch
  let n = 0
  const { status, stopWatch } = await retryFeedbackHydrateThenWatch(
    async () => {
      n += 1
      return (n < 3 ? 'empty' : 'ok') as FeedbackHydrateStatus
    },
    {
      attempts: 8,
      baseDelayMs: 10,
      maxDelayMs: 50,
      retryEmpty: true,
      sleep: async () => {},
      intervalMs: 20,
      maxMs: 2000,
      isVisible: () => true
    }
  )
  assert.equal(status, 'empty', 'sync stops on first empty')
  // kick() 会立刻再 tick 一次，故同步返回后 n 可能已是 2；不得出现 attempts=8 的空退避
  assert.ok(n <= 2, `sync must not burn empty backoff retries (n=${n})`)
  const deadline = Date.now() + 1500
  while (n < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.ok(n >= 3, 'dirty watch continues empty→ok without blocking sync')
  stopWatch()
}

const mgrPage = readSource('Manager_Agent/app/composables/useManagerChatPage.ts')
assert.ok(mgrPage.includes('hydrateFeedbackWithRetry'), 'manager has hydrateFeedbackWithRetry')
assert.ok(mgrPage.includes('visibilitychange'), 'manager rehydrates on visibility')
assert.ok(mgrPage.includes('clawhiveAuthReady'), 'manager rebootstrap on authReady')
assert.ok(mgrPage.includes('historyHydrateFailed'), 'manager warm when history hydrate fails')
assert.ok(mgrPage.includes('hasLocalFeedbackScores'), 'manager warm when local feedback cache exists')
assert.ok(!mgrPage.includes('hasLocalFb'), 'manager must not skip hydrate when local scores exist')

const mgrSession = readSource('Manager_Agent/app/composables/useManagerSession.ts')
assert.ok(mgrSession.includes('retryFeedbackHydrateThenWatch'), 'session uses retry+watch')
assert.ok(mgrSession.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'session uses warm opts')
assert.ok(mgrSession.includes('hydrateFeedbackWithRetry'), 'session exports hydrateFeedbackWithRetry')
assert.ok(mgrSession.includes('clearStaleFeedbackPendingAcks'), 'manager clears pending on restore')
assert.ok(mgrSession.includes("hist === 'error'"), 'history error forces warm feedback hydrate')

const mgrWs = readSource('Manager_Agent/app/composables/managerWsInbound.ts')
assert.ok(mgrWs.includes('hydrateFeedbackWithRetry'), 'WS resumed uses shared hydrateFeedbackWithRetry')
assert.ok(!mgrWs.includes('retryFeedbackHydrate\n'), 'WS resumed not bare retry-only path')
const rag = readSource('RAG_Agent/app/app.vue')
assert.ok(rag.includes('retryFeedbackHydrateThenWatch'), 'rag uses retry+watch helper')
assert.ok(rag.includes('hydrateFeedbackWithRetry'), 'rag has hydrateFeedbackWithRetry')
assert.ok(/await loadSessionFromServer[\s\S]{0,400}hydrateFeedbackWithRetry/.test(rag), 'rag loads history before feedback')
assert.ok(
  /sessionSwitching\.value = false[\s\S]{0,200}void hydrateFeedbackWithRetry/.test(rag),
  'rag must not block sessionSwitching on feedback hydrate'
)
assert.ok(rag.includes('visibilitychange'), 'rag rehydrates on visibility')
assert.ok(/t && t !== prev/.test(rag), 'rag rebootstrap on any token change')
assert.ok(rag.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'rag uses warm opts')
assert.ok(rag.includes('clearStaleFeedbackPendingAcks'), 'rag clears pending on restore')
assert.ok(!/hasLocalFb/.test(rag), 'rag must not skip hydrate when local scores exist')

const ragSessions = readSource('RAG_Agent/server/api/rag/sessions.get.ts')
assert.ok(ragSessions.includes('listSidebarItemsFromPg'), 'rag sessions list uses batched PG sidebar query')
assert.ok(!/for \(const sid of sessionIdSet\)[\s\S]{0,120}await readRagSession/.test(ragSessions), 'rag sessions must not N+1 readRagSession on primary path')

const db = readSource('DB_Agent/app/composables/useDbChatPage.ts')
assert.ok(db.includes('retryFeedbackHydrateThenWatch'), 'db uses retry+watch')
assert.ok(db.includes('hydrateFeedbackWithRetry'), 'db has hydrateFeedbackWithRetry')
assert.ok(db.includes('visibilitychange'), 'db rehydrates on visibility')
assert.ok(db.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'db uses warm opts')
assert.ok(db.includes('clearStaleFeedbackPendingAcks'), 'db clears pending on restore')
assert.ok(!db.includes('hasLocalFb'), 'db must not skip hydrate when local scores exist')

const admin = readSource('AI_admin_Agent/frontend/src/App.tsx')
assert.ok(admin.includes('hydrateFeedbackWithRetry'), 'admin has hydrateFeedbackWithRetry')
assert.ok(admin.includes('retryFeedbackHydrateThenWatch'), 'admin uses shared retry+watch')
assert.ok(admin.includes('visibilitychange'), 'admin rehydrates on visibility')
assert.ok(admin.includes('clearStaleFeedbackPendingAcks'), 'admin clears pending on restore')
assert.ok(!/if \(scores\[uidx\] === 1 \|\| scores\[uidx\] === -1\) continue/.test(admin), 'admin server SSOT (no local-prefer skip)')

const vannaMain = readSource('Vanna_DbAgent/app/main.py')
assert.ok(vannaMain.includes('/api/session-feedback'), 'vanna exposes session-feedback GET')

const vannaLearn = readSource('Vanna_DbAgent/app/learning.py')
assert.ok(vannaLearn.includes('def list_session_feedback'), 'vanna lists session feedback')

const vannaUi = readSource('Vanna_DbAgent/frontend/index.html')
assert.ok(vannaUi.includes('hydrateFeedbackFromServer') || vannaUi.includes('hydrateFeedbackWithRetry'), 'vanna UI hydrates from server')
assert.ok(vannaUi.includes('retryFeedbackHydrate'), 'vanna uses retryFeedbackHydrate')
assert.ok(vannaUi.includes('watchFeedbackHydrateUntilOk') || vannaUi.includes('retryFeedbackHydrateThenWatch'), 'vanna uses dirty watch')
assert.ok(vannaUi.includes('shouldForceLogoutOn401'), 'vanna warm-up safe 401 logout')
assert.ok(!/const hasLocal = Object\.keys\(feedbackByMsg/.test(vannaUi), 'vanna must not skip rehydrate when local scores exist')
assert.ok(!/if \(hasLocal\) return/.test(vannaUi), 'vanna must not early-return on hasLocal')

console.log('smoke-feedback-hydrate-retry: ok')
