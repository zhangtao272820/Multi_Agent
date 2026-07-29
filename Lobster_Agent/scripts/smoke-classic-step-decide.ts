/**
 * P3-L1 / P3-L4：classicStepDecide schema · 结果页门禁 · lean extract 短路
 */
import {
  ClassicStepDecideSchema,
  isClassicStepDecideEnabled,
  isClassicGoalsHeuristicEnabled,
  isResultPageGateEnabled,
} from '../server/services/classicStepDecideSchema'
import {
  gateStepByResultPage,
  gateDoneByEnterDetail,
  maybeLeanExtractShortcut,
  maybeLeanOpenDoneShortcut,
  toIntentCall,
} from '../server/services/classicStepDecidePure'
import {
  mergeSuccessCriteria,
  evaluateSuccessCriteria,
  isOnResultPage,
} from '../server/services/lobsterSuccessCriteria'
import { recipeResultPageHints } from '../server/services/siteRecipes'
import { buildPendingEngagementSeq } from '../server/services/lobsterAgent/verify'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

// --- schema ---
const ok = ClassicStepDecideSchema.safeParse({
  intent: 'search',
  args: { query: 'Python 教程' },
  reason: '先搜',
  expect: { urlIncludes: ['wd='], stageHint: 'list' },
  confidence: 0.88,
})
assert(ok.success, 'step decide schema')

const bad = ClassicStepDecideSchema.safeParse({ intent: 'hack_the_planet', confidence: 0.9 })
assert(!bad.success, 'reject unknown intent')

// --- result page gate ---
assert(isResultPageGateEnabled({ LOBSTER_RESULT_PAGE_GATE: '1' } as any), 'gate on')
const blocked = gateStepByResultPage(
  {
    intent: 'open_first_result',
    reason: '乱点',
    confidence: 0.9,
  },
  { url: 'https://www.baidu.com/', title: '百度', stageHint: 'home', candidatesTopK: [] },
  { mustSearch: true, searchQuery: 'LangGraph' },
)
assert(blocked?.intent === 'search', 'gate rewrites open_first → search')
assert(String((blocked as any)?.args?.query || '').includes('LangGraph'), 'gate keeps query')

const allowed = gateStepByResultPage(
  { intent: 'open_first_result', reason: 'ok', confidence: 0.9 },
  { url: 'https://www.baidu.com/s?wd=LangGraph', title: '搜索', stageHint: 'list', candidatesTopK: [] },
  { mustSearch: true, searchQuery: 'LangGraph' },
)
assert(allowed?.intent === 'open_first_result', 'on results allows open_first')

const detailDone = gateStepByResultPage(
  { intent: 'open_first_result', reason: 'already there', confidence: 0.9 },
  {
    url: 'https://mp.weixin.qq.com/s/abc123',
    title: 'Python入门教程',
    stageHint: 'detail',
    candidatesTopK: [],
  },
  { mustSearch: true, mustEnterDetail: true, searchQuery: 'Python' },
)
assert(detailDone?.intent === 'done', 'detail page open_first → done not search')

const openShort = maybeLeanOpenDoneShortcut({
  observation: {
    url: 'https://mp.weixin.qq.com/s/xyz',
    title: '神仙级Python入门教程',
    stageHint: 'detail',
    candidatesTopK: [],
    pageTextSnippet: '正文…',
  },
  task: '打开百度搜索 Python 教程，点第一条，把标题和链接告诉我',
  goals: { mustSearch: true, mustEnterDetail: true },
})
assert(openShort?.intent === 'done', 'lean open done on weixin')

// 站点首页 ≠ 详情：runoob 起始页禁止 lean done / gate 须改写 done
const runoobHome = {
  url: 'https://www.runoob.com/',
  title: '菜鸟教程',
  stageHint: 'home',
  candidatesTopK: [{ i: 0, label: 'HTML' }, { i: 1, label: 'CSS' }],
  pageTextSnippet: '学的不仅是技术，更是梦想',
}
const noLeanOnHome = maybeLeanOpenDoneShortcut({
  observation: runoobHome,
  task: '打开 https://www.runoob.com/ ，点击第一个教程链接并提取标题',
  goals: { mustEnterDetail: true, mustExtract: true, extractLimit: 1 },
  startUrl: 'https://www.runoob.com/',
})
assert(!noLeanOnHome, 'lean must not done on site homepage')

const gatedHomeDone = gateDoneByEnterDetail(
  { intent: 'done', reason: '假完成', confidence: 0.93 },
  runoobHome,
  { mustEnterDetail: true },
  'https://www.runoob.com/',
)
assert(gatedHomeDone.intent === 'open_first_result', 'gate done→open_first on homepage')

const gatedDetailOk = gateDoneByEnterDetail(
  { intent: 'done', reason: '真完成', confidence: 0.93 },
  {
    url: 'https://www.runoob.com/html/html-tutorial.html',
    title: 'HTML 教程',
    stageHint: 'detail',
    candidatesTopK: [],
  },
  { mustEnterDetail: true },
  'https://www.runoob.com/',
)
assert(gatedDetailOk.intent === 'done', 'gate allows done after leave start')

// --- lean extract shortcut ---
const lean = maybeLeanExtractShortcut({
  observation: {
    url: 'https://www.baidu.com/s?wd=Python',
    title: '百度一下',
    stageHint: 'list',
    candidatesTopK: [
      { i: 0, label: 'r1' },
      { i: 1, label: 'r2' },
      { i: 2, label: 'r3' },
    ],
  },
  goals: { mustExtract: true, extractLimit: 1, mustEnterDetail: false },
})
assert(lean?.intent === 'extract_items', 'lean extract on results')
assert(toIntentCall(lean!).intent === 'extract_items', 'toIntentCall')

const noLean = maybeLeanExtractShortcut({
  observation: {
    url: 'https://www.baidu.com/',
    title: '百度',
    stageHint: 'home',
    candidatesTopK: [{ i: 0 }, { i: 1 }],
  },
  goals: { mustExtract: true },
})
assert(!noLean, 'no lean on homepage')

// --- successCriteria + recipe hints ---
const hints = recipeResultPageHints('去百度搜 x', 'https://www.baidu.com')
assert(hints?.listSelector === '#content_left', 'baidu resultPageHints')
const criteria = mergeSuccessCriteria({ urlIncludes: ['wd='] }, hints)
assert(isOnResultPage('https://www.baidu.com/s?wd=x', criteria, hints), 'on result page')
const ev = evaluateSuccessCriteria({
  url: 'https://news.baidu.com/',
  criteria: { urlIncludes: ['wd=', '/s?'] },
})
assert(!ev.ok, 'news channel fails criteria')

// --- env defaults ---
assert(isClassicStepDecideEnabled({ LOBSTER_CLASSIC_STEP_DECIDE: '1' } as any), 'step decide default on')
assert(!isClassicGoalsHeuristicEnabled({ LOBSTER_CLASSIC_GOALS_HEURISTIC: '0' } as any), 'heuristic default off')

// --- engagement：heuristic=0 时禁止用户原话 regex 灌 forced 互动 ---
const clip = (seq: any[]) => seq
const prevH = process.env.LOBSTER_CLASSIC_GOALS_HEURISTIC
process.env.LOBSTER_CLASSIC_GOALS_HEURISTIC = '0'
const noRegexEngage = buildPendingEngagementSeq(
  { task: '打开B站点赞投币关注收藏', taskSpec: { wantedInteractionOps: [] } },
  new Set(),
  new Set(['like', 'coin', 'follow', 'favorite']),
  clip,
)
assert(noRegexEngage.length === 0, 'heuristic off: no regex engagement forcedIntents')
const fromWanted = buildPendingEngagementSeq(
  { task: '随便', taskSpec: { wantedInteractionOps: ['like', 'coin'] } },
  new Set(),
  new Set(['like', 'coin', 'follow', 'favorite']),
  clip,
)
assert(fromWanted.map((x: any) => x.intent).join(',') === 'like,coin', 'wantedInteractionOps drives engagement')
process.env.LOBSTER_CLASSIC_GOALS_HEURISTIC = '1'
const legacyRegex = buildPendingEngagementSeq(
  { task: '打开B站视频并点赞', taskSpec: { wantedInteractionOps: [] } },
  new Set(),
  new Set(['like']),
  clip,
)
assert(legacyRegex.some((x: any) => x.intent === 'like'), 'heuristic on: legacy regex ok')
if (prevH === undefined) delete process.env.LOBSTER_CLASSIC_GOALS_HEURISTIC
else process.env.LOBSTER_CLASSIC_GOALS_HEURISTIC = prevH

console.log('smoke-classic-step-decide: PASS')
