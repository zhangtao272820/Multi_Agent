/**
 * 路由 golden 校验：JSON 结构 + 结构性期望（不调用 LLM）。
 * 用法：node scripts/check-eval-route-golden.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRouteCaseStructural } from '../agent-repo-shared/routeStructuralHints.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const evalDir = path.join(root, 'eval')

const ROUTE_FILES = [
  'golden-gui-route.json',
  'golden-route-media.json',
  'golden-route-composite.json',
  'routing-fixtures.json'
]
const COMPOSITE_MIN = Number(process.env.ROUTE_COMPOSITE_MIN ?? '10')
const ROUTING_FIXTURES_MIN = Number(process.env.ROUTING_FIXTURES_MIN ?? '30')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function validateRouteCase(c, file, opts = {}) {
  assert(c && typeof c === 'object', `${file}: case must be object`)
  assert(String(c.id || '').trim(), `${file}: case.id required`)
  assert(String(c.query || '').trim(), `${file}: case.query required for ${c.id}`)
  assert(String(c.expectIntent || '').trim(), `${file}: case.expectIntent required for ${c.id}`)
  if (c.expectAllowedIncludes != null) {
    assert(Array.isArray(c.expectAllowedIncludes), `${file}:${c.id} expectAllowedIncludes must be array`)
  }
  if (c.expectAllowedExcludes != null) {
    assert(Array.isArray(c.expectAllowedExcludes), `${file}:${c.id} expectAllowedExcludes must be array`)
  }
  if (!opts.skipStructuralHints) {
    assertRouteCaseStructural(c)
  }
}

async function validateFile(name) {
  const p = path.join(evalDir, name)
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  assert(raw.trim(), `missing file: ${p}`)
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${name}: invalid JSON — ${e?.message || e}`)
  }
  assert(obj && typeof obj === 'object', `${name}: root must be object`)
  assert(Array.isArray(obj.cases) && obj.cases.length >= 1, `${name}: cases must be non-empty array`)
  const skipStructuralHints = obj.skipStructuralHints === true
  for (const c of obj.cases) validateRouteCase(c, name, { skipStructuralHints })
  return obj.cases.length
}

let total = 0
let compositeCount = 0
let routingFixturesCount = 0
for (const f of ROUTE_FILES) {
  const n = await validateFile(f)
  console.log(`${f} OK: ${n} cases (structural)`)
  total += n
  if (f === 'golden-route-composite.json') compositeCount = n
  if (f === 'routing-fixtures.json') routingFixturesCount = n
}
assert(compositeCount >= COMPOSITE_MIN, `golden-route-composite.json need >=${COMPOSITE_MIN} cases, got ${compositeCount}`)
assert(
  routingFixturesCount >= ROUTING_FIXTURES_MIN,
  `routing-fixtures.json need >=${ROUTING_FIXTURES_MIN} cases, got ${routingFixturesCount}`
)
console.log(
  `eval:route OK — ${total} cases across ${ROUTE_FILES.length} files (composite=${compositeCount}, routing-fixtures=${routingFixturesCount})`
)
