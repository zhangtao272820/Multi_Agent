/**
 * 面试 Eval 打包门禁：路由 fixture + RAG 题集 schema + MCP tool schema（不调 LLM / 不连专家）。
 * 用法：cd Manager_Agent && npm run eval:interview
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const managerRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(managerRoot, '..')

function run(label, cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status ?? 'unknown'})`)
  }
}

console.log('eval:interview — route golden')
run('eval:route', process.execPath, ['scripts/check-eval-route-golden.mjs'], managerRoot)

console.log('eval:interview — rag-eval offline gate')
run('gate:rag-eval', process.execPath, ['scripts/gate-rag-eval-offline.mjs'], path.join(repoRoot, 'RAG_Agent'))

console.log('eval:interview — mcp tool schemas')
run('mcp:smoke-schema', process.execPath, ['scripts/smoke-tool-schemas.mjs'], path.join(repoRoot, 'mcp-servers'))

console.log('eval:interview OK')
