/**
 * 一步合并 shared：Manager_Agent/shared → repo shared/；shared-pkg → agent-repo-shared
 * Usage: node scripts/tools/consolidate-shared.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const repoShared = path.resolve(root, '../shared')
const localShared = path.join(root, 'shared')
const agentRepoShared = path.join(root, 'agent-repo-shared')

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      walk(p, out)
    } else if (/\.(ts|vue|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

// 1) 迁入 repo shared（重名跳过，以 repo 为准）
if (fs.existsSync(localShared)) {
  for (const f of fs.readdirSync(localShared)) {
    if (!f.endsWith('.ts') && !f.endsWith('.mjs')) continue
    const src = path.join(localShared, f)
    const dest = path.join(repoShared, f)
    if (fs.existsSync(dest)) {
      console.log('skip duplicate:', f)
      continue
    }
    fs.copyFileSync(src, dest)
    console.log('moved to repo shared:', f)
  }
  fs.rmSync(localShared, { recursive: true, force: true })
  console.log('removed Manager_Agent/shared/')
}

// 2) agent-repo-shared：物理拷贝 repo shared（与 Dockerfile COPY 一致，保证 ../server 相对路径可用）
if (fs.existsSync(agentRepoShared)) {
  fs.rmSync(agentRepoShared, { recursive: true, force: true })
}
if (fs.existsSync(path.join(root, 'shared-pkg'))) {
  fs.rmSync(path.join(root, 'shared-pkg'), { recursive: true, force: true })
}
fs.cpSync(repoShared, agentRepoShared, { recursive: true })
console.log('copied: ../shared -> agent-repo-shared/')

// 3) 批量改 import（跳过 core/shared 域内 llmJson/modelTier/llmSpeed）
const files = walk(path.join(root, 'server')).concat(walk(path.join(root, 'app')), walk(path.join(root, 'scripts/smoke')))
let changed = 0
for (const file of files) {
  let raw = fs.readFileSync(file, 'utf8')
  let next = raw
  next = next.replace(/from (['"])(?:\.\.\/)+shared\/(?!llmJson|modelTier|llmSpeed|promptBudget|policy|payload|media|index)([^'"]+?)(?:\.ts)?\1/g, "from $1#agent-shared/$2$1")
  next = next.replace(/from (['"])#shared\/([^'"]+)\1/g, "from $1#agent-shared/$2$1")
  next = next.replace(/import\((['"])(?:\.\.\/)+shared\/(?!llmJson|modelTier|llmSpeed|promptBudget|policy|payload|media|index)([^'"]+?)(?:\.ts)?\1\)/g, "import($1#agent-shared/$2$1)")
  if (next !== raw) {
    fs.writeFileSync(file, next, 'utf8')
    changed++
    console.log('import:', path.relative(root, file))
  }
}

console.log(`Done consolidate-shared: importFiles=${changed}`)
