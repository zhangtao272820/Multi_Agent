/**
 * P0-B / P1-A：TaskUnderstand schema · TaskSpec · 引擎链 smoke（网页默认 Stagehand）
 */
import {
  LobsterTaskUnderstandSchema,
  applyLobsterTaskUnderstand,
  toLobsterTaskSpec,
  taskSpecPromptAddon,
  defaultPlanStepsForTask,
  defaultGoalsForTaskKind,
} from '../server/services/lobsterTaskUnderstandSchema'
import {
  taskSpecFromManagerHints,
  mergeManagerAndUnderstoodTaskSpec,
} from '../server/services/lobsterManagerTaskSpec'
import { taskAffirmsSubmit, clampFormFillGoals } from '../server/services/lobsterFormGoals'
import {
  buildEngineChainFromPick,
  reorderChainForTaskSpec,
  resolveEngineFromTaskSpec,
} from '../server/services/lobsterTaskSpec'
import {
  managedBrowserProfileDir,
  resolveBrowserProfile,
} from '../server/services/browserProfiles'
import { selectEngineForTask } from '../server/services/engineSelector'
import { recipePreferredEngine } from '../server/services/siteRecipes'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const parsed = LobsterTaskUnderstandSchema.safeParse({
  canonical_task: '在百度搜索 LangGraph 并打开第一条结果',
  start_url: 'https://www.baidu.com',
  engine_hint: 'stagehand',
  task_kind: 'search',
  browser_profile: 'managed',
  completion_criteria: '打开第一条搜索结果页',
  goals: { must_leave_start: true, must_extract: true, expected_url_change: true },
  plan_steps: [
    { op: 'goto', target: 'https://www.baidu.com', done_when: '首页打开' },
    { op: 'type', target: 'LangGraph', done_when: '结果页' },
    { op: 'click', target: '第一条结果', done_when: '进入详情' },
    { op: 'extract', target: '标题', done_when: '得到标题' },
  ],
  confidence: 0.9,
  rationale: '搜索+点击',
})
assert(parsed.success, 'schema parse v2')

const applied = applyLobsterTaskUnderstand(
  { task: '去百度搜 LangGraph', engineHint: 'auto' },
  parsed.data!,
)
assert(applied.startUrl?.includes('baidu'), 'start_url merged')
assert(applied.engineHint === 'auto', 'caller engineHint preserved (LLM hint soft via TaskSpec)')

const spec = toLobsterTaskSpec(parsed.data!, 'llm', 'managed')
assert(spec.task_kind === 'search', 'task_kind')
assert(spec.browser_profile === 'managed', 'browser_profile')
assert(spec.engine_hint === 'stagehand', 'TaskSpec keeps LLM engine_hint')
assert(spec.plan_steps.length >= 3, 'plan_steps present')
assert(spec.goals.must_leave_start === true, 'goals.must_leave_start')

const addon = taskSpecPromptAddon(spec)
assert(addon.includes('完成标准'), 'taskSpec prompt addon')
assert(addon.includes('计划'), 'taskSpec plan addon')

const picked = resolveEngineFromTaskSpec({
  spec,
  task: spec.canonical_task,
  startUrl: spec.start_url,
  engineHint: applied.engineHint,
  hasStorage: false,
})
assert(picked.engine === 'stagehand', 'engine from taskSpec → stagehand')
assert(picked.source === 'llm', 'LLM pick is soft (not forced)')

let chain = buildEngineChainFromPick(picked)
chain = reorderChainForTaskSpec(chain, spec, true)
assert(chain[0] === 'stagehand', 'search chain starts stagehand')
assert(chain.length === 1 && !chain.includes('classic'), 'soft pick is stagehand-only')

const forcedPick = resolveEngineFromTaskSpec({
  spec,
  task: spec.canonical_task,
  startUrl: spec.start_url,
  engineHint: 'mcp',
  hasStorage: false,
})
assert(forcedPick.source === 'forced', 'API engineHint=mcp is forced')
assert(buildEngineChainFromPick(forcedPick).length === 1, 'forced chain has no fallback')

const formSpec = toLobsterTaskSpec(
  {
    ...parsed.data!,
    task_kind: 'form_fill',
    needs_login: true,
    engine_hint: 'auto',
  },
  'llm',
  'managed',
)
assert(formSpec.engine_hint === 'auto', 'web auto stays soft in TaskSpec')
const formPicked = resolveEngineFromTaskSpec({ spec: formSpec, task: formSpec.canonical_task, hasStorage: true })
let formChain = buildEngineChainFromPick(formPicked)
formChain = reorderChainForTaskSpec(formChain, formSpec, true)
assert(formChain[0] === 'stagehand', 'form_fill + storage → stagehand first')
assert(formPicked.engine === 'stagehand', 'form_fill resolve → stagehand')

const navSpec = toLobsterTaskSpec(
  {
    canonical_task: '打开 https://www.runoob.com/ ，点击第一个教程链接并提取标题',
    start_url: 'https://www.runoob.com/',
    engine_hint: 'auto',
    task_kind: 'navigate',
    browser_profile: 'auto',
    needs_login: false,
    explicitly_avoid_login: false,
    confidence: 0.9,
    rationale: 'C1',
  },
  'llm',
  'managed',
)
assert(navSpec.plan_steps.some((s) => s.op === 'click'), 'navigate default plan has click')
assert(navSpec.goals.must_leave_start === true, 'navigate must leave start')
const navPick = resolveEngineFromTaskSpec({
  spec: navSpec,
  task: navSpec.canonical_task,
  startUrl: navSpec.start_url,
})
assert(navPick.engine === 'stagehand', 'navigate → stagehand')
assert(recipePreferredEngine(navSpec.canonical_task, navSpec.start_url) === 'stagehand', 'runoob recipe stagehand')
assert(selectEngineForTask('随便打开网页点一下') === 'stagehand', 'regex-less default stagehand')

assert(resolveBrowserProfile({ LOBSTER_BROWSER_PROFILE: 'managed' }) === 'managed', 'profile managed')
assert(resolveBrowserProfile({ LOBSTER_BROWSER_PROFILE: 'user' }) === 'user', 'profile user')
assert(managedBrowserProfileDir('test_profile').includes('test_profile'), 'managed dir')

const desktopPicked = resolveEngineFromTaskSpec({
  spec: toLobsterTaskSpec(
    {
      canonical_task: '打开记事本输入 Hello',
      engine_hint: 'desktop',
      task_kind: 'desktop_app',
      target_app: 'Notepad',
      confidence: 0.9,
      rationale: 'desktop',
      needs_login: false,
      explicitly_avoid_login: false,
      browser_profile: 'auto',
    },
    'llm',
    'managed',
  ),
  task: '打开记事本输入 Hello',
  hasStorage: false,
})
assert(desktopPicked.engine === 'desktop', 'desktop_app → desktop engine')

const mgrForm = taskSpecFromManagerHints({
  task: '打开 httpbin 填 Customer name',
  startUrl: 'https://httpbin.org/forms/post',
  taskKind: 'form_fill',
  needsLogin: false,
  successCriteria: 'Customer name 已填入目标值',
  maxInteractionSteps: 3,
})
assert(mgrForm?.task_kind === 'form_fill', 'manager hints form_fill')
assert(mgrForm?.source === 'manager', 'manager source')
assert(mgrForm?.success_criteria === 'Customer name 已填入目标值', 'manager success_criteria')
assert(mgrForm?.max_interaction_steps === 3, 'manager max_interaction_steps')
assert((mgrForm?.plan_steps?.length || 0) >= 1, 'manager form has plan_steps')
const mgrPick = resolveEngineFromTaskSpec({
  spec: mgrForm!,
  task: mgrForm!.canonical_task,
  startUrl: mgrForm!.start_url,
  hasStorage: false,
})
assert(mgrPick.engine === 'stagehand', 'manager form_fill → stagehand soft')
assert(mgrPick.source !== 'forced', 'manager form_fill not forced')
assert(buildEngineChainFromPick(mgrPick).length === 1, 'form_fill chain length 1')

const understoodAsSearch = toLobsterTaskSpec(
  {
    canonical_task: '打开 httpbin 填表',
    engine_hint: 'mcp',
    task_kind: 'search',
    confidence: 0.8,
    rationale: '误判 search',
    needs_login: false,
    explicitly_avoid_login: false,
    browser_profile: 'auto',
    success_criteria: '搜到结果',
  },
  'llm',
  'managed',
)
const merged = mergeManagerAndUnderstoodTaskSpec(mgrForm, understoodAsSearch)
assert(merged?.task_kind === 'form_fill', 'manager priority over misunderstood search')
assert(merged?.engine_hint === 'auto', 'operate merge keeps engine_hint auto')
assert(merged?.start_url === 'https://httpbin.org/forms/post', 'manager start_url kept')
assert(merged?.success_criteria === 'Customer name 已填入目标值', 'manager criteria wins')
assert(merged?.max_interaction_steps === 3, 'manager steps kept')

const mgrCn = taskSpecFromManagerHints({
  task: '打开 w3school 中文站填表',
  startUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
  taskKind: 'form_fill',
})
const undEn = toLobsterTaskSpec(
  {
    canonical_task: '填表',
    start_url: 'https://www.w3schools.com/html/html_forms.asp',
    engine_hint: 'auto',
    task_kind: 'form_fill',
    confidence: 0.9,
    rationale: '幻觉英文站',
    needs_login: false,
    explicitly_avoid_login: false,
    browser_profile: 'auto',
  },
  'llm',
  'managed',
)
const mergedCn = mergeManagerAndUnderstoodTaskSpec(mgrCn, undEn)
assert(
  mergedCn?.start_url === 'https://www.w3school.com.cn/html/html_forms.asp',
  'CN start_url must beat EN hallucination',
)
assert(mergedCn?.goals?.must_leave_start !== true, 'form_fill must not require leave start')
assert(mergedCn?.goals?.must_submit !== true, '不要点 Submit must not set must_submit')

const noSubmitGoals = defaultGoalsForTaskKind(
  'form_fill',
  '打开 https://www.w3school.com.cn/html/html_forms.asp ，First name 填张三，Last name 填李四，不要点 Submit。',
)
assert(noSubmitGoals.must_submit === false, 'defaultGoals: 不要点 Submit → must_submit false')
assert(noSubmitGoals.must_leave_start === false, 'defaultGoals: form_fill no leave')
assert(noSubmitGoals.expected_url_change === false, 'defaultGoals: no url change')

assert(taskAffirmsSubmit('请填写并提交表单') === true, 'affirms submit')
assert(taskAffirmsSubmit('不要点 Submit') === false, 'negates submit')
assert(clampFormFillGoals({ must_leave_start: true, must_submit: true }, '不要点 Submit').must_submit === false)
assert(clampFormFillGoals({ must_leave_start: true, must_submit: true }, '不要点 Submit').must_leave_start === false)

const fallbackPlan = defaultPlanStepsForTask({
  task: '点第一个教程并提取标题',
  startUrl: 'https://www.runoob.com/',
  taskKind: 'extract',
  goals: { must_leave_start: true, must_extract: true },
})
assert(fallbackPlan[0]?.op === 'goto', 'default plan starts goto')
assert(fallbackPlan.some((s) => s.op === 'extract'), 'default plan has extract')

const placeholderSpec = toLobsterTaskSpec(
  {
    canonical_task: '用户要求打开指定网站，点击第一个教程链接，并提取跳转页面的标题',
    start_url: 'https://...',
    engine_hint: 'auto',
    task_kind: 'navigate',
    browser_profile: 'auto',
    needs_login: false,
    explicitly_avoid_login: false,
    confidence: 0.9,
    rationale: 'placeholder must be stripped',
    plan_steps: [
      { op: 'goto', target: 'https://...', done_when: '首页打开' },
      { op: 'click', target: '第一个教程链接', done_when: '进入教程页' },
      { op: 'extract', target: '标题', done_when: '得到标题' },
    ],
  },
  'llm',
  'managed',
)
assert(placeholderSpec.start_url === undefined, 'reject https://... start_url')
assert(
  !placeholderSpec.plan_steps.some((s) => s.op === 'goto' && String(s.target || '').includes('...')),
  'reject placeholder goto target',
)

console.log('smoke-task-understand: PASS (TaskSpec + stagehand default + plan_steps + manager hand)')
