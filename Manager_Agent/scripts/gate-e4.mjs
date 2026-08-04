/**
 * E4：扩展门禁 — Code 结构 + Extractor gate 脚本存在 + Lobster regression 入口。
 * 不跑浏览器在线；结构/脚本存在即过。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(managerRoot, '..')

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`gate-e4: missing ${label}: ${p}`)
    process.exit(1)
  }
}

mustExist(path.join(repoRoot, 'code_assistent_Agent/scripts/gate-code-offline.mjs'), 'code gate')
mustExist(path.join(repoRoot, 'Extractor_Agent/package.json'), 'extractor pkg')
mustExist(path.join(repoRoot, 'Lobster_Agent/scripts/regression-smoke.mjs'), 'lobster regression')
mustExist(path.join(repoRoot, 'Lobster_Agent/scripts/smoke-agent-result-trust.ts'), 'lobster J3 agent-result trust')
mustExist(path.join(repoRoot, 'Lobster_Agent/server/api/metrics/prometheus.get.ts'), 'lobster prom')
mustExist(path.join(repoRoot, 'DB_Agent/scripts/smoke-error-code-contract.ts'), 'db J1 error_code contract')
mustExist(path.join(repoRoot, 'AI_admin_Agent/backend/scripts/smoke_admin_risky_hitl.py'), 'admin J2 risky HITL')
mustExist(path.join(repoRoot, 'Extractor_Agent/server/api/metrics/prometheus.get.ts'), 'extractor prom')
mustExist(path.join(managerRoot, 'scripts/smoke/misc/smoke-agent-result-contract.ts'), 'G1 contract smoke')
mustExist(path.join(managerRoot, 'scripts/smoke/misc/smoke-backpressure.ts'), 'G2 backpressure smoke')
mustExist(path.join(managerRoot, 'scripts/smoke/misc/smoke-redact.ts'), 'G3 redact smoke')
mustExist(path.join(managerRoot, 'scripts/smoke/misc/smoke-latency-baseline.ts'), 'G4 latency smoke')
mustExist(path.join(managerRoot, 'scripts/smoke/misc/smoke-ws-stream-order.ts'), 'G6 stream smoke')
mustExist(path.join(managerRoot, 'scripts/smoke/misc/smoke-evidence-freshness.ts'), 'G5 freshness smoke')

const gSmokes = [
  ['smoke:agent-result-contract', 'G1'],
  ['smoke:backpressure', 'G2'],
  ['smoke:redact', 'G3'],
  ['smoke:latency-baseline', 'G4'],
  ['smoke:evidence-freshness', 'G5'],
  ['smoke:ws-stream-order', 'G6']
]
for (const [script, label] of gSmokes) {
  const r = spawnSync('npm', ['run', script], {
    cwd: managerRoot,
    encoding: 'utf8',
    shell: true
  })
  if (r.status !== 0) {
    console.error(r.stdout || '')
    console.error(r.stderr || '')
    console.error(`gate-e4: ${label} smoke failed (${script})`)
    process.exit(r.status || 1)
  }
}

const codeGate = spawnSync(process.execPath, ['scripts/gate-code-offline.mjs'], {
  cwd: path.join(repoRoot, 'code_assistent_Agent'),
  encoding: 'utf8',
  shell: false
})
if (codeGate.status !== 0) {
  console.error(codeGate.stdout || '')
  console.error(codeGate.stderr || '')
  console.error('gate-e4: code offline gate failed')
  process.exit(codeGate.status || 1)
}

const extPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'Extractor_Agent/package.json'), 'utf8'))
if (!extPkg.scripts?.['eval:extractor:gate']) {
  console.error('gate-e4: Extractor missing eval:extractor:gate')
  process.exit(1)
}

const lobPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'Lobster_Agent/package.json'), 'utf8'))
if (!lobPkg.scripts?.['regression:smoke']) {
  console.error('gate-e4: Lobster missing regression:smoke')
  process.exit(1)
}

console.log('gate-e4: ok')
