/**
 * 路由 cap golden 结构准确率报告（纯结构，不调 LLM）。
 * 用法：node scripts/check-eval-cap-accuracy.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateCapGoldenFile, MORPHOLOGY_GOLDEN_FILES } from '../agent-repo-shared/evalCapReport.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const evalDir = path.join(path.resolve(__dirname, '..'), 'eval')

const reports = []
for (const file of MORPHOLOGY_GOLDEN_FILES) {
  const raw = await fs.readFile(path.join(evalDir, file), 'utf8')
  const obj = JSON.parse(raw)
  if (!Array.isArray(obj.cases) || obj.cases.length === 0) {
    throw new Error(`${file}: cases[] required`)
  }
  reports.push(evaluateCapGoldenFile(obj.cases, file))
}

const total = reports.reduce((n, r) => n + r.total, 0)
const passed = reports.reduce((n, r) => n + r.passed, 0)
const rate = total ? Math.round((passed / total) * 1000) / 1000 : 1

if (passed !== total) {
  console.error('eval:cap-accuracy FAIL', { total, passed, rate, reports })
  process.exit(1)
}

console.log(
  `eval:cap-accuracy OK — total=${total} passed=${passed} rate=${rate} files=${reports.map((r) => r.file).join(',')}`
)
