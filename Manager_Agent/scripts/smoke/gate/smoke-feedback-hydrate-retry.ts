/**
 * 契约：有用/无用 hydrate 在 Docker 暖机失败后须退避重试，避免「须重登才恢复」。
 * 不调 LLM、不连库。
 * 运行：cd Manager_Agent && npx tsx scripts/smoke/gate/smoke-feedback-hydrate-retry.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  retryFeedbackHydrate,
  shouldRetryFeedbackHydrate,
  type FeedbackHydrateStatus
} from '../../../agent-repo-shared/feedbackHydrateRetry.ts'

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

const mgrPage = readSource('Manager_Agent/app/composables/useManagerChatPage.ts')
assert.ok(mgrPage.includes('retryFeedbackHydrate'), 'manager bootstrap uses retry')
assert.ok(mgrPage.includes('hydrateFeedbackWithRetry'), 'manager has hydrateFeedbackWithRetry')
assert.ok(mgrPage.includes('visibilitychange'), 'manager rehydrates on visibility')
assert.ok(mgrPage.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'manager uses warm hydrate opts')
assert.ok(!mgrPage.includes('hasLocalFb'), 'manager must not skip hydrate when local scores exist')

const mgrSession = readSource('Manager_Agent/app/composables/useManagerSession.ts')
assert.ok(mgrSession.includes('retryFeedbackHydrate'), 'switchSession uses retry')
assert.ok(mgrSession.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'switchSession uses warm opts')

const rag = readSource('RAG_Agent/app/app.vue')
assert.ok(rag.includes('retryFeedbackHydrate'), 'rag uses retry helper')
assert.ok(rag.includes('hydrateFeedbackWithRetry'), 'rag has hydrateFeedbackWithRetry')
assert.ok(/await loadSessionFromServer[\s\S]{0,200}hydrateFeedbackWithRetry/.test(rag), 'rag loads history before feedback')
assert.ok(rag.includes('visibilitychange'), 'rag rehydrates on visibility')
assert.ok(/t && t !== prev/.test(rag), 'rag rebootstrap on any token change')
assert.ok(rag.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'rag uses warm opts')
assert.ok(!/hasLocalFb/.test(rag), 'rag must not skip hydrate when local scores exist')

const db = readSource('DB_Agent/app/composables/useDbChatPage.ts')
assert.ok(db.includes('retryFeedbackHydrate'), 'db uses retry')
assert.ok(db.includes('hydrateFeedbackWithRetry'), 'db has hydrateFeedbackWithRetry')
assert.ok(db.includes('visibilitychange'), 'db rehydrates on visibility')
assert.ok(db.includes('FEEDBACK_HYDRATE_WARM_OPTS'), 'db uses warm opts')
assert.ok(!db.includes('hasLocalFb'), 'db must not skip hydrate when local scores exist')

const admin = readSource('AI_admin_Agent/frontend/src/App.tsx')
assert.ok(admin.includes('hydrateFeedbackWithRetry'), 'admin has hydrateFeedbackWithRetry')
assert.ok(admin.includes('visibilitychange'), 'admin rehydrates on visibility')
assert.ok(!/if \(scores\[uidx\] === 1 \|\| scores\[uidx\] === -1\) continue/.test(admin), 'admin server SSOT (no local-prefer skip)')

const vannaMain = readSource('Vanna_DbAgent/app/main.py')
assert.ok(vannaMain.includes('/api/session-feedback'), 'vanna exposes session-feedback GET')

const vannaLearn = readSource('Vanna_DbAgent/app/learning.py')
assert.ok(vannaLearn.includes('def list_session_feedback'), 'vanna lists session feedback')

const vannaUi = readSource('Vanna_DbAgent/frontend/index.html')
assert.ok(vannaUi.includes('hydrateFeedbackFromServer'), 'vanna UI hydrates from server')

console.log('smoke-feedback-hydrate-retry: ok')
