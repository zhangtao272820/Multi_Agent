/**
 * G6：WS 流式事件序 smoke（provisional 真流 + 定稿 commit/revise）。
 */
import {
  assertNoFinalStreamBeforeAuditPass,
  classifyWsStreamEvent,
  countUserFacingStreamStarts,
  mayEmitFinalSynthStream,
  mayEmitProvisionalSynthStream,
  shouldEmitUserSynthStream,
  validateSynthStreamOrder,
  type WsStreamEvent
} from '../../../server/graph/core/runtime/streamEvents'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function ev(event: string, data?: unknown): WsStreamEvent {
  return classifyWsStreamEvent(event, data)
}

{
  const good: WsStreamEvent[] = [
    ev('stream_start', { from: 'manager' }),
    ev('delta', { from: 'synth' }),
    ev('delta', { from: 'synth' }),
    ev('final', { from: 'manager' })
  ]
  const r = validateSynthStreamOrder(good)
  assert(r.ok, 'valid stream order')
}

{
  const provisionalCommit: WsStreamEvent[] = [
    ev('stream_start', { from: 'manager', data: { phase: 'synth', provisional: true } }),
    ev('delta', { from: 'synth' }),
    ev('stream_commit', { from: 'manager' }),
    ev('final', { from: 'manager' })
  ]
  assert(validateSynthStreamOrder(provisionalCommit).ok, 'provisional + commit ok')
}

{
  const revisePath: WsStreamEvent[] = [
    ev('stream_start', { data: { provisional: true } }),
    ev('delta'),
    ev('stream_revise'),
    ev('stream_start'),
    ev('delta'),
    ev('final')
  ]
  assert(validateSynthStreamOrder(revisePath).ok, 'revise then restart ok')
}

{
  const bad: WsStreamEvent[] = [
    ev('delta', { from: 'synth' }),
    ev('final', { from: 'manager' })
  ]
  const r = validateSynthStreamOrder(bad)
  assert(!r.ok && String(r.reason).includes('stream_start'), 'delta before start fails')
}

{
  const noEnd: WsStreamEvent[] = [ev('stream_start'), ev('delta')]
  const r = validateSynthStreamOrder(noEnd)
  assert(!r.ok, 'missing final fails')
}

{
  const errPath: WsStreamEvent[] = [ev('stream_start'), ev('error')]
  assert(validateSynthStreamOrder(errPath).ok, 'error terminator ok')
}

{
  // 普通 draft：无 finalSynthPass → 不定稿流
  const draft = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'db',
    results: { db: 'ok' },
    meta: {}
  })
  assert(!draft, 'draft without finalSynthPass must not final-stream')
  assert(shouldEmitUserSynthStream({ meta: {} }) === draft, 'alias matches mayEmitFinal')
}

{
  assert(mayEmitProvisionalSynthStream({ meta: {} }), 'provisional allowed during synth')
}

{
  // 审计通过后：可定稿
  const passed = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'db',
    results: { db: 'ok' },
    meta: { finalSynthPass: true }
  })
  assert(passed, 'finalSynthPass must final-stream')
}

{
  // synthOnlyRepair 仍会再过 critic → 不定稿
  const repair = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'code',
    meta: { synthOnlyRepair: true }
  })
  assert(!repair, 'synthOnlyRepair alone must not final-stream')
}

{
  // 寒暄捷径：可定稿
  const chitchat = mayEmitFinalSynthStream({
    meta: { directChitchatSynth: true }
  })
  assert(chitchat, 'directChitchatSynth may final-stream')
}

{
  // 中间失败（可修复 timeout）且仍有重试预算：不应定稿
  const provisional = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'admin',
    results: { admin: '个人助手步骤失败：aiAdminAgent timeout' },
    meta: {
      lastStepRecords: [{ agent: 'admin', status: 'error', error: 'timeout' }]
    }
  })
  assert(!provisional, 'provisional admin fail must not final-stream')
}

{
  // GUI 可修复失败轮：不应定稿
  const guiProvisional = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'gui',
    results: { gui: '页面超时，请重试' },
    evidence: [{ kind: 'gui', failed: true, agentResult: { ok: false } }],
    fixQuery: '请按审计建议重试',
    fixIntent: 'gui',
    meta: {
      lastStepRecords: [{ agent: 'gui', status: 'error', error: 'timeout' }]
    }
  })
  assert(!guiProvisional, 'provisional gui fail must not final-stream')
}

{
  // 协议垃圾 / 取消终态：可定稿一次（不再 repair）
  const terminalGarbage = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'admin',
    results: { admin: 'error: 仅处理下列个人助理能力' },
    meta: {}
  })
  assert(terminalGarbage, 'protocol garbage is terminal stream')
}

{
  // 终态取消：可定稿一次
  const terminal = mayEmitFinalSynthStream({
    retryCount: 0,
    intent: 'admin',
    results: { admin: '未确认，未写入日程/待办。如需执行请重新发起并点击确认。' },
    meta: { adminWriteTerminal: true }
  })
  assert(terminal, 'terminal cancel may stream once')
}

{
  assert(countUserFacingStreamStarts([{ kind: 'stream_start' }, { kind: 'stream_start', provisional: true }]) === 1, 'count user starts')
}

{
  // provisional 可在审计前出现；定稿 stream_start 不可
  assertNoFinalStreamBeforeAuditPass([
    { kind: 'stream_start', provisional: true },
    { kind: 'delta' },
    { kind: 'phase', phase: 'evaluator' },
    { kind: 'phase', phase: 'critic' },
    { auditPassed: true, kind: 'other' },
    { kind: 'stream_commit' }
  ])
  assertNoFinalStreamBeforeAuditPass([
    { kind: 'phase', phase: 'evaluator' },
    { kind: 'phase', phase: 'critic' },
    { auditPassed: true, kind: 'other' },
    { kind: 'stream_start' },
    { kind: 'delta' }
  ])
  let threw = false
  try {
    assertNoFinalStreamBeforeAuditPass([
      { kind: 'stream_start' },
      { kind: 'phase', phase: 'critic' },
      { auditPassed: true, kind: 'other' }
    ])
  } catch {
    threw = true
  }
  assert(threw, 'final stream before audit must fail assert')
}

{
  const classified = classifyWsStreamEvent('stream_start', {
    from: 'manager',
    data: { phase: 'synth', provisional: true }
  })
  assert(classified.kind === 'stream_start' && classified.provisional === true, 'classify provisional start')
}

console.log('smoke-ws-stream-order: ok')
