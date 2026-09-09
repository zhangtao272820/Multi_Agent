/**
 * Optimizer 决策纯函数契约（不调 LLM）。
 */
import { resolveManagerRetryLimits } from '../../../server/graph/core/runtime/retryBudget'
import {
  fixQueryForOptimizerReason,
  resolveOptimizerDecision
} from '../../../server/graph/core/runtime/optimizerDecision'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-optimizer-decision] ${msg}`)
}

console.log('smoke-optimizer-decision: start')

const baseRetry = resolveManagerRetryLimits({ retryCount: 0, intent: 'db', plan: [{ id: '1' }] })

{
  const d = resolveOptimizerDecision({
    evalScore: 0.9,
    evalRec: 'accept',
    timeoutErrorCount: 0,
    hasEffectiveDataFoundation: true,
    hasAnswer: true,
    wantsVisualize: false,
    hasVisualizeOutput: false,
    hasRenderableChartInFinal: true,
    visualizeIntegrityOk: true,
    hasFix: false,
    canClarify: false,
    retryLimits: baseRetry,
    isWebOnlyIntent: false,
    hasWebAgentEvidence: false,
    pendingRepair: false,
    synthOnlyRepair: false,
    criticRetryOverridden: false,
    guiBrowseOk: false,
    guiSemanticBlocked: false,
    adminWriteTerminal: false,
    guiTerminal: false,
    sideEffectSynthOnly: false,
    sideEffectFailedStepIds: [],
    fixIntentIsMulti: false,
    preferredFixIntentIsMulti: false
  })
  assert(d.action === 'verifier', 'good evidence → verifier')
  assert(d.reason === 'result_present_stop_retry', 'stop retry reason')
}

{
  const d = resolveOptimizerDecision({
    evalScore: 0.5,
    evalRec: '',
    timeoutErrorCount: 0,
    hasEffectiveDataFoundation: false,
    hasAnswer: false,
    wantsVisualize: false,
    hasVisualizeOutput: false,
    hasRenderableChartInFinal: false,
    visualizeIntegrityOk: true,
    hasFix: false,
    canClarify: false,
    retryLimits: baseRetry,
    isWebOnlyIntent: false,
    hasWebAgentEvidence: false,
    pendingRepair: false,
    synthOnlyRepair: false,
    criticRetryOverridden: false,
    guiBrowseOk: false,
    guiSemanticBlocked: false,
    adminWriteTerminal: false,
    guiTerminal: false,
    sideEffectSynthOnly: false,
    sideEffectFailedStepIds: [],
    fixIntentIsMulti: false,
    preferredFixIntentIsMulti: false
  })
  assert(d.action === 'replan_multi', 'missing data → replan_multi')
  assert(fixQueryForOptimizerReason(d.reason).includes('补齐数据'), 'missing_data fixQuery template')
  assert(fixQueryForOptimizerReason('replan_multi').includes('取数'), 'replan_multi template')
}

{
  const d = resolveOptimizerDecision({
    evalScore: 0.5,
    evalRec: '',
    timeoutErrorCount: 0,
    hasEffectiveDataFoundation: true,
    hasAnswer: true,
    wantsVisualize: false,
    hasVisualizeOutput: false,
    hasRenderableChartInFinal: true,
    visualizeIntegrityOk: true,
    hasFix: false,
    canClarify: false,
    retryLimits: baseRetry,
    isWebOnlyIntent: false,
    hasWebAgentEvidence: false,
    pendingRepair: false,
    synthOnlyRepair: false,
    criticRetryOverridden: false,
    guiBrowseOk: false,
    guiSemanticBlocked: false,
    adminWriteTerminal: false,
    guiTerminal: false,
    sideEffectSynthOnly: true,
    sideEffectFailedStepIds: [],
    fixIntentIsMulti: true,
    preferredFixIntentIsMulti: true
  })
  // quality path would be fix, but side effect forces synth-only when wantMulti
  assert(
    d.action === 'verifier' || d.reason === 'side_effect_done_synth_only' || d.action === 'fix',
    'side effect path bounded'
  )
}

{
  const d = resolveOptimizerDecision({
    evalScore: 0.4,
    evalRec: '',
    timeoutErrorCount: 0,
    hasEffectiveDataFoundation: true,
    hasAnswer: true,
    wantsVisualize: false,
    hasVisualizeOutput: false,
    hasRenderableChartInFinal: true,
    visualizeIntegrityOk: true,
    hasFix: false,
    canClarify: false,
    retryLimits: baseRetry,
    isWebOnlyIntent: false,
    hasWebAgentEvidence: false,
    pendingRepair: false,
    synthOnlyRepair: false,
    criticRetryOverridden: false,
    guiBrowseOk: false,
    guiSemanticBlocked: false,
    adminWriteTerminal: false,
    guiTerminal: false,
    sideEffectSynthOnly: true,
    sideEffectFailedStepIds: [],
    fixIntentIsMulti: true,
    preferredFixIntentIsMulti: true
  })
  assert(d.action === 'fix', 'low score + side effect → fix synth-only')
  assert(d.reason === 'side_effect_done_synth_only', 'side_effect synth only reason')
  assert(fixQueryForOptimizerReason(d.reason).includes('勿重做'), 'synth-only template')
}

console.log('smoke-optimizer-decision: ok')
