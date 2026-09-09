/**
 * 多租户记忆隔离 smoke：TenantScope、Process/Tool/Fold/Profile 收紧契约、进化双轨。
 * 运行：cd Manager_Agent && npm run smoke:tenant-memory
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GLOBAL_BASELINE_TENANT_ID,
  isTenantFailClosed,
  normalizeTenantId,
  requireTenantId,
  ScopeRequiredError,
  tenantCacheKey,
  tenantPolicyDir
} from '#agent-shared/tenantScope'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-tenant-memory-isolation] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

console.log('smoke-tenant-memory-isolation: start')

assert(normalizeTenantId('acme') === 'acme', 'normalize explicit')
assert(GLOBAL_BASELINE_TENANT_ID === '_global_', 'global baseline id')

const dirA = tenantPolicyDir('/tmp/data', 'tenant_a')
const dirB = tenantPolicyDir('/tmp/data', 'tenant_b')
assert(dirA.includes('tenants') && dirA.includes('tenant_a'), 'policy dir A')
assert(dirB.includes('tenant_b') && dirA !== dirB, 'policy dirs isolated')

assert(
  tenantCacheKey('mgr', 't1', 'mem', 'x') === 'mgr:t1:mem:x',
  'cache key format {service}:{tenant}:{type}:{id}'
)

const prevFail = process.env.MGR_TENANT_FAIL_CLOSED
const prevNode = process.env.NODE_ENV
try {
  process.env.MGR_TENANT_FAIL_CLOSED = '1'
  process.env.NODE_ENV = 'production'
  assert(isTenantFailClosed(), 'fail-closed on')
  let threw = false
  try {
    requireTenantId(undefined)
  } catch (e) {
    threw = e instanceof ScopeRequiredError
  }
  assert(threw, 'requireTenantId fail-closed throws')
  assert(requireTenantId('ok') === 'ok', 'requireTenantId with value')
} finally {
  if (prevFail === undefined) delete process.env.MGR_TENANT_FAIL_CLOSED
  else process.env.MGR_TENANT_FAIL_CLOSED = prevFail
  if (prevNode === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prevNode
}

const api = readSource('shared/agentMemoryApi.ts')
assert(api.includes('tenant_id'), 'agentMemoryApi uses tenant_id')
assert(api.includes('WHERE tenant_id'), 'recall filters by tenant')
assert(api.includes('ON CONFLICT (tenant_id, user_key)'), 'profile upsert composite key')
assert(api.includes('user_id = $4') || api.includes('userKey'), 'recall can scope by userKey')

const mig016 = readSource('scripts/migrations/016_agent_memory_multitenant.sql')
assert(mig016.includes('mgr_memory_entries'), 'migration touches memory entries')
assert(mig016.includes('evo_global_candidates'), 'migration has global candidates')
assert(mig016.includes('global_candidate'), 'evo status includes global_candidate')

const mig020 = readSource('scripts/migrations/020_agent_memory_tenant_harden.sql')
assert(mig020.includes('mgr_process_memory'), '020 hardens process memory')
assert(mig020.includes('mgr_process_memory_tenant_scenario_norm_key'), '020 process unique with tenant')
assert(mig020.includes('mgr_tool_memory_tenant_agent_tool_ctx_key'), '020 tool unique with tenant')
assert(mig020.includes('mgr_user_profiles_tenant_user_key'), '020 profile composite unique')
assert(mig020.includes('db_user_preferences_tenant_user_key'), '020 db prefs composite unique')
assert(mig020.includes('shared_user_context_view'), '020 view joins on tenant')

const processStore = readSource('shared/processMemoryStore.ts')
assert(processStore.includes('requireTenantId'), 'process memory requires tenant')
assert(processStore.includes('tenant_id'), 'process memory SQL uses tenant_id')
assert(processStore.includes('ON CONFLICT (tenant_id, scenario_key, question_norm)'), 'process upsert tenant unique')

const toolStore = readSource('shared/toolMemoryStore.ts')
assert(toolStore.includes('requireTenantId'), 'tool memory requires tenant')
assert(toolStore.includes('ON CONFLICT (tenant_id, agent, tool_name, context_key)'), 'tool upsert tenant unique')
assert(toolStore.includes('WHERE tenant_id = $1'), 'tool query filters tenant')

const fold = readSource('shared/memoryFoldJob.ts')
assert(fold.includes('tenantId'), 'fold job accepts tenantId')
assert(fold.includes('recordMemory'), 'fold writes via recordMemory')
assert(fold.includes('mgr_sessions'), 'fold joins sessions for tenant')

const autonomy = readSource('Manager_Agent/server/plugins/managerAutonomyPlugin.ts')
assert(autonomy.includes('listActiveTenantIds'), 'autonomy iterates tenants')
assert(autonomy.includes('resolveManagerPolicyDir'), 'autonomy uses tenant policyDir')
assert(autonomy.includes('runMemoryFoldJob(process.env, { tenantId: tid })'), 'autonomy folds per tenant')

const clear = readSource('Manager_Agent/server/utils/session/managerMemoryClear.ts')
assert(clear.includes('tenant_id = $1'), 'clear is tenant-scoped')
assert(clear.includes('DELETE FROM mgr_process_memory'), 'clear deletes process memory by tenant')
assert(clear.includes('DELETE FROM mgr_tool_memory'), 'clear deletes tool memory by tenant')

const composer = readSource('Manager_Agent/server/graph/core/plan/contextComposer.ts')
assert(composer.includes('tenantId'), 'composer passes tenant to process/tool recall')

const finalize = readSource('Manager_Agent/server/graph/nodes/final/finalizeNodeRun.ts')
assert(finalize.includes('tenantId: String(state.tenantId'), 'finalize writes tenant on process/tool')

const processApi = readSource('Manager_Agent/server/api/manager/process-memory.get.ts')
assert(processApi.includes('requireTenantId'), 'process-memory API requires tenant')
assert(processApi.includes('tenant_required'), 'process-memory API fail-closed')

const bridge = readSource('Manager_Agent/server/graph/core/evolution/globalEvolutionBridge.ts')
assert(bridge.includes('sanitizePayload'), 'global sanitize')
assert(bridge.includes('reviewGlobalCandidate'), 'human review')
assert(bridge.includes('GLOBAL_BASELINE_TENANT_ID'), 'promote to _global_')

const platform = readSource('Manage-platform_Agent/backend/app/main.py')
assert(platform.includes('evolution/global-candidates'), 'platform lists candidates')
assert(platform.includes('evolution/global-review'), 'platform reviews candidates')

const companionPath = 'Companion_Agent/backend/app/save_store.py'
if (fs.existsSync(path.join(repoRoot, companionPath))) {
  const companion = readSource(companionPath)
  assert(companion.includes('tenant_id'), 'companion saves have tenant_id')
} else {
  console.log('smoke-tenant-memory-isolation: skip companion (not in workspace)')
}

const feedback = readSource('Manager_Agent/server/api/manager/session-feedback.post.ts')
assert(feedback.includes('requireTenantId'), 'feedback uses requireTenantId')
assert(feedback.includes('tenant_required'), 'feedback fails closed without tenant')

const resolveUser = readSource('shared/resolveRequestUser.ts')
assert(resolveUser.includes('requireTenantId'), 'resolveRequestUser fail-closed tenant')
assert(resolveUser.includes('tenant_required'), 'resolveRequestUser returns tenant_required')

const runner = readSource('scripts/run-agent-memory-migrations.ts')
assert(runner.includes('020_agent_memory_tenant_harden.sql'), 'migration runner includes 020')
assert(runner.includes('021_mgr_memory_embeddings_tenant_unique.sql'), 'migration runner includes 021')

const mig021 = readSource('scripts/migrations/021_mgr_memory_embeddings_tenant_unique.sql')
assert(mig021.includes('mgr_memory_embeddings_tenant_memory_key'), '021 unique (tenant_id, memory_key)')

const sessStore = readSource('Manager_Agent/server/utils/session/managerSessionStore.ts')
assert(sessStore.includes('INSERT INTO mgr_sessions (id, tenant_id, updated_at)'), 'session INSERT writes tenant_id')
assert(sessStore.includes('export async function bindSessionTenant'), 'bindSessionTenant exported')

const embStore = readSource('Manager_Agent/server/utils/session/managerMemoryEmbeddingsStore.ts')
assert(embStore.includes('ON CONFLICT (tenant_id, memory_key)'), 'embeddings conflict includes tenant')

const adminClient = readSource('Manager_Agent/server/utils/agents/adminClient.ts')
assert(adminClient.includes('tenantId'), 'adminClient passes tenantId')
assert(adminClient.includes('tenant_id'), 'adminClient body/header tenant_id')

console.log('smoke-tenant-memory-isolation: ok')
