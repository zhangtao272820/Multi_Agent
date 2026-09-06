/**
 * GUI workflow 白名单：未知宏丢弃；已知 httpbin-form-fill 保留
 */
import assert from 'node:assert/strict'
import {
  BUILTIN_GUI_WORKFLOW_IDS,
  enrichBilibiliGuestWorkflowArgs,
  isKnownGuiWorkflowId,
  listKnownGuiWorkflowIds,
  listMissingGuiWorkflowArgs,
  resolveGuiWorkflowForTaskKind,
  resolveGuiWorkflowWithArgs,
  sanitizeGuiWorkflowId,
} from '../../../server/utils/gui/guiWorkflowAllowlist'
import { guiOperateKindFromMeta } from '../../../server/utils/gui/guiOperateKindLlm'
import { isDockerHeadlessMcpGui, resolveGuiBlockedErrorCode, buildGuiHumanConfirmMessage, extractGuiFormFieldsSummaryFromRaw } from '../../../server/utils/gui/guiHumanConfirm'

assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('httpbin-form-fill'))
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('w3school-form-fill' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('w3school-form-submit' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('runoob-click-extract' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('httpbin-form-submit' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('oa-multifield-form-fill' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('bilibili-guest-search' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.ok(listKnownGuiWorkflowIds().includes('httpbin-form-fill'))
assert.ok(listKnownGuiWorkflowIds().includes('oa-multifield-form-fill'))
assert.ok(listKnownGuiWorkflowIds().includes('bilibili-guest-search'))
assert.equal(resolveGuiWorkflowForTaskKind('bilibili-guest-search', 'search').ok, true)
assert.equal(resolveGuiWorkflowForTaskKind('bilibili-guest-search', 'extract').ok, true)
assert.equal(resolveGuiWorkflowForTaskKind('bilibili-guest-search', 'form_fill').ok, false)
assert.equal(resolveGuiWorkflowForTaskKind('bilibili-guest-search', 'video_play').ok, false)
assert.equal(
  resolveGuiWorkflowWithArgs('bilibili-guest-search', 'search', { keyword: 'Python' }).ok,
  true,
)
assert.equal(resolveGuiWorkflowWithArgs('bilibili-guest-search', 'search', {}).ok, false)
assert.deepEqual(listMissingGuiWorkflowArgs('bilibili-guest-search', { startUrl: 'https://x' }), [
  'keyword',
])
const enriched = enrichBilibiliGuestWorkflowArgs('bilibili-guest-search', { keyword: 'LangGraph' })
assert.equal(
  String(enriched.startUrl),
  'https://search.bilibili.com/all?keyword=LangGraph',
  'auto startUrl from keyword',
)
assert.ok(BUILTIN_GUI_WORKFLOW_IDS.includes('bilibili-video-play' as (typeof BUILTIN_GUI_WORKFLOW_IDS)[number]))
assert.equal(resolveGuiWorkflowForTaskKind('bilibili-video-play', 'video_play').ok, true)
assert.equal(resolveGuiWorkflowForTaskKind('bilibili-video-play', 'search').ok, false)
assert.equal(
  resolveGuiWorkflowWithArgs('bilibili-video-play', 'video_play', {
    startUrl: 'https://www.bilibili.com/video/BV1xx',
  }).ok,
  true,
)
assert.equal(resolveGuiWorkflowForTaskKind('oa-multifield-form-fill', 'form_fill').ok, true)
assert.equal(
  resolveGuiWorkflowWithArgs(
    'oa-multifield-form-fill',
    'form_fill',
    { customer_name: '王五', email: 'w@ex.com', phone: '13800000000' },
  ).ok,
  true,
)
assert.equal(
  resolveGuiWorkflowWithArgs('oa-multifield-form-fill', 'form_fill', { customer_name: '王五' }).ok,
  false,
)
assert.equal(resolveGuiWorkflowForTaskKind('w3school-form-fill', 'form_fill').ok, true)
assert.equal(resolveGuiWorkflowForTaskKind('w3school-form-submit', 'navigate').ok, false)
assert.ok(listKnownGuiWorkflowIds().includes('runoob-click-extract'))
assert.equal(sanitizeGuiWorkflowId('httpbin-form-fill').ok, true)
assert.equal(sanitizeGuiWorkflowId('runoob-click-extract').ok, true)
assert.equal((sanitizeGuiWorkflowId('httpbin-form-fill') as { ok: true; id: string }).id, 'httpbin-form-fill')

const dropped = sanitizeGuiWorkflowId('navigate-and-extract-title')
assert.equal(dropped.ok, false)
assert.equal((dropped as { ok: false; dropped: string }).dropped, 'navigate-and-extract-title')
assert.equal(isKnownGuiWorkflowId('navigate-and-extract-title'), false)

const fakeMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'extract',
    needs_login: false,
    confidence: 0.9,
    rationale: '抽标题',
    workflow_id: 'navigate-and-extract-title',
  },
})
assert.ok(fakeMeta)
assert.equal(fakeMeta?.workflow_id, undefined, 'unknown macro stripped from decision')
assert.equal(fakeMeta?.dropped_workflow_id, 'navigate-and-extract-title')
assert.equal(fakeMeta?.task_kind, 'extract', 'task_kind kept')

const knownMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'form_fill',
    needs_login: false,
    confidence: 0.91,
    rationale: '宏填表',
    workflow_id: 'httpbin-form-fill',
    workflow_args: { customer_name: 'alice' },
  },
})
assert.equal(knownMeta?.workflow_id, 'httpbin-form-fill')
assert.equal(knownMeta?.dropped_workflow_id, undefined)

const incompleteW3 = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'form_fill',
    needs_login: false,
    confidence: 0.95,
    rationale: '国内填表误挂宏',
    workflow_id: 'w3school-form-fill',
  },
})
assert.equal(incompleteW3?.workflow_id, undefined, 'NL form_fill without args must drop macro')
assert.equal(incompleteW3?.dropped_workflow_id, 'w3school-form-fill')
assert.equal(incompleteW3?.task_kind, 'form_fill')

const completeW3 = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'form_fill',
    needs_login: false,
    confidence: 0.95,
    rationale: '显式宏',
    workflow_id: 'w3school-form-fill',
    workflow_args: { first_name: '张三', last_name: '李四' },
  },
})
assert.equal(completeW3?.workflow_id, 'w3school-form-fill')
assert.equal(String(completeW3?.workflow_args?.first_name), '张三')

assert.deepEqual(listMissingGuiWorkflowArgs('w3school-form-fill', { startUrl: 'https://x' }), [
  'first_name',
  'last_name',
])
assert.equal(
  resolveGuiWorkflowWithArgs('w3school-form-fill', 'form_fill', { startUrl: 'https://x' }).ok,
  false,
)
assert.equal(
  resolveGuiWorkflowWithArgs(
    'w3school-form-fill',
    'form_fill',
    { first_name: 'a', last_name: 'b', startUrl: 'https://x' },
  ).ok,
  true,
)

const runoobMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'navigate',
    needs_login: false,
    confidence: 0.92,
    rationale: 'C1 宏',
    workflow_id: 'runoob-click-extract',
  },
})
assert.equal(runoobMeta?.workflow_id, 'runoob-click-extract')
assert.equal(resolveGuiWorkflowForTaskKind('runoob-click-extract', 'navigate').ok, true)
assert.equal(resolveGuiWorkflowForTaskKind('runoob-click-extract', 'form_fill').ok, false)

// browse 类误挂 form 宏 → 丢弃
const mismatchNav = resolveGuiWorkflowForTaskKind('httpbin-form-fill', 'navigate')
assert.equal(mismatchNav.ok, false)
assert.equal((mismatchNav as { ok: false; dropped: string }).dropped, 'httpbin-form-fill')
const mismatchExtract = resolveGuiWorkflowForTaskKind('httpbin-form-fill', 'extract')
assert.equal(mismatchExtract.ok, false)
assert.equal(resolveGuiWorkflowForTaskKind('httpbin-form-fill', 'form_fill').ok, true)
assert.equal(resolveGuiWorkflowForTaskKind('httpbin-form-submit', 'form_fill').ok, true)

const navMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'navigate',
    needs_login: false,
    confidence: 0.95,
    rationale: '打开 runoob',
    workflow_id: 'httpbin-form-fill',
  },
})
assert.equal(navMeta?.workflow_id, undefined, 'navigate must drop httpbin-form-fill')
assert.equal(navMeta?.dropped_workflow_id, 'httpbin-form-fill')
assert.equal(navMeta?.task_kind, 'navigate')

const envAllow = {
  MANAGER_GUI_WORKFLOW_ALLOWLIST: 'custom-macro-a, other-b',
} as NodeJS.ProcessEnv
assert.ok(isKnownGuiWorkflowId('custom-macro-a', envAllow))
assert.ok(isKnownGuiWorkflowId('httpbin-form-fill', envAllow))

assert.equal(isDockerHeadlessMcpGui({ MANAGER_GUI_MCP_FIRST: '1' } as NodeJS.ProcessEnv), true)
assert.equal(isDockerHeadlessMcpGui({ MANAGER_GUI_MCP_FIRST: '0' } as NodeJS.ProcessEnv), false)

assert.equal(resolveGuiBlockedErrorCode('empty_result'), 'incomplete_task_output')
assert.equal(resolveGuiBlockedErrorCode('need_human'), 'need_human')
assert.equal(resolveGuiBlockedErrorCode('captcha'), 'captcha')
assert.equal(resolveGuiBlockedErrorCode(''), 'task_blocked')
assert.equal(resolveGuiBlockedErrorCode('navigation_unverified'), 'navigation_unverified')

const formConfirm = buildGuiHumanConfirmMessage({
  failureType: 'form_submit',
  task: '提交请假单',
  finalUrl: 'https://httpbin.org/forms/post',
  formFieldsSummary: [
    { key: 'customer_name', value: '王五' },
    { key: 'email', value: 'w@ex.com' },
  ],
})
assert.match(formConfirm.message, /将确认字段：customer_name=王五/)
assert.match(formConfirm.title, /核对字段/)

const biliConfirm = buildGuiHumanConfirmMessage({
  failureType: 'social_engagement',
  task: '给这个B站视频点赞',
  finalUrl: 'https://www.bilibili.com/video/BV1',
})
assert.match(biliConfirm.title, /B站写互动/)
assert.match(biliConfirm.message, /点赞|投币|收藏|关注/)

const fieldsFromRaw = extractGuiFormFieldsSummaryFromRaw({
  result: {
    filled: [{ key: 'first_name', value: '张三' }],
    items: [{ title: 'last_name', text: '李四' }],
  },
})
assert.equal(fieldsFromRaw?.[0]?.key, 'first_name')
assert.equal(fieldsFromRaw?.find((f) => f.key === 'last_name')?.value, '李四')

console.log('smoke: gui workflow allowlist ok')
