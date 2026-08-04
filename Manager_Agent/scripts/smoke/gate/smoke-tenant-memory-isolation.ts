/**
 * 多租户记忆隔离 smoke：TenantScope、跨租户契约、进化双轨与平台审核入口。
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

const mig = readSource('scripts/migrations/016_agent_memory_multitenant.sql')
assert(mig.includes('mgr_memory_entries'), 'migration touches memory entries')
assert(mig.includes('evo_global_candidates'), 'migration has global candidates')
assert(mig.includes('global_candidate'), 'evo status includes global_candidate')

const autonomy = readSource('Manager_Agent/server/plugins/managerAutonomyPlugin.ts')
assert(autonomy.includes('listActiveTenantIds'), 'autonomy iterates tenants')
assert(autonomy.includes('resolveManagerPolicyDir'), 'autonomy uses tenant policyDir')

const clear = readSource('Manager_Agent/server/utils/session/managerMemoryClear.ts')
assert(clear.includes('tenant_id = $1'), 'clear is tenant-scoped')

const bridge = readSource('Manager_Agent/server/graph/core/evolution/globalEvolutionBridge.ts')
assert(bridge.includes('sanitizePayload'), 'global sanitize')
assert(bridge.includes('reviewGlobalCandidate'), 'human review')
assert(bridge.includes('GLOBAL_BASELINE_TENANT_ID'), 'promote to _global_')

const platform = readSource('Manage-platform_Agent/backend/app/main.py')
assert(platform.includes('evolution/global-candidates'), 'platform lists candidates')
assert(platform.includes('evolution/global-review'), 'platform reviews candidates')

const companion = readSource('Companion_Agent/backend/app/save_store.py')
assert(companion.includes('tenant_id'), 'companion saves have tenant_id')

console.log('smoke-tenant-memory-isolation: ok')
