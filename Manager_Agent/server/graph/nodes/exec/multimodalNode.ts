import { unwrapAgentCall } from '../../../utils/agents/agentResult'
import { sanitizeVisionAnswer } from '../../../utils/media/managerVisionSanitize'
import { resolveExecutionQuery } from '../../core/routing/clauses'
import { emitSingleStepPlanEvent } from '../../core/plan/planStepsEvent'
import { buildMediaExecMessage } from '../../core/stepIsolation'
import { shouldReuseRouteCaptionForMultimodal } from '../../orchestrate/routeImageCaption'
import { createExecContext } from './context'
import { compactStepInput } from './helpers'
import type { CreateExecutionNodesDeps } from './types'

export function buildMultimodalNode(deps: CreateExecutionNodesDeps) {
  const {
    ensureNotAborted,
    opts,
    lastUserText,
    appendMetrics,
    emitTrace,
    summarize,
    callMultimodalAgent,
    notifyAgentFailure
  } = createExecContext(deps)

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'execute:multimodal', from: 'manager' })
    const rawQ = resolveExecutionQuery('multimodal', state, lastUserText(state.messages))
    const meta = (state.meta as Record<string, unknown> | undefined) ?? null
    const query = buildMediaExecMessage('multimodal', rawQ, lastUserText(state.messages), meta)
    emitSingleStepPlanEvent(opts, 'multimodal', query)
    const t0 = Date.now()
    emitTrace({ type: 'step_start', agent: 'multimodal', input: compactStepInput(query), at: new Date().toISOString() })
    try {
      const att = state.mediaAttachment
      const caption = String(att?.caption || '').trim()
      if (caption && shouldReuseRouteCaptionForMultimodal(query, caption)) {
        const reused = [
          caption,
          att?.ocrSnippet ? `画面文字：${String(att.ocrSnippet).slice(0, 80)}` : ''
        ]
          .filter(Boolean)
          .join('\n')
        const safeAnswer = sanitizeVisionAnswer(reused, lastUserText(state.messages))
        await appendMetrics({ runId: opts.runId, phase: 'multimodal', ms: Date.now() - t0 })
        opts.sendEvent({
          event: 'thinking',
          data: '多模态：复用路由看图摘要（跳过二次长 VL）',
          from: 'manager'
        })
        const evidence = {
          kind: 'multimodal' as const,
          query,
          action: 'caption_reuse'
        }
        emitTrace({
          type: 'step_end',
          agent: 'multimodal',
          ms: Date.now() - t0,
          status: 'ok',
          evidence,
          outputSummary: summarize(safeAnswer),
          at: new Date().toISOString()
        })
        return { results: { multimodal: safeAnswer }, evidence: [evidence] }
      }
      const raw = await callMultimodalAgent({
        multimodalAgentHttpUrl: opts.multimodalAgentHttpUrl,
        timeoutMs: Math.min(opts.timeoutMs, 120_000),
        query: caption ? `${query}\n\n【路由预读画面摘要，可参考】${caption}` : query,
        action: 'understand',
        filePath: att?.filePath,
        mediaType: att?.mediaType || 'image',
        traceId: opts.runId,
        signal: opts.signal
      })
      const { answer, agentResult } = unwrapAgentCall(raw)
      const userTask = lastUserText(state.messages)
      const safeAnswer = sanitizeVisionAnswer(String(answer ?? ''), userTask)
      await appendMetrics({ runId: opts.runId, phase: 'multimodal', ms: Date.now() - t0 })
      const evidence = { kind: 'multimodal' as const, query, action: 'understand', agentResult }
      emitTrace({
        type: 'step_end',
        agent: 'multimodal',
        ms: Date.now() - t0,
        status: 'ok',
        evidence,
        outputSummary: summarize(safeAnswer),
        at: new Date().toISOString()
      })
      return { results: { multimodal: safeAnswer }, evidence: [evidence] }
    } catch (e: any) {
      emitTrace({
        type: 'step_end',
        agent: 'multimodal',
        status: 'error',
        error: String(e?.message || e),
        at: new Date().toISOString()
      })
      notifyAgentFailure('multimodal', String(e?.message || e))
      opts.sendEvent({ event: 'thinking', data: `多模态 Agent：${String(e?.message || e)}`, from: 'manager' })
      return { results: { multimodal: `多模态服务暂不可用：${String(e?.message || e)}` } }
    }
  }
}
