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

console.log('smoke-ws-stream-order: ok')
