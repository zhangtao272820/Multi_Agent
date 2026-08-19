/**
 * E1：爆炸半径契约 — T2 无 confirm_token 不可执行。
 */
import {
  gateBlastRadiusExecution,
  resolveBlastRadius,
  riskTierToBlastRadius
} from '#agent-shared/blastRadius'
import {
  buildManagerTaskEnvelope,
  parseManagerTaskEnvelope,
  serializeManagerTaskEnvelope
} from '#agent-shared/managerTaskEnvelope'
import { gateManagerEnvelopeBlastRadius } from '#agent-shared/envelopeBlastGate'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(riskTierToBlastRadius('low') === 't0', 'low → t0')
assert(riskTierToBlastRadius('medium') === 't1', 'medium → t1')
assert(riskTierToBlastRadius('high') === 't2', 'high → t2')

assert(resolveBlastRadius({ agent: 'db' }) === 't0', 'db t0')
assert(resolveBlastRadius({ agent: 'rag' }) === 't0', 'rag t0')
assert(resolveBlastRadius({ agent: 'code', writeAllowed: false, actionKind: 'code_edit' }) === 't1', 'code preview t1')
assert(resolveBlastRadius({ agent: 'code', writeAllowed: true }) === 't1', 'code write reversible t1')
assert(resolveBlastRadius({ agent: 'code', writeAllowed: true, riskTier: 'high' }) === 't2', 'code high-risk t2')
assert(resolveBlastRadius({ agent: 'admin', actionKind: 'admin_write' }) === 't2', 'admin t2')
assert(resolveBlastRadius({ agent: 'gui', actionKind: 'gui_write' }) === 't2', 'gui t2')

const t2Open = gateBlastRadiusExecution({ blast_radius: 't2' })
assert(!t2Open.ok && t2Open.error_code === 'blast_radius_confirm_required', 't2 no token blocked')
assert(gateBlastRadiusExecution({ blast_radius: 't2', confirm_token: 'tok' }).ok, 't2 with token ok')
assert(gateBlastRadiusExecution({ blast_radius: 't2', auto_confirm: true, allow_t2_auto: true }).ok, 't2 audited auto ok')
assert(!gateBlastRadiusExecution({ blast_radius: 't2', auto_confirm: true, allow_t2_auto: false }).ok, 't2 auto without allow blocked')
assert(gateBlastRadiusExecution({ blast_radius: 't0' }).ok, 't0 open')
assert(gateBlastRadiusExecution({ blast_radius: 't1' }).ok, 't1 open')

const envT2 = buildManagerTaskEnvelope({
  target_agent: 'code',
  trace_id: 'tr-blast-1',
  session_id: 'sess-blast-1',
  utterance: '改代码',
  blast_radius: 't2',
  payload: {
    kind: 'code',
    data: {
      source: 'manager',
      task_kind: 'edit',
      refined_question: '改代码',
      write_allowed: true
    }
  }
})
assert(envT2.blast_radius === 't2', 'envelope blast field')
const blocked = gateManagerEnvelopeBlastRadius(envT2, { writeAllowed: true })
assert(!blocked.ok, 'envelope t2 write blocked')

const envOk = buildManagerTaskEnvelope({
  target_agent: 'code',
  trace_id: 'tr-blast-2',
  session_id: 'sess-blast-2',
  utterance: '改代码',
  blast_radius: 't2',
  confirm_token: 'hitl-ok',
  payload: {
    kind: 'code',
    data: {
      source: 'manager',
      task_kind: 'edit',
      refined_question: '改代码',
      write_allowed: true
    }
  }
})
assert(gateManagerEnvelopeBlastRadius(envOk, { writeAllowed: true }).ok, 'envelope t2 with token')
const parsed = parseManagerTaskEnvelope(serializeManagerTaskEnvelope(envOk))
assert(parsed?.blast_radius === 't2' && parsed.confirm_token === 'hitl-ok', 'envelope blast roundtrip')

console.log('smoke-blast-radius: OK')
