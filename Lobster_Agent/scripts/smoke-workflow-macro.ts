/**
 * smoke: Workflow Macro schema / loader / 插值 / 缺参失败（无浏览器）
 */
import {
  interpolateWorkflowText,
  parseLobsterWorkflowDef,
} from '../server/services/lobsterWorkflowSchema'
import {
  assertRequiredWorkflowArgs,
  clearLobsterWorkflowCache,
  listLobsterWorkflowIds,
  loadLobsterWorkflow,
  resolveWorkflowArgs,
} from '../server/services/lobsterWorkflowLoader'
import { isLobsterWorkflowId } from '../server/services/lobsterWorkflowRunner'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

clearLobsterWorkflowCache()
const ids = listLobsterWorkflowIds()
assert(ids.includes('httpbin-form-fill'), `ids=${ids.join(',')}`)
assert(ids.includes('httpbin-form-submit'), 'httpbin-form-submit macro')
assert(ids.includes('w3school-form-fill'), 'w3school-form-fill macro')
assert(ids.includes('w3school-form-submit'), 'w3school-form-submit macro')
assert(ids.includes('runoob-click-extract'), 'runoob-click-extract macro')
assert(ids.includes('bilibili-guest-search'), 'bilibili-guest-search macro')

const def = loadLobsterWorkflow('httpbin-form-fill')
assert(def.steps.length >= 4, 'steps')
assert(def.steps.some((s) => s.action === 'approve'), 'has approve')
assert(def.steps.some((s) => s.action === 'finish'), 'has finish')

const runoob = loadLobsterWorkflow('runoob-click-extract')
assert(runoob.steps.some((s) => s.action === 'click'), 'runoob click')
assert(runoob.steps.some((s) => s.action === 'extract'), 'runoob extract')

const bili = loadLobsterWorkflow('bilibili-guest-search')
assert(bili.steps.some((s) => s.action === 'goto'), 'bili goto')
assert(bili.steps.some((s) => s.action === 'click'), 'bili click')
assert(bili.steps.some((s) => s.action === 'extract'), 'bili extract')
assert(bili.args.includes('keyword'), 'bili keyword arg')

const submit = loadLobsterWorkflow('httpbin-form-submit')
assert(submit.steps.some((s) => s.action === 'approve'), 'submit approve')
assert(submit.steps.some((s) => s.action === 'click'), 'submit click')

const w3 = loadLobsterWorkflow('w3school-form-fill')
assert(w3.steps.filter((s) => s.action === 'type').length >= 2, 'w3school two fields')
assert(w3.args.includes('first_name') && w3.args.includes('last_name'), 'w3school name args')
const w3vars = resolveWorkflowArgs(w3, {
  first_name: '张三',
  last_name: '李四',
  startUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
})
assertRequiredWorkflowArgs(w3, w3vars)
const w3Submit = loadLobsterWorkflow('w3school-form-submit')
assert(w3Submit.steps.some((s) => s.action === 'click'), 'w3school submit click')

const vars = resolveWorkflowArgs(def, {
  customer_name: 'alice',
  startUrl: 'https://httpbin.org/forms/post',
})
assert(vars.customer_name === 'alice', 'args')
assertRequiredWorkflowArgs(def, vars)

const incomplete = resolveWorkflowArgs(def, { customer_name: 'bob' }, { task: 't' })
let missingOk = false
try {
  assertRequiredWorkflowArgs(def, incomplete)
} catch (e: any) {
  missingOk = String(e?.message || e).includes('lobster_workflow_args_missing')
}
assert(missingOk, 'missing args must throw lobster_workflow_args_missing')

const emptyCust = resolveWorkflowArgs(def, {
  customer_name: '  ',
  startUrl: 'https://httpbin.org/forms/post',
})
let emptyOk = false
try {
  assertRequiredWorkflowArgs(def, emptyCust)
} catch (e: any) {
  emptyOk = String(e?.message || e).includes('customer_name')
}
assert(emptyOk, 'blank customer_name must fail')

const goto = def.steps.find((s) => s.action === 'goto')
assert(goto && goto.action === 'goto', 'goto step')
const url = interpolateWorkflowText(goto.url, vars)
assert(url.includes('httpbin.org'), `url=${url}`)

const finish = def.steps.find((s) => s.action === 'finish')
assert(finish && finish.action === 'finish', 'finish')
const ans = interpolateWorkflowText(finish.answer, { ...vars, filled_name: 'alice', landing: 'ok' })
assert(ans.includes('alice'), `ans=${ans}`)

assert(isLobsterWorkflowId('httpbin-form-fill'), 'id ok')
assert(!isLobsterWorkflowId('../evil'), 'reject path')
assert(!ids.includes('navigate-and-extract-title'), 'invented macro must not exist on disk')
// router 侧：不在 list 内的合法格式 id 应回退逐步引擎，而非 load 抛 not_found
const invented = 'navigate-and-extract-title'
assert(isLobsterWorkflowId(invented), 'format-valid invented id')
assert(!ids.some((id) => id.toLowerCase() === invented), 'invented id not in list → router must skip workflow path')

const roundtrip = parseLobsterWorkflowDef(JSON.parse(JSON.stringify(def)))
assert(roundtrip.id === def.id, 'parse roundtrip')

console.log('smoke-workflow-macro: PASS')
