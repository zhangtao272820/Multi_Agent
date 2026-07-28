/**
 * N4 门禁：路由 golden + RAG 离线题集；RAG 可达时可选跑 eval:rag:ci
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const managerRoot = path.resolve(__dirname, '..')
const ragRoot = path.resolve(managerRoot, '../RAG_Agent')

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false, env: process.env })
  if (r.status !== 0) {
    process.exit(r.status || 1)
  }
}

console.log('[gate:n4] Manager eval:route (incl. composite ≥10)')
run(process.execPath, ['scripts/check-eval-route-golden.mjs'], managerRoot)

console.log('[gate:n4] RAG offline question-set gate (≥20)')
run(process.execPath, ['scripts/gate-rag-eval-offline.mjs'], ragRoot)

const dbRoot = path.resolve(managerRoot, '../DB_Agent')
console.log('[gate:n4] DB NL2SQL golden gate (≥20)')
run(process.execPath, ['scripts/gate-db-nl2sql-offline.mjs'], dbRoot)

const tryLive = process.env.RAG_EVAL_LIVE === '1' || process.argv.includes('--live')
if (tryLive) {
  const base = process.env.RAG_EVAL_URL || 'http://localhost:13102'
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal }).catch(() => null)
    clearTimeout(t)
    if (res && res.ok) {
      console.log('[gate:n4] RAG live → eval:rag:ci')
      run(process.execPath, ['scripts/rag-eval.mjs', '--ci'], ragRoot)
    } else {
      console.log(`[gate:n4] RAG not reachable at ${base}, skip live eval`)
    }
  } catch {
    console.log('[gate:n4] RAG live probe failed, skip live eval')
  }
} else {
  console.log('[gate:n4] skip live rag-eval (set RAG_EVAL_LIVE=1 or --live to enable)')
}

console.log('gate:n4 OK')
