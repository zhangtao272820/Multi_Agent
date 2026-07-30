/**
 * Prompt 卫生 lint（§12.6 PB-4）：扫描 runtime prompt/playbook，拒绝 golden 专名泄漏。
 * 用法：npx tsx scripts/lint-prompt-hygiene.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const denylist: string[] = JSON.parse(
  readFileSync(join(root, 'shared/promptHygieneDenylist.json'), 'utf8'),
)

const SCAN_DIRS = [
  'DB_Agent/utils/nlu',
  'Manager_Agent/server/utils',
  'Manager_Agent/server/graph/llm',
  'Manager_Agent/skills',
  'RAG_Agent/server/utils',
  'AI_admin_Agent/backend/app/core',
  'Lobster_Agent/server/services',
  'shared',
]

const SKIP_PARTS = [
  '/eval/',
  '/scripts/smoke',
  '/doc/',
  'data/domains/',
  'promptHygieneDenylist.json',
  '真实域路由',
  'route-matrix',
  'RouteMatrixVerify',
  'routeMatrixVerify',
  '/skills/manager_',
]

const FILE_RE = /\.(ts|py|md)$/
const PROMPT_HINT =
  /playbook|prompt|FALLBACK|QUERY_PLAN|_PROMPT|skill\.md|orchestrat|intentPlaybook|UNDERSTAND_SYSTEM|STEP_DECIDE_SYSTEM|_SYSTEM\s*=/i

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = relative(root, p).replace(/\\/g, '/')
    if (SKIP_PARTS.some((s) => rel.includes(s))) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (FILE_RE.test(name)) out.push(p)
  }
  return out
}

const violations: string[] = []

for (const dir of SCAN_DIRS) {
  const abs = join(root, dir)
  try {
    for (const file of walk(abs)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      const text = readFileSync(file, 'utf8')
      if (!PROMPT_HINT.test(rel) && !PROMPT_HINT.test(text.slice(0, 800))) continue
      for (const token of denylist) {
        if (token.length < 3) continue
        if (text.includes(token)) {
          violations.push(`${rel}: contains golden token "${token}"`)
        }
      }
    }
  } catch {
    // dir missing in partial checkout
  }
}

if (violations.length) {
  console.error('lint-prompt-hygiene: FAIL')
  for (const v of violations) console.error('  -', v)
  process.exit(1)
}

console.log('lint-prompt-hygiene: OK', { tokens: denylist.length, scannedRoots: SCAN_DIRS.length })
