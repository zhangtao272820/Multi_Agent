import { stripSynthPromptLeakage } from '#agent-shared/synthOutputSanitize'
import {
  pickRicherNarrativeWithAuxBlocks,
  tableDataBlockHasValues
} from '#agent-shared/auxBlocks'
import { emitSynthStreamChunks, isManagerSynthStreamEnabled } from '../../core/runtime/runtime'
import { mayEmitFinalSynthStream } from '../../core/runtime/streamEvents'
import { stripLatexMath } from '../../core/text/scenarioAndFormat'
import type { CreateFinalNodesDeps } from './types'

function normalizeSynthCompare(text: string): string {
  return stripSynthPromptLeakage(stripLatexMath(String(text || ''))).trim()
}

/**
 * 审计/评估通过后：定稿 provisional 草稿，或在正文被改写时 revise 后回放。
 * 若 synth 阶段已 provisional 真流且正文未变 → 只发 stream_commit，禁止再整段伪流。
 *
 * 仅当 provisional 含「有数 TABLE_DATA」而定稿丢失时，禁止 revise 成空表
 *（不影响无表的复杂多源回复）。
 */
export function buildEmitUserAnswerNode(deps: Pick<CreateFinalNodesDeps, 'ensureNotAborted' | 'opts'>) {
  const { ensureNotAborted, opts } = deps
  return async (state: any) => {
    ensureNotAborted()
    let body = String(state?.meta?.synthStreamBody || state?.final || '').trim()
    const canFinal =
      Boolean(body) && isManagerSynthStreamEnabled() && mayEmitFinalSynthStream(state)
    if (!canFinal) return {}

    const provisionalStreamed = Boolean(state?.meta?.synthProvisionalStreamed)
    const provisionalRaw = String(state?.meta?.synthProvisionalRaw || '')
    const provisionalHasTable = tableDataBlockHasValues(provisionalRaw)
    const bodyHasTable = tableDataBlockHasValues(body)

    // 仅 DB 查询表场景：定稿丢掉有数表时从 provisional 夺回
    if (provisionalHasTable && !bodyHasTable) {
      body = pickRicherNarrativeWithAuxBlocks(provisionalRaw, body)
    }

    const provisionalNorm = normalizeSynthCompare(provisionalRaw)
    const bodyNorm = normalizeSynthCompare(body)

    if (provisionalStreamed && provisionalNorm && provisionalNorm === bodyNorm) {
      opts.sendEvent({
        event: 'stream_commit',
        data: { phase: 'synth' },
        from: 'manager'
      })
      return {
        final: body,
        meta: { ...(state.meta || {}), synthStreamBody: body }
      }
    }

    // 禁止「流式有数表 → revise 成空表」
    if (provisionalStreamed && provisionalHasTable && !tableDataBlockHasValues(body)) {
      opts.sendEvent({
        event: 'stream_commit',
        data: { phase: 'synth' },
        from: 'manager'
      })
      return {
        final: provisionalRaw,
        meta: { ...(state.meta || {}), synthStreamBody: provisionalRaw }
      }
    }

    if (provisionalStreamed) {
      opts.sendEvent({
        event: 'stream_revise',
        data: { phase: 'synth' },
        from: 'manager'
      })
    }

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
    return {
      final: body,
      meta: { ...(state.meta || {}), synthStreamBody: body }
    }
  }
}
