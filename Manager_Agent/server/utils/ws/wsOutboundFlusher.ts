/**
 * WebSocket 出站帧冲刷：跨 setImmediate 逐条 peer.send，
 * 避免 Nitro/crossws 在长 async handler（如 graph.invoke）内缓冲出站帧，
 * 导致 thinking / delta 在 handler 结束时一次性冲出。
 */
export type WsOutboundPeer = { send: (data: string) => void }

export type WsOutboundFrame = {
  event: string
  data?: unknown
  from?: string
  runId?: string
}

export function createWsOutboundFlusher(peer: WsOutboundPeer) {
  let draining = false
  const queue: string[] = []

  const drain = () => {
    if (draining) return
    draining = true
    const tick = () => {
      const raw = queue.shift()
      if (!raw) {
        draining = false
        return
      }
      try {
        peer.send(raw)
      } catch {
        /* peer may already be closed */
      }
      setImmediate(tick)
    }
    setImmediate(tick)
  }

  return (frame: WsOutboundFrame) => {
    const event = String(frame.event || '').trim()
    if (!event) return
    try {
      queue.push(
        JSON.stringify({
          event,
          data: frame.data,
          from: frame.from,
          runId: frame.runId
        })
      )
    } catch {
      return
    }
    drain()
  }
}
