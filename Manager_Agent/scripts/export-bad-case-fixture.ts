/**
 * 在线坏例 → eval fixture 导出 CLI（读 fixture 文件，stdout JSON；须人工审核后入库）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportBadCasesToEvalFixture } from '../agent-repo-shared/badCaseFixtureExport'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultFixture = path.join(__dirname, '..', 'eval', 'fixtures', 'bad-case-sample.json')

const inputPath = process.argv[2] || defaultFixture
const raw = await fs.readFile(inputPath, 'utf8')
const rows = JSON.parse(raw) as unknown
if (!Array.isArray(rows)) throw new Error('input must be JSON array of BadCaseRow')

const out = exportBadCasesToEvalFixture(rows, { topN: 10, maxScore: 0.5 })
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
