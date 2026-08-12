/**
 * Wave7：生产 prompt/packs/编排源码禁写评测 fixture 专名。
 * CI：npm run smoke:fixture-bleed
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleOrchestratorSystemPrompt } from '../../../server/graph/llm/orchestratorPromptProfiles'
import {
  DOMAIN_BLEED_DENY_LIST,
  assertNoDomainBleed,
  findDomainBleedInText
} from '../fixtures/domainBleedDenyList'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const managerRoot = path.resolve(__dirname, '../../..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-fixture-bleed] ${msg}`)
}

/** 仅扫生产契约面；doc/ 与 scripts/smoke 允许出现 fixture */
const SCAN_GLOBS_ROOTS = [
  path.join(managerRoot, 'server/graph/llm'),
  path.join(managerRoot, 'server/graph/orchestrate'),
  path.join(managerRoot, 'server/graph/core/routing'),
  path.join(managerRoot, 'server/graph/core/probe')
]

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'dist') continue
        walk(p)
      } else if (/\.(ts|mts|js)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) {
        out.push(p)
      }
    }
  }
  walk(dir)
  return out
}

console.log('smoke-fixture-bleed: start')
assert(DOMAIN_BLEED_DENY_LIST.length >= 8, 'deny list populated')

// 组装后的冷/热 prompt
const cold = assembleOrchestratorSystemPrompt({})
assertNoDomainBleed(cold, 'assembleOrchestratorSystemPrompt:cold')
const warmDb = assembleOrchestratorSystemPrompt({ probeDbRelevant: true, probeRagHits: false })
assertNoDomainBleed(warmDb, 'assembleOrchestratorSystemPrompt:db')
const warmRag = assembleOrchestratorSystemPrompt({ probeDbRelevant: false, probeRagHits: true })
assertNoDomainBleed(warmRag, 'assembleOrchestratorSystemPrompt:rag')
const warmMulti = assembleOrchestratorSystemPrompt({
  probeDbRelevant: true,
  probeRagHits: true,
  sessionIsMulti: true
})
assertNoDomainBleed(warmMulti, 'assembleOrchestratorSystemPrompt:multi')

const allHits: ReturnType<typeof findDomainBleedInText> = []
for (const root of SCAN_GLOBS_ROOTS) {
  for (const file of listTsFiles(root)) {
    const rel = path.relative(managerRoot, file).replace(/\\/g, '/')
    const text = fs.readFileSync(file, 'utf8')
    allHits.push(...findDomainBleedInText(text, rel))
  }
}

if (allHits.length) {
  const sample = allHits
    .slice(0, 12)
    .map((h) => `${h.term} in ${h.where}`)
    .join('\n  ')
  throw new Error(`[smoke-fixture-bleed] production source bleed (${allHits.length}):\n  ${sample}`)
}

console.log(
  `smoke-fixture-bleed: ok (deny=${DOMAIN_BLEED_DENY_LIST.length}, scanned_roots=${SCAN_GLOBS_ROOTS.length})`
)
