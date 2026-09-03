/**
 * P2-1 DB catalog / 换库边界 golden 结构校验（不调 LLM）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateCapGoldenFile } from '../agent-repo-shared/evalCapReport.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE = 'golden-db-catalog-boundary.json'

const raw = await fs.readFile(path.join(path.resolve(__dirname, '..'), 'eval', FILE), 'utf8')
const obj = JSON.parse(raw)
const cases = Array.isArray(obj.cases) ? obj.cases : []
if (cases.length < 4) throw new Error(`${FILE} need >=4 cases`)

const capCases = cases.map((c) => ({
  id: c.id,
  user: c.user,
  expectCap: c.expectCap,
  expectClarify: c.expectClarify
}))
const report = evaluateCapGoldenFile(capCases, FILE)
if (report.passed !== report.total) throw new Error(`cap structural failures in ${FILE}`)

for (const c of cases) {
  const dbId = String(c.dbId || '').trim()
  if (!dbId) throw new Error(`${c.id}: dbId required`)
  if (c.boundary === 'no_cross_db_join' && !c.expectClarify) {
    throw new Error(`${c.id}: cross-db boundary must expectClarify`)
  }
}

console.log(`eval:db-catalog OK — ${report.total} cases`)
