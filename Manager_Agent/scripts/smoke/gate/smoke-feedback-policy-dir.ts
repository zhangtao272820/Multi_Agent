/**
 * 契约：有用/无用 读写与控制端 experience 列表共用 resolveManagerPolicyDir。
 * 不调 LLM、不连库。运行：cd Manager_Agent && npm run smoke:feedback-policy-dir
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveManagerPolicyDir } from '../../../server/utils/session/managerPolicyDir'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-feedback-policy-dir] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

console.log('smoke-feedback-policy-dir: start')

const prevScope = process.env.MGR_TENANT_SCOPE
try {
  process.env.MGR_TENANT_SCOPE = '1'
  const writeDir = resolveManagerPolicyDir('acme')
  const listDir = resolveManagerPolicyDir('acme')
  assert(writeDir === listDir, 'write/list policyDir identical for same tenant')
  assert(writeDir.replace(/\\/g, '/').includes('/tenants/acme'), 'scoped under tenants/acme')

  const defaultDir = resolveManagerPolicyDir(undefined)
  assert(defaultDir.replace(/\\/g, '/').includes('/tenants/'), 'default tenant still scoped when MGR_TENANT_SCOPE=1')

  process.env.MGR_TENANT_SCOPE = '0'
  const globalDir = resolveManagerPolicyDir('acme')
  assert(globalDir.replace(/\\/g, '/').endsWith('/.data') || /[/\\]\.data$/.test(globalDir), 'scope off → global .data')
} finally {
  if (prevScope === undefined) delete process.env.MGR_TENANT_SCOPE
  else process.env.MGR_TENANT_SCOPE = prevScope
}

const feedbackGet = readSource('Manager_Agent/server/api/manager/session-feedback.get.ts')
assert(feedbackGet.includes('resolveManagerPolicyDir'), 'session-feedback GET uses resolveManagerPolicyDir')
assert(feedbackGet.includes('auth.tenantId'), 'session-feedback GET scopes by auth.tenantId')
assert(!/path\.join\(process\.cwd\(\),\s*['"]\.data['"]\)/.test(feedbackGet), 'session-feedback GET not hard-coded .data')

const processFb = readSource('Manager_Agent/server/api/manager/processManagerFeedback.ts')
assert(processFb.includes('resolveManagerPolicyDir(tenantId)'), 'feedback write uses resolveManagerPolicyDir(tenantId)')

const ops = readSource('Manager_Agent/server/api/manager/ops.post.ts')
assert(ops.includes('tenantPolicyDir'), 'ops defines tenantPolicyDir')
assert(ops.includes('listExperienceCandidates(tenantPolicyDir'), 'experience list uses tenantPolicyDir')
assert(ops.includes('promoteExperienceCandidateById(tenantPolicyDir'), 'experience promote uses tenantPolicyDir')
assert(ops.includes('setExperienceCandidateStatus(tenantPolicyDir'), 'experience reject uses tenantPolicyDir')

const platform = readSource('Manage-platform_Agent/backend/app/main.py')
assert(platform.includes('payload["tenantId"]'), 'CP evolution ops injects tenantId')
assert(
  /experience_candidates_list[\s\S]{0,200}tenantId/.test(platform),
  'CP bundle experience list passes tenantId'
)

const bootstrap = readSource('Manager_Agent/app/composables/useManagerChatPage.ts')
assert(bootstrap.includes('waitForClawhiveAuthReady'), 'bootstrap waits for auth ready')
assert(bootstrap.includes('clawhiveAuthReady'), 'bootstrap watches clawhiveAuthReady for re-hydrate')
assert(bootstrap.includes('historyHydrateFailed'), 'bootstrap tracks history hydrate failure for WARM')
assert(
  /await hydrateSessionFromServer\(sid\)[\s\S]{0,320}reconcileTurnFeedbackKeys\(\)[\s\S]{0,400}hydrateFeedbackWithRetry/.test(
    bootstrap
  ),
  'bootstrap sequences session→reconcile→feedback like switchSession'
)

const hydrate = readSource('Manager_Agent/app/composables/useManagerSession.ts')
assert(hydrate.includes("return 'auth'"), 'feedback hydrate surfaces auth failure (not silent catch)')
assert(hydrate.includes('retryFeedbackHydrateThenWatch') || hydrate.includes('retryFeedbackHydrate'), 'switchSession retries feedback hydrate after docker warm')
assert(hydrate.includes("hist === 'error'"), 'history error forces warm feedback path')

const chatPage = readSource('Manager_Agent/app/composables/useManagerChatPage.ts')
assert(chatPage.includes('hydrateFeedbackWithRetry'), 'bootstrap uses hydrateFeedbackWithRetry')
assert(chatPage.includes('visibilitychange'), 'bootstrap rehydrates feedback on visibility after docker recreate')
assert(chatPage.includes('hasLocalFeedbackScores'), 'visibility/bootstrap warm when local feedback cache exists')

console.log('smoke-feedback-policy-dir: ok')
