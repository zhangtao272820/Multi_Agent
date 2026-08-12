/**
 * 仅同步 Lobster 运行时实际 import 的 shared 模块到 agent-repo-shared/，
 * 避免整包拷贝 ~90 个无关 DB/RAG/Code 等文件。
 *
 * 用法（仓库根或 Lobster_Agent 下）：
 *   node Lobster_Agent/scripts/sync-agent-shared.mjs
 *   npm run sync:shared
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const lobsterRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(lobsterRoot, '..')
const srcDir = path.join(repoRoot, 'shared')
const destDir = path.join(lobsterRoot, 'agent-repo-shared')

const WHITELIST = [
  'extractHttpUrl.ts',
  'lobsterRunVerifyLite.ts',
  'qwenModelKwargs.ts',
  'contentTrust.ts',
  'mcpJsonRpc.ts',
  'lobsterGuiProgressContract.ts',
  'managerTaskEnvelope.ts',
  'nitroClawhiveAuth.ts',
  'clawhiveJwt.ts',
  'evolutionVerifyLobster.ts',
  'agentEvolutionMode.ts',
]

function main() {
  if (!fs.existsSync(srcDir)) {
    console.error(`shared 源目录不存在: ${srcDir}`)
    process.exit(1)
  }
  fs.mkdirSync(destDir, { recursive: true })

  const keep = new Set(WHITELIST)
  for (const name of fs.readdirSync(destDir)) {
    if (!keep.has(name) && name !== '.' && name !== '..') {
      const p = path.join(destDir, name)
      fs.rmSync(p, { recursive: true, force: true })
    }
  }

  for (const name of WHITELIST) {
    const from = path.join(srcDir, name)
    const to = path.join(destDir, name)
    if (!fs.existsSync(from)) {
      console.error(`缺少 shared 文件: ${from}`)
      process.exit(1)
    }
    fs.copyFileSync(from, to)
    console.log(`synced ${name}`)
  }
  console.log(`ok → ${destDir} (${WHITELIST.length} files)`)
}

main()
