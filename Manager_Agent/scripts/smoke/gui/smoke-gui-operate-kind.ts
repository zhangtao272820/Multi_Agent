/**
 * 总管「手」：operateKind schema · 操作结果腔 · meta 读取
 */
import { GuiOperateKindSchema, guiOperateKindFromMeta, isGuiOperateKind } from '../../../server/utils/gui/guiOperateKindLlm'
import { buildGuiResultForManager } from '../../../server/graph/core/agent/guiTaskPayload'
import { normalizeManagerGuiTaskKind } from '#agent-shared/managerTaskEnvelope'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const ok = GuiOperateKindSchema.safeParse({
  task_kind: 'form_fill',
  needs_login: false,
  confidence: 0.9,
  rationale: '填表',
})
assert(ok.success, 'operate kind schema')
assert(isGuiOperateKind('form_fill'), 'form_fill is operate')
assert(isGuiOperateKind('login'), 'login is operate')
assert(!isGuiOperateKind('search'), 'search is not operate')
assert(normalizeManagerGuiTaskKind('form_fill') === 'form_fill', 'normalize kind')

const fromMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'login',
    needs_login: true,
    confidence: 0.88,
    rationale: '登录',
  },
})
assert(fromMeta?.task_kind === 'login' && fromMeta.needs_login, 'meta operate kind')

const wfMeta = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'form_fill',
    needs_login: false,
    confidence: 0.91,
    rationale: '宏填表',
    workflow_id: 'httpbin-form-fill',
    workflow_args: { customer_name: 'alice', startUrl: 'https://httpbin.org/forms/post' },
  },
})
assert(wfMeta?.workflow_id === 'httpbin-form-fill', 'meta workflow_id')
assert(String(wfMeta?.workflow_args?.customer_name) === 'alice', 'meta workflow_args')

const fakeWf = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'navigate',
    needs_login: false,
    confidence: 0.9,
    rationale: '打开网页',
    workflow_id: 'navigate-and-extract-title',
  },
})
assert(!fakeWf?.workflow_id, 'unknown workflow stripped')
assert(fakeWf?.dropped_workflow_id === 'navigate-and-extract-title', 'dropped id recorded')
assert(fakeWf?.task_kind === 'navigate', 'task_kind kept after strip')

const mismatchWf = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'navigate',
    needs_login: false,
    confidence: 0.95,
    rationale: '打开网页点链接',
    workflow_id: 'httpbin-form-fill',
  },
})
assert(!mismatchWf?.workflow_id, 'navigate drops form-fill macro')
assert(mismatchWf?.dropped_workflow_id === 'httpbin-form-fill', 'incompatible macro recorded')

const extractMismatch = guiOperateKindFromMeta({
  guiOperateKind: {
    task_kind: 'extract',
    needs_login: false,
    confidence: 0.9,
    rationale: '抽标题',
    workflow_id: 'httpbin-form-fill',
  },
})
assert(!extractMismatch?.workflow_id, 'extract drops form-fill macro')

const wfSchema = GuiOperateKindSchema.safeParse({
  task_kind: 'form_fill',
  needs_login: false,
  confidence: 0.9,
  workflow_id: 'httpbin-form-fill',
  workflow_args: { customer_name: 'bob' },
})
assert(wfSchema.success, 'workflow fields in operate kind schema')

const framed = buildGuiResultForManager(
  {
    answer: '已在 Customer name 填入 lobster_mgr_test',
    agentResult: { answer: '已在 Customer name 填入 lobster_mgr_test', ok: true },
    finalUrl: 'https://httpbin.org/forms/post',
    engine: 'stagehand',
    task_kind: 'form_fill',
  },
  '填表',
  { taskKind: 'form_fill' },
)
assert(framed.includes('【浏览器操作】'), 'operate frame')
assert(framed.includes('stagehand') || framed.includes('引擎'), 'operate engine line')
assert(!framed.includes('小结'), 'no news-style summary')

const searchOut = buildGuiResultForManager(
  {
    agentResult: { answer: '第一条是 Python 官方教程', ok: true },
    finalUrl: 'https://docs.python.org/',
    task_kind: 'search',
  },
  '搜 Python',
  { taskKind: 'search' },
)
assert(searchOut.includes('Python'), 'search keeps answer')
assert(!searchOut.includes('【浏览器操作】'), 'search not operate-framed')

console.log('smoke-gui-operate-kind: PASS')
