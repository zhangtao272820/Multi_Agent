/**
 * Optimizer 决策纯函数：action/reason 由 evaluation + 闸门信号决定；
 * fixQuery 按 reason 查表，禁止在节点里堆不可测脚本分支。
 */
import {
  canManagerRetryMore,
  isManagerRetryBudgetExhausted,
  type ManagerRetryLimits
} from './retryBudget'

export type OptimizerAction = 'clarify' | 'fix' | 'verifier' | 'replan_multi'

export type OptimizerDecisionInput = {
  evalScore: number
  evalRec: string
  timeoutErrorCount: number
  hasEffectiveDataFoundation: boolean
  hasAnswer: boolean
  wantsVisualize: boolean
  hasVisualizeOutput: boolean
  hasRenderableChartInFinal: boolean
  visualizeIntegrityOk: boolean
  hasFix: boolean
  canClarify: boolean
  retryLimits: ManagerRetryLimits
  isWebOnlyIntent: boolean
  hasWebAgentEvidence: boolean
  pendingRepair: boolean
  synthOnlyRepair: boolean
  criticRetryOverridden: boolean
  guiBrowseOk: boolean
  guiSemanticBlocked: boolean
  adminWriteTerminal: boolean
  guiTerminal: boolean
  sideEffectSynthOnly: boolean
  sideEffectFailedStepIds: string[]
  fixIntentIsMulti: boolean
  preferredFixIntentIsMulti: boolean
}

export type OptimizerDecision = {
  action: OptimizerAction
  reason: string
}

const FIX_QUERY_BY_REASON: Record<string, string> = {
  visualize_output_lost:
    '请保留现有结论，并强制把可视化结果透传到最终回复：必须包含 <!--ECHARTS_OPTION-->...<!--/ECHARTS_OPTION-->，若有表格则追加 <!--TABLE_DATA-->...<!--/TABLE_DATA-->。',
  timeout_repair:
    '请在保留现有事实证据的前提下，用更短输出重试：仅保留核心结论、关键数字和可执行建议，去掉冗长解释。',
  missing_data_foundation:
    '请先补齐数据基础（rag/db/crawler 任一可用）后再进行分析输出。',
  quality_repair: '请根据已有事实修正最终结论，移除未被证据支持的描述，并保持输出简洁。',
  missing_answer: '请根据已有事实修正最终结论，移除未被证据支持的描述，并保持输出简洁。',
  critic_repair_pending: '请根据已有事实修正最终结论，移除未被证据支持的描述，并保持输出简洁。',
  synth_only_repair: '请在保留已成功写入结果的前提下修正最终综合，勿重做 admin 写操作。',
  side_effect_done_synth_only:
    '请在保留已成功写入结果的前提下修正最终综合，勿重做 admin 写操作。',
  side_effect_done_failed_steps_only:
    '请仅重跑失败步骤并保留已成功副作用，再修正最终综合。',
  replan_multi:
    '请按“先取数再处理”重规划：先执行 rag/db/crawler 的取数步骤，再执行 code/report/visualize。'
}

export function fixQueryForOptimizerReason(reason: string, fallback = ''): string {
  const keyed = FIX_QUERY_BY_REASON[String(reason || '').trim()]
  if (keyed) return keyed
  const fb = String(fallback || '').trim()
  return fb || FIX_QUERY_BY_REASON.quality_repair
}

export function resolveOptimizerDecision(input: OptimizerDecisionInput): OptimizerDecision {
  const canRetry = canManagerRetryMore(input.retryLimits)
  const retryExhausted = isManagerRetryBudgetExhausted(input.retryLimits)

  let action: OptimizerAction = 'verifier'
  let reason = 'evidence_good'

  if (input.guiSemanticBlocked) {
    action = 'verifier'
    reason = 'gui_semantic_blocked'
  } else if (input.adminWriteTerminal) {
    action = input.canClarify || input.evalRec === 'clarify' ? 'clarify' : 'verifier'
    reason = 'admin_write_terminal_no_repair'
  } else if (input.guiTerminal) {
    action = 'verifier'
    reason = 'gui_terminal_no_repair'
  } else if (input.pendingRepair && input.criticRetryOverridden) {
    action = 'verifier'
    reason = input.guiBrowseOk ? 'gui_browse_evidence_stop_retry' : 'critic_retry_overridden_by_evidence'
  } else if ((input.pendingRepair || input.synthOnlyRepair) && canRetry) {
    action = 'fix'
    reason = input.synthOnlyRepair ? 'synth_only_repair' : 'critic_repair_pending'
  } else if (retryExhausted && (input.pendingRepair || input.synthOnlyRepair || input.hasFix)) {
    action = 'verifier'
    reason = 'retry_budget_exhausted_accept'
  } else if (input.canClarify || input.evalRec === 'clarify') {
    action = 'clarify'
    reason = 'needs_clarify'
  } else if (!input.visualizeIntegrityOk && canRetry) {
    action = 'fix'
    reason = 'visualize_output_lost'
  } else if (
    !input.hasEffectiveDataFoundation &&
    !input.isWebOnlyIntent &&
    !input.hasWebAgentEvidence &&
    canRetry
  ) {
    action = 'replan_multi'
    reason = 'missing_data_foundation'
  } else if (
    (!input.hasAnswer || input.evalScore < 0.65 || input.timeoutErrorCount > 0 || input.hasFix) &&
    canRetry
  ) {
    action = 'fix'
    reason =
      input.timeoutErrorCount > 0 ? 'timeout_repair' : input.hasAnswer ? 'quality_repair' : 'missing_answer'
  } else if (input.hasAnswer) {
    action = 'verifier'
    reason = 'result_present_stop_retry'
  } else {
    action = 'verifier'
    reason = 'accept_and_verify'
  }

  if (
    (action === 'fix' || action === 'replan_multi') &&
    (input.sideEffectSynthOnly || input.sideEffectFailedStepIds.length > 0)
  ) {
    const wantMulti =
      input.fixIntentIsMulti || input.preferredFixIntentIsMulti || action === 'replan_multi'
    if (wantMulti || reason === 'quality_repair' || reason === 'critic_repair_pending') {
      if (input.sideEffectSynthOnly) {
        action = 'fix'
        reason = 'side_effect_done_synth_only'
      } else if (input.sideEffectFailedStepIds.length > 0) {
        action = 'fix'
        reason = 'side_effect_done_failed_steps_only'
      }
    }
  }

  return { action, reason }
}
