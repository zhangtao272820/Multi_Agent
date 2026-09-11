/** 修正 consolidate 误把 core/shared 模块指到 agent-repo-shared 的 import */
import fs from 'node:fs'
import path from 'node:path'

const coreDir = path.join(process.cwd(), 'server/graph/core')
const MAP = [
  ["from '#agent-shared/llmJson'", "from '../shared/llmJson'"],
  ["import('#agent-shared/llmJson')", "import('../shared/llmJson')"],
  ["from '#agent-shared/modelTier'", "from '../shared/modelTier'"],
  ["from '#agent-shared/llmSpeed'", "from '../shared/llmSpeed'"],
  ["from '#agent-shared/promptBudget'", "from '../shared/promptBudget'"],
  ["from '#agent-shared/policy'", "from '../shared/policy'"],
  ["from '#agent-shared/payload'", "from '../shared/payload'"],
  ["from '#agent-shared/media'", "from '../shared/media'"]
]

let n = 0
for (const dir of fs.readdirSync(coreDir)) {
  const d = path.join(coreDir, dir)
  if (!fs.statSync(d).isDirectory()) continue
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.ts')) continue
    const p = path.join(d, f)
    let raw = fs.readFileSync(p, 'utf8')
    let next = raw
    for (const [a, b] of MAP) next = next.split(a).join(b)
    if (next !== raw) {
      fs.writeFileSync(p, next, 'utf8')
      n++
      console.log('fixed:', path.relative(process.cwd(), p))
    }
  }
}
console.log(`fixed core imports: ${n}`)
