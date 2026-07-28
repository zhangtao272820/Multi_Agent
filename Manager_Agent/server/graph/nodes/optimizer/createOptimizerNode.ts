import {
  canManagerRetryMore,
  isManagerRetryBudgetExhausted,
  readManagerMaxRetryEnv,
  resolveManagerRetryLimits
} from '../../core/runtime/retryBudget'
import { criticRetryContradictsRunEvidence } from '../../core/output/criticEvidence'
import { detectAdminWriteTerminalFailure } from '../../core/runtime/adminWriteTerminal'

import { detectGuiSemanticBlockFromState } from '../../../utils/gui/guiHumanConfirm'
import type { CreateOptimizerNodeDeps } from './types'


export function createOptimizerNode(deps: CreateOptimizerNodeDeps) {
  const { opts } = deps
  const maxRetry = readManagerMaxRetryEnv()
  return async (state: any) => {
    opts.sendEvent({ event: 'phase', data: 'optimizer', from: 'manager' })
    const evalScore = Number(state?.evaluation?.score ?? 0.7)
    const evalRec = String(state?.evaluation?.recommendation || '').trim()
    const timeoutErrorCount = Number(state?.evaluation?.timeoutErrorCount ?? 0)
    const hasDataEvidence = Boolean(state?.evaluation?.hasDataEvidence)
    const hasImplicitDataEvidence = Boolean(state?.evaluation?.hasImplicitDataEvidence)
    const hasEffectiveDataFoundation = hasDataEvidence || hasImplicitDataEvidence
    const hasAnswer = Boolean(state?.evaluation?.hasAnswer)
    const wantsVisualize = Boolean(state?.evaluation?.wantsVisualize)
    const hasVisualizeOutput = Boolean(state?.evaluation?.hasVisualizeOutput)
    const hasRenderableChartInFinal = Boolean(state?.evaluation?.hasRenderableChartInFinal)
    const visualizeIntegrityOk = Boolean(state?.evaluation?.visualizeIntegrityOk ?? true)
    const hasFix = Boolean(state?.fixQuery) && Boolean(state?.fixIntent)
    const canClarify = Boolean(state?.meta?.needsClarify)
    const retryLimits = resolveManagerRetryLimits(state)
    const retryCount = retryLimits.retryCount
    const retryExhausted = isManagerRetryBudgetExhausted(retryLimits)
    const results = state?.results && typeof state.results === 'object' ? state.results : {}
    const intent = String(state?.intent || '').trim()
    const hasGuiResult = Boolean(String((results as any)?.gui || '').trim())
    const hasCrawlerResult = Boolean(String((results as any)?.crawler || '').trim())
    const evidence = Array.isArray(state?.evidence) ? state.evidence : []
    const hasWebAgentEvidence =
      hasGuiResult ||
      hasCrawlerResult ||
      evidence.some((e: any) => ['gui', 'crawler'].includes(String(e?.kind || '')))
    const isWebOnlyIntent = intent === 'gui' || intent === 'crawler'
    const preferredFixIntent = (() => {
      if (String(results?.crawler || '').trim()) return 'report'
      if (String(results?.rag || '').trim() || String(results?.db || '').trim()) return 'code'
      if (state?.intent === 'crawler') return 'crawler'
      if (state?.intent === 'rag' || state?.intent === 'db') return state.intent
      return 'multi'
    })()
    const fixQuery = (() => {
      if (wantsVisualize && hasVisualizeOutput && !hasRenderableChartInFinal) {
        return '请保留现有结论，并强制把可视化结果透传到最终回复：必须包含 <!--ECHARTS_OPTION-->...<!--/ECHARTS_OPTION-->，若有表格则追加 <!--TABLE_DATA-->...<!--/TABLE_DATA-->。'
      }
      if (timeoutErrorCount > 0) {
        return '请在保留现有事实证据的前提下，用更短输出重试：仅保留核心结论、关键数字和可执行建议，去掉冗长解释。'
      }
      if (!hasEffectiveDataFoundation && !isWebOnlyIntent && !hasWebAgentEvidence) {
        return '请先补齐数据基础（rag/db/crawler 任一可用）后再进行分析输出。'
      }
      return '请根据已有事实修正最终结论，移除未被证据支持的描述，并保持输出简洁。'
    })()

    const pendingRepair =
      Boolean(String(state?.fixQuery || '').trim()) &&
      Boolean(state?.fixIntent) &&
      !String(state?.final || '').trim()
    const synthOnlyRepair = Boolean(state?.meta?.synthOnlyRepair)
    const criticRetryOverridden = criticRetryContradictsRunEvidence({
      evaluation: state?.evaluation
    })
    const guiSemanticBlock = detectGuiSemanticBlockFromState(state)
    const adminTerminal = detectAdminWriteTerminalFailure(state)

    let action: 'clarify' | 'fix' | 'verifier' | 'replan_multi' = 'verifier'
    let reason = 'evidence_good'
    if (guiSemanticBlock.blocked) {
      action = hasAnswer ? 'verifier' : 'clarify'
      reason = 'gui_semantic_blocked'
    } else if (adminTerminal.terminal) {
      // 取消 / 协议垃圾 / 写失败：禁止 quality_repair 多轮复读 preamble
      action = canClarify || evalRec === 'clarify' ? 'clarify' : 'verifier'
      reason = 'admin_write_terminal_no_repair'
    } else if (pendingRepair && criticRetryOverridden) {
      action = 'verifier'
      reason = 'critic_retry_overridden_by_evidence'
    } else if ((pendingRepair || synthOnlyRepair) && canManagerRetryMore(retryLimits)) {
      action = 'fix'
      reason = synthOnlyRepair ? 'synth_only_repair' : 'critic_repair_pending'
    } else if (retryExhausted && (pendingRepair || synthOnlyRepair || hasFix)) {
      action = 'verifier'
      reason = 'retry_budget_exhausted_accept'
    } else if (canClarify || evalRec === 'clarify') {
      action = 'clarify'
      reason = 'needs_clarify'
    } else if (!visualizeIntegrityOk && canManagerRetryMore(retryLimits)) {
      action = 'fix'
      reason = 'visualize_output_lost'
    } else if (
      !hasEffectiveDataFoundation &&
      !isWebOnlyIntent &&
      !hasWebAgentEvidence &&
      canManagerRetryMore(retryLimits)
    ) {
      action = 'replan_multi'
      reason = 'missing_data_foundation'
    } else if ((!hasAnswer || evalScore < 0.65 || timeoutErrorCount > 0 || hasFix) && canManagerRetryMore(retryLimits)) {
      action = 'fix'
      reason = timeoutErrorCount > 0 ? 'timeout_repair' : hasAnswer ? 'quality_repair' : 'missing_answer'
    } else if (hasAnswer) {
      action = 'verifier'
      reason = 'result_present_stop_retry'
    } else {
      action = 'verifier'
      reason = 'accept_and_verify'
    }

    opts.sendEvent({
      event: 'thinking',
      data: `优化决策：action=${action}, reason=${reason}, evalScore=${evalScore.toFixed(2)}, retryCount=${retryCount}/${maxRetry}`,
      from: 'manager'
    })
    if (action === 'replan_multi') {
      return {
        optimizer: { action, reason, at: new Date().toISOString() },
        fixIntent: 'multi',
        fixQuery: '请按“先取数再处理”重规划：先执行 rag/db/crawler 的取数步骤，再执行 code/report/visualize。'
        ,
        retryCount: retryCount + 1
      }
    }
    if (action === 'fix' && (!state?.fixQuery || !state?.fixIntent)) {
      return {
        optimizer: { action, reason, at: new Date().toISOString() },
        fixIntent: preferredFixIntent,
        fixQuery,
        retryCount: retryCount + 1
      }
    }
    if (action === 'verifier' && criticRetryOverridden) {
      return {
        optimizer: { action, reason, at: new Date().toISOString() },
        fixQuery: '',
        fixIntent: undefined
      }
    }
    // If we're already carrying a fixIntent/fixQuery, we still count the "repair attempt" to avoid retry loops.
    if (action === 'fix') return { optimizer: { action, reason, at: new Date().toISOString() }, retryCount: retryCount + 1 }
    return {
      optimizer: { action, reason, at: new Date().toISOString() },
      fixQuery: '',
      fixIntent: undefined,
      ...(adminTerminal.terminal
        ? { meta: { ...(state?.meta || {}), adminWriteTerminal: true, finalSynthPass: true } }
        : {})
    }
  }
}
