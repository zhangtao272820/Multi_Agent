/**
 * DB write HITL 契约：db_write → T2；无 token 不可执行；payload 字段。
 */
import {
  gateBlastRadiusExecution,
  resolveBlastRadius
} from '#agent-shared/blastRadius'
import {
  buildManagerTaskEnvelope,
  parseManagerTaskEnvelope,
  serializeManagerTaskEnvelope
} from '#agent-shared/managerTaskEnvelope'
import { gateManagerEnvelopeBlastRadius } from '#agent-shared/envelopeBlastGate'
import { parseManagerDbTaskFromJson } from '#agent-shared/managerSubAgentProtocol'
import { inferActionKindFromAgent } from '../../../server/graph/core/policy/riskExecutionPolicy'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(inferActionKindFromAgent('db') === 'readonly', 'db default readonly')
assert(inferActionKindFromAgent('db', { writeAllowed: true }) === 'db_write', 'db write kind')
assert(resolveBlastRadius({ agent: 'db', writeAllowed: true }) === 't2', 'db write t2')
assert(resolveBlastRadius({ agent: 'db', actionKind: 'db_write' }) === 't2', 'db_write action t2')

const blocked = gateBlastRadiusExecution({ blast_radius: 't2' })
assert(!blocked.ok, 't2 no token blocked')

const parsed = parseManagerDbTaskFromJson(
  JSON.stringify({
    source: 'manager',
    write_allowed: true,
    confirm_token: 'tok',
    pending_id: 'p1',
    refined_question: '加一列',
    impact_ack: true,
    verify_sql: 'SELECT 1'
  })
)
assert(parsed?.write_allowed === true, 'payload write_allowed')
assert(parsed?.confirm_token === 'tok', 'payload confirm_token')
assert(parsed?.pending_id === 'p1', 'payload pending_id')
assert(parsed?.impact_ack === true, 'payload impact_ack')
assert(parsed?.verify_sql === 'SELECT 1', 'payload verify_sql')

const env = buildManagerTaskEnvelope({
  target_agent: 'db',
  trace_id: 'tr-db-w1',
  session_id: 'sess-db-w1',
  utterance: '加字段',
  blast_radius: 't2',
  payload: {
    kind: 'db',
    data: {
      source: 'manager',
      refined_question: '加字段',
      write_allowed: true
    }
  }
})
assert(!gateManagerEnvelopeBlastRadius(env, { writeAllowed: true }).ok, 'envelope t2 blocked')
env.confirm_token = 'hitl'
assert(gateManagerEnvelopeBlastRadius(env, { writeAllowed: true }).ok, 'envelope t2 with token')
const round = parseManagerTaskEnvelope(serializeManagerTaskEnvelope(env))
assert(round?.confirm_token === 'hitl' && round.blast_radius === 't2', 'envelope roundtrip')

console.log('smoke-db-write-hitl: OK')
