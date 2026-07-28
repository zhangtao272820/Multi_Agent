/**
 * E4：Code 离线门禁 — 结构断言（error_code / metrics 形状 / dual smoke 脚本存在）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const scripts = pkg.scripts || {}
if (!scripts['smoke:code-dual']) {
  console.error('gate-code-offline: missing smoke:code-dual')
  process.exit(1)
}
const ar = fs.readFileSync(path.join(root, 'server/utils/agent_result.ts'), 'utf8')
for (const needle of ['error_code', 'CodeErrorCode', 'tool_round_limit']) {
  if (!ar.includes(needle)) {
    console.error(`gate-code-offline: agent_result missing ${needle}`)
    process.exit(1)
  }
}
const metrics = fs.readFileSync(path.join(root, 'server/api/metrics.get.ts'), 'utf8')
if (!metrics.includes('sli') || !metrics.includes('capabilityAudit')) {
  console.error('gate-code-offline: metrics.get missing sli/capabilityAudit')
  process.exit(1)
}
const prom = path.join(root, 'server/api/metrics/prometheus.get.ts')
if (!fs.existsSync(prom)) {
  console.error('gate-code-offline: missing prometheus.get.ts')
  process.exit(1)
}
console.log('gate-code-offline: ok')
