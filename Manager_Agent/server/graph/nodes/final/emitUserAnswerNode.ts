import { emitSynthStreamChunks, isManagerSynthStreamEnabled } from '../../core/runtime/runtime'
import { shouldEmitUserSynthStream } from '../../core/runtime/streamEvents'
import type { CreateFinalNodesDeps } from './types'

/**
 * 审计/评估通过后：将缓冲正文伪流回放给用户（不二次 LLM）。
 */
export function buildEmitUserAnswerNode(deps: Pick<CreateFinalNodesDeps, 'ensureNotAborted' | 'opts'>) {
  const { ensureNotAborted, opts } = deps
  return async (state: any) => {
    ensureNotAborted()
    const body = String(state?.meta?.synthStreamBody || state?.final || '').trim()
    const canStream =
      Boolean(body) && isManagerSynthStreamEnabled() && shouldEmitUserSynthStream(state)
    if (!canStream) return {}

    opts.sendEvent({ event: 'phase', data: 'synth', from: 'manager' })
    opts.sendEvent({ event: 'phase', data: 'synth_stream', from: 'manager' })
    opts.sendEvent({ event: 'stream_start', data: { phase: 'synth' }, from: 'manager' })
    await emitSynthStreamChunks(
      body,
      (delta) => {
        if (delta) opts.sendEvent({ event: 'delta', data: delta, from: 'synth' })
      },
      ensureNotAborted
    )
    return {}
  }
}
