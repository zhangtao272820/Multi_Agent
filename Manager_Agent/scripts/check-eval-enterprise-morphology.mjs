/**
 * 企业化形态 golden 结构校验（不调 LLM）。
 * 用法：node scripts/check-eval-enterprise-morphology.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateCapGoldenFile } from '../agent-repo-shared/evalCapReport.mjs'

function isTenantFailClosed(env) {
  if (String(env.MGR_TENANT_SCOPE ?? '1').trim() === '0') return false
  const v = String(env.MGR_TENANT_FAIL_CLOSED ?? '').trim()
  if (v === '0' || v.toLowerCase() === 'false') return false
  if (v === '1' || v.toLowerCase() === 'true') return true
  const profile = String(env.AGENT_SECURITY_PROFILE || '').trim().toLowerCase()
  return profile === 'enterprise' || profile === 'prod' || profile === 'production'
}

function requireTenantId(raw, env) {
  const explicit = String(raw ?? '').trim()
  if (explicit) return explicit
  if (isTenantFailClosed(env)) {
    const err = new Error('tenantId required (fail-closed)')
    err.name = 'ScopeRequiredError'
    throw err
  }
  return 'default'
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const evalDir = path.join(path.resolve(__dirname, '..'), 'eval')
const FILE = 'golden-enterprise-morphology.json'
const MIN_CASES = 8

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const raw = await fs.readFile(path.join(evalDir, FILE), 'utf8')
const obj = JSON.parse(raw)
assert(Array.isArray(obj.cases) && obj.cases.length >= MIN_CASES, `${FILE} need >=${MIN_CASES} cases`)

const report = evaluateCapGoldenFile(obj.cases, FILE)
assert(report.passed === report.total, `cap structural failures in ${FILE}`)

const morphs = new Set(obj.cases.map((c) => String(c.morphology || '')))
for (const required of ['continuation', 'admin', 'hybrid', 'ambiguous', 'tenant_boundary', 'multimodal_collab']) {
  assert(morphs.has(required), `${FILE} missing morphology: ${required}`)
}

// 租户边界：fail-closed 契约（纯函数）
const ent = { AGENT_SECURITY_PROFILE: 'enterprise' } 
assert(isTenantFailClosed(ent), 'enterprise tenant fail-closed')
let threw = false
try {
  requireTenantId(undefined, ent)
} catch (e) {
  threw = e?.name === 'ScopeRequiredError'
}
assert(threw, 'tenant_boundary golden: requireTenantId fail-closed')

const tenantCases = obj.cases.filter((c) => c.expectTenantScope === true)
assert(tenantCases.length >= 2, `${FILE} need >=2 tenant_boundary cases`)

console.log(
  `eval:enterprise-morphology OK — ${report.total} cases, cap_rate=${report.rate}, morphologies=${[...morphs].join(',')}`
)
