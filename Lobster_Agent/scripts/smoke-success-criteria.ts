/**
 * P3-L2：successCriteria / resultPageHints 纯函数 smoke
 */
import {
  SuccessCriteriaSchema,
  mergeSuccessCriteria,
  evaluateSuccessCriteria,
  isOnResultPage,
  resultPageHintsFor,
  assembleDefaultSuccessCriteria,
  resolveStructuredSuccessCriteria,
  normalizeWebFailureCode,
} from '../server/services/lobsterSuccessCriteria'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const parsed = SuccessCriteriaSchema.safeParse({
  urlIncludes: ['/s?', 'wd='],
  selectorPresent: '#content_left',
  extractMin: 1,
})
assert(parsed.success, 'successCriteria schema')

const merged = mergeSuccessCriteria(
  { extractMin: 1 },
  resultPageHintsFor('打开百度搜 Python', 'https://www.baidu.com'),
)
assert(merged.urlIncludes?.some((x) => x.includes('wd') || x.includes('/s')), 'merge urlIncludes')
assert(merged.selectorPresent === '#content_left' || merged.selectorPresent?.includes('content_left'), 'merge selector')

assert(isOnResultPage('https://www.baidu.com/s?wd=Python'), 'baidu /s')
assert(!isOnResultPage('https://news.baidu.com/'), 'not news home')

const pass = evaluateSuccessCriteria({
  url: 'https://www.baidu.com/s?wd=Py',
  extractCount: 2,
  criteria: merged,
})
assert(pass.ok, 'criteria pass on results + extract')

const fail = evaluateSuccessCriteria({
  url: 'https://www.baidu.com/',
  extractCount: 0,
  criteria: { urlIncludes: ['wd='], extractMin: 1 },
})
assert(!fail.ok, 'criteria fail on home')

const defaults = assembleDefaultSuccessCriteria({
  taskKind: 'navigate',
  goals: { must_leave_start: true, must_extract: true, expected_url_change: true },
  startUrl: 'https://www.runoob.com/',
})
assert(defaults.extractMin === 1, 'default extractMin for navigate')

const resolved = resolveStructuredSuccessCriteria({
  task: '打开菜鸟教程首页，点击第一个教程并提取标题',
  startUrl: 'https://www.runoob.com/',
  taskSpec: {
    canonical_task: '打开菜鸟教程首页，点击第一个教程并提取标题',
    start_url: 'https://www.runoob.com/',
    engine_hint: 'stagehand',
    task_kind: 'navigate',
    browser_profile: 'managed',
    needs_login: false,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: { must_leave_start: true, must_extract: true, expected_url_change: true },
    confidence: 0.9,
    rationale: 'smoke',
    source: 'fallback',
  },
})
assert(resolved.extractMin === 1, 'resolved extractMin')

const unmet = evaluateSuccessCriteria({
  url: 'https://www.runoob.com/',
  title: '',
  extractCount: 0,
  criteria: resolved,
})
assert(!unmet.ok, 'empty extract fails criteria')
assert(normalizeWebFailureCode(unmet.reason) === 'success_criteria_unmet', 'normalize unmet')
assert(normalizeWebFailureCode('network_unreachable') === 'network', 'normalize network')
assert(normalizeWebFailureCode('incomplete_max_steps') === 'step_budget_exceeded', 'normalize budget')
assert(normalizeWebFailureCode('no_candidates') === 'element_not_found', 'normalize element')

console.log('smoke-success-criteria: PASS')
