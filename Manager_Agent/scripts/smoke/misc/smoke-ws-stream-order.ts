/**
 * G6：WS 流式事件序 smoke（start → delta* → final|error）+ 终态才开流。
 */
import {
  classifyWsStreamEvent,
  countUserFacingStreamStarts,
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

/** 审计通过标记出现前，不得有用户面 stream_start */
function assertNoStreamBeforeAuditPass(
  events: Array<{ kind: string; phase?: string; auditPassed?: boolean }>
): void {
  let auditPassed = false
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.auditPassed === true) auditPassed = true
    if (e.kind === 'stream_start' && !auditPassed) {
      throw new Error(`stream_start before audit pass at index ${i}`)
    }
  }
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
  // 普通 draft：无 finalSynthPass → 不开用户流
  const draft = shouldEmitUserSynthStream({
    retryCount: 0,
    intent: 'db',
    results: { db: 'ok' },
    meta: {}
  })
  assert(!draft, 'draft without finalSynthPass must not stream')
}

{
  // 审计通过后：开流
  const passed = shouldEmitUserSynthStream({
    retryCount: 0,
    intent: 'db',
    results: { db: 'ok' },
    meta: { finalSynthPass: true }
  })
  assert(passed, 'finalSynthPass must stream')
}

{
  // synthOnlyRepair 仍会再过 critic → 不开流
  const repair = shouldEmitUserSynthStream({
    retryCount: 0,
    intent: 'code',
    meta: { synthOnlyRepair: true }
  })
  assert(!repair, 'synthOnlyRepair alone must not stream')
}

{
  // 寒暄捷径：可开流
  const chitchat = shouldEmitUserSynthStream({
    meta: { directChitchatSynth: true }
  })
  assert(chitchat, 'directChitchatSynth may stream')
}

{
  // 中间失败（可修复 timeout）且仍有重试预算：不应开用户流
  const provisional = shouldEmitUserSynthStream({
    retryCount: 0,
    intent: 'admin',
    results: { admin: '个人助手步骤失败：aiAdminAgent timeout' },
    meta: {
      lastStepRecords: [{ agent: 'admin', status: 'error', error: 'timeout' }]
    }
  })
  assert(!provisional, 'provisional admin fail must not stream')
}

{
  // GUI 可修复失败轮：不应开用户流
  const guiProvisional = shouldEmitUserSynthStream({
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
  assert(!guiProvisional, 'provisional gui fail must not stream')
}

{
  // 协议垃圾 / 取消终态：可开流一次（不再 repair）
  const terminalGarbage = shouldEmitUserSynthStream({
    retryCount: 0,
    intent: 'admin',
    results: { admin: 'error: 仅处理下列个人助理能力' },
    meta: {}
  })
  assert(terminalGarbage, 'protocol garbage is terminal stream')
}

{
  // 终态取消：可开流一次
  const terminal = shouldEmitUserSynthStream({
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
  // 目标序：评估/核对 → 审计通过 → 再 stream_start
  assertNoStreamBeforeAuditPass([
    { kind: 'phase', phase: 'evaluator' },
    { kind: 'phase', phase: 'critic' },
    { kind: 'thinking' },
    { auditPassed: true, kind: 'other' },
    { kind: 'stream_start' },
    { kind: 'delta' }
  ])
  let threw = false
  try {
    assertNoStreamBeforeAuditPass([
      { kind: 'stream_start' },
      { kind: 'phase', phase: 'critic' },
      { auditPassed: true, kind: 'other' }
    ])
  } catch {
    threw = true
  }
  assert(threw, 'stream before audit must fail assert')
}

console.log('smoke-ws-stream-order: ok')
