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

// --- S2.L1 AVR 加厚：登录墙 / 列表 / 表单（离线 fixture）---

const formDefaults = assembleDefaultSuccessCriteria({
  taskKind: 'form_fill',
  goals: { must_leave_start: false, must_extract: false },
  startUrl: 'https://httpbin.org/forms/post',
})
assert(formDefaults.filledMin === 1, 'form_fill uses filledMin')
assert(formDefaults.extractMin == null, 'form_fill no extractMin')

const formPass = evaluateSuccessCriteria({
  url: 'https://httpbin.org/forms/post',
  filledCount: 3,
  extractCount: 0,
  criteria: { filledMin: 2 },
})
assert(formPass.ok, 'form filledCount meets filledMin')

const formFail = evaluateSuccessCriteria({
  url: 'https://httpbin.org/forms/post',
  filledCount: 0,
  title: 'httpbin forms',
  extractCount: 1,
  criteria: { filledMin: 1 },
})
assert(!formFail.ok, 'form without filled evidence fails even if extract present')

const listPass = evaluateSuccessCriteria({
  url: 'https://example.com/orders?page=2',
  extractCount: 5,
  criteria: {
    urlIncludes: ['/orders'],
    selectorPresent: '.order-list',
    extractMin: 1,
  },
  selectorHits: 1,
})
assert(listPass.ok, 'list page with selector + extracts passes')

const listStuck = evaluateSuccessCriteria({
  url: 'https://example.com/',
  extractCount: 0,
  criteria: { urlIncludes: ['/orders'], extractMin: 1 },
})
assert(!listStuck.ok, 'list task stuck on home fails')

const loginWallResolved = resolveStructuredSuccessCriteria({
  task: '打开门户查订单列表',
  startUrl: 'https://portal.example.com/login',
  taskSpec: {
    canonical_task: '打开门户查订单列表',
    start_url: 'https://portal.example.com/login',
    engine_hint: 'stagehand',
    task_kind: 'navigate',
    browser_profile: 'managed',
    needs_login: true,
    explicitly_avoid_login: false,
    plan_steps: [],
    goals: { must_leave_start: true, must_extract: true, expected_url_change: true },
    confidence: 0.85,
    rationale: 'smoke login wall',
    source: 'fallback',
    success_criteria: JSON.stringify({ urlIncludes: ['/orders'], extractMin: 1 }),
  },
})
assert(loginWallResolved.extractMin === 1, 'login-wall task still requires extract after leave login')
const stillOnLogin = evaluateSuccessCriteria({
  url: 'https://portal.example.com/login',
  extractCount: 0,
  title: '请先登录',
  criteria: loginWallResolved,
})
assert(!stillOnLogin.ok, 'still on login page fails success criteria')

console.log('smoke-success-criteria: PASS')
