/**
 * E4：扩展门禁 — CodePy 离线 smoke + Extractor gate 脚本存在 + Lobster regression 入口。
 * 不跑浏览器在线；结构/脚本存在 + 契约 smoke。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(managerRoot, '..')
const codePyRoot = path.join(repoRoot, 'CodePy_Agent')

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`gate-e4: missing ${label}: ${p}`)
    process.exit(1)
  }
}

mustExist(path.join(codePyRoot, 'scripts/smoke_protocol.py'), 'CodePy smoke_protocol')
mustExist(path.join(codePyRoot, 'scripts/smoke_fs.py'), 'CodePy smoke_fs')
mustExist(path.join(codePyRoot, 'scripts/smoke_compute.py'), 'CodePy smoke_compute')
mustExist(path.join(managerRoot, 'scripts/smoke/protocol/smoke-code-edit-hitl.ts'), 'code edit HITL smoke')
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
  ['smoke:ws-stream-order', 'G6'],
  ['smoke:code-edit-hitl', 'CodeEditHITL']
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

function runPythonSmoke(scriptRel, label) {
  const scriptPath = path.join(codePyRoot, scriptRel)
  const pyCandidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  let last = null
  for (const py of pyCandidates) {
    const r = spawnSync(py, [scriptPath], {
      cwd: codePyRoot,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, PYTHONUTF8: '1' }
    })
    last = r
    if (r.error && r.error.code === 'ENOENT') continue
    if (r.status === 0) {
      console.log(`gate-e4: ${label} ok`)
      return
    }
    console.error(r.stdout || '')
    console.error(r.stderr || '')
    console.error(`gate-e4: ${label} failed (${py} ${scriptRel})`)
    process.exit(r.status || 1)
  }
  console.error(last?.error || 'python not found')
  console.error(`gate-e4: ${label} failed (no python)`)
  process.exit(1)
}

runPythonSmoke('scripts/smoke_protocol.py', 'CodePy protocol')
runPythonSmoke('scripts/smoke_fs.py', 'CodePy fs')
runPythonSmoke('scripts/smoke_compute.py', 'CodePy compute')

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
