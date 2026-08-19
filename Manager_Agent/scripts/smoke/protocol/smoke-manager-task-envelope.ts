/**
 * Wave 0：ManagerTaskEnvelope v2 类型与 v1 互转 smoke
 */
import {
  buildManagerTaskEnvelope,
  envelopeToV1ManagerTask,
  parseManagerTaskEnvelope,
  serializeManagerTaskEnvelope,
  v1ToManagerTaskEnvelope,
} from '#agent-shared/managerTaskEnvelope'
import { resolveManagerCodeTaskKind } from '../../../server/utils/code/resolveManagerCodeTaskKind'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const codePayload = {
  source: 'manager' as const,
  task_kind: 'edit' as const,
  refined_question: '在 RAG_Agent 增加 BM25 开关',
  hint_files: ['RAG_Agent/server/utils/retrieval.ts'],
  write_allowed: true,
}

const envelope = buildManagerTaskEnvelope({
  target_agent: 'code',
  trace_id: 'trace-smoke-1',
  session_id: 'sess-smoke-1',
  utterance: codePayload.refined_question,
  payload: { kind: 'code', data: codePayload },
})

assert(envelope.version === '2', 'version')
assert(envelope.payload.kind === 'code', 'payload kind')

const serialized = serializeManagerTaskEnvelope(envelope)
const parsed = parseManagerTaskEnvelope(serialized)
assert(parsed?.payload.kind === 'code', 'roundtrip parse')
assert((parsed?.payload.data as { task_kind?: string }).task_kind === 'edit', 'task_kind')
assert(parsed?.blast_radius === undefined, 'default envelope no blast unless set')

const blastEnv = buildManagerTaskEnvelope({
  target_agent: 'code',
  trace_id: 'trace-blast',
  session_id: 'sess-blast',
  utterance: codePayload.refined_question,
  blast_radius: 't2',
  confirm_token: 'tok-1',
  payload: { kind: 'code', data: codePayload },
})
const blastParsed = parseManagerTaskEnvelope(serializeManagerTaskEnvelope(blastEnv))
assert(blastParsed?.blast_radius === 't2', 'blast_radius roundtrip')
assert(blastParsed?.confirm_token === 'tok-1', 'confirm_token roundtrip')
const blastV1 = envelopeToV1ManagerTask(blastEnv)
assert((blastV1 as { blast_radius?: string })?.blast_radius === 't2', 'v1 carries blast_radius')

const v1 = envelopeToV1ManagerTask(envelope)
assert(v1 && (v1 as { task_kind?: string }).task_kind === 'edit', 'v1 convert')

const fromV1 = v1ToManagerTaskEnvelope({
  target_agent: 'code',
  trace_id: 't2',
  session_id: 's2',
  utterance: 'inspect repo',
  v1: { task_kind: 'inspect', refined_question: '分析路由模块' },
})
assert(fromV1?.payload.kind === 'code', 'v1 to envelope')

const kindUpstream = resolveManagerCodeTaskKind({
  question: '汇总销售',
  upstreamContext: 'db: 销售额 100',
})
assert(kindUpstream === 'compute', 'upstream → compute')

const kindEdit = resolveManagerCodeTaskKind({
  question: '改代码',
  meta: { codeMode: 'edit' },
})
assert(kindEdit === 'edit', 'meta codeMode edit')

// GUI 手：task_kind / needs_login 往返
const guiEnvelope = buildManagerTaskEnvelope({
  target_agent: 'gui',
  trace_id: 'trace-gui-1',
  session_id: 'sess-gui-1',
  utterance: '打开 httpbin 填表',
  payload: {
    kind: 'gui',
    data: {
      source: 'manager',
      task: '打开 https://httpbin.org/forms/post ，在 Customer name 填 lobster_mgr_test',
      startUrl: 'https://httpbin.org/forms/post',
      task_kind: 'form_fill',
      needs_login: false,
      intent_hint: 'form_fill',
      workflow_id: 'httpbin-form-fill',
      workflow_args: { customer_name: 'lobster_mgr_test' },
    },
  },
})
const guiParsed = parseManagerTaskEnvelope(serializeManagerTaskEnvelope(guiEnvelope))
assert(guiParsed?.payload.kind === 'gui', 'gui payload kind')
const guiData = guiParsed!.payload.data as {
  task_kind?: string
  needs_login?: boolean
  intent_hint?: string
  workflow_id?: string
}
assert(guiData.task_kind === 'form_fill', 'gui task_kind')
assert(guiData.needs_login === false, 'gui needs_login')
assert(guiData.workflow_id === 'httpbin-form-fill', 'gui workflow_id')
const guiV1 = envelopeToV1ManagerTask(guiEnvelope)
assert((guiV1 as { task_kind?: string })?.task_kind === 'form_fill', 'gui v1 task_kind')
assert((guiV1 as { workflow_id?: string })?.workflow_id === 'httpbin-form-fill', 'gui v1 workflow_id')
const guiFromV1 = v1ToManagerTaskEnvelope({
  target_agent: 'gui',
  trace_id: 'tg2',
  session_id: 'sg2',
  utterance: '登录 OA',
  v1: { task: '登录内部 OA', task_kind: 'login', needs_login: true },
})
assert(
  (guiFromV1?.payload.data as { task_kind?: string; needs_login?: boolean })?.task_kind === 'login',
  'v1→envelope login',
)
assert(
  (guiFromV1?.payload.data as { needs_login?: boolean })?.needs_login === true,
  'v1→envelope needs_login',
)

console.log('smoke-manager-task-envelope: PASS')
