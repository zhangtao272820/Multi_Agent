import {
  readManagerMaxRetryEnv,
  resolveManagerRetryLimits
} from '../../core/runtime/retryBudget'
import {
  fixQueryForOptimizerReason,
  resolveOptimizerDecision
} from '../../core/runtime/optimizerDecision'
import { criticRetryContradictsRunEvidence, hasSuccessfulGuiBrowseInRun } from '../../core/output/criticEvidence'
import { detectAdminWriteTerminalFailure } from '../../core/runtime/adminWriteTerminal'
import {
  detectGuiTerminalFailure,
  hasFailedGuiEvidenceInRun,
  shouldSkipGuiGraphRetry
} from '../../core/runtime/guiTerminal'
import { shouldPreferSynthOnlyAfterSideEffect } from '../../core/runtime/stepReuse'

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
    const results = state?.results && typeof state.results === 'object' ? state.results : {}
    const intent = String(state?.intent || '').trim()
    const hasGuiResult = Boolean(String((results as any)?.gui || '').trim())
    const hasCrawlerResult = Boolean(String((results as any)?.crawler || '').trim())
    const evidence = Array.isArray(state?.evidence) ? state.evidence : []
    const guiBrowseOk = hasSuccessfulGuiBrowseInRun({ results, evidence })
    const hasWebAgentEvidence =
      hasGuiResult ||
      hasCrawlerResult ||
      guiBrowseOk ||
      evidence.some((e: any) => ['gui', 'crawler'].includes(String(e?.kind || '')))
    const isWebOnlyIntent = intent === 'gui' || intent === 'crawler'
    const preferredFixIntent = (() => {
      if (String(results?.crawler || '').trim()) return 'report'
      if (String(results?.rag || '').trim() || String(results?.db || '').trim()) return 'code'
      if (state?.intent === 'crawler') return 'crawler'
      if (state?.intent === 'rag' || state?.intent === 'db') return state.intent
      if (state?.intent === 'gui' || hasFailedGuiEvidenceInRun(state)) {
        if (shouldSkipGuiGraphRetry(state)) return 'multi'
        return 'gui'
      }
      return 'multi'
    })()

    const pendingRepair =
      Boolean(String(state?.fixQuery || '').trim()) &&
      Boolean(state?.fixIntent) &&
      !String(state?.final || '').trim()
    const synthOnlyRepair = Boolean(state?.meta?.synthOnlyRepair)
    const criticRetryOverridden =
      criticRetryContradictsRunEvidence({
        evaluation: state?.evaluation
      }) || guiBrowseOk
    const guiSemanticBlock = detectGuiSemanticBlockFromState(state)
    const adminTerminal = detectAdminWriteTerminalFailure(state)
    const guiTerminal = detectGuiTerminalFailure(state)
    const sideEffectPref = shouldPreferSynthOnlyAfterSideEffect({
      results,
      evidence,
      lastStepRecords: Array.isArray(state?.meta?.lastStepRecords) ? state.meta.lastStepRecords : null,
      forceRerunStepIds: Array.isArray(state?.meta?.forceRerunStepIds) ? state.meta.forceRerunStepIds : null
    })

    const { action, reason } = resolveOptimizerDecision({
      evalScore,
      evalRec,
      timeoutErrorCount,
      hasEffectiveDataFoundation,
      hasAnswer,
      wantsVisualize,
      hasVisualizeOutput,
      hasRenderableChartInFinal,
      visualizeIntegrityOk,
      hasFix,
      canClarify,
      retryLimits,
      isWebOnlyIntent,
      hasWebAgentEvidence,
      pendingRepair,
      synthOnlyRepair,
      criticRetryOverridden,
      guiBrowseOk,
      guiSemanticBlocked: guiSemanticBlock.blocked,
      adminWriteTerminal: adminTerminal.terminal,
      guiTerminal: guiTerminal.terminal,
      sideEffectSynthOnly: sideEffectPref.synthOnly,
      sideEffectFailedStepIds: sideEffectPref.failedStepIds,
      fixIntentIsMulti: String(state?.fixIntent || '') === 'multi',
      preferredFixIntentIsMulti: preferredFixIntent === 'multi'
    })

    const fixQuery = fixQueryForOptimizerReason(reason)

    opts.sendEvent({
      event: 'thinking',
      data: `优化决策：action=${action}, reason=${reason}, evalScore=${evalScore.toFixed(2)}, retryCount=${retryCount}/${maxRetry}`,
      from: 'manager'
    })

    if (reason === 'side_effect_done_synth_only') {
      return {
        optimizer: { action: 'fix', reason, at: new Date().toISOString() },
        fixIntent: 'code',
        fixQuery: String(state?.fixQuery || '').trim() || fixQuery,
        retryCount: retryCount + 1,
        meta: { ...(state?.meta || {}), synthOnlyRepair: true }
      }
    }
    if (reason === 'side_effect_done_failed_steps_only') {
      return {
        optimizer: { action: 'fix', reason, at: new Date().toISOString() },
        fixIntent: 'multi',
        fixQuery: String(state?.fixQuery || '').trim() || fixQuery,
        retryCount: retryCount + 1,
        meta: {
          ...(state?.meta || {}),
          forceRerunStepIds: sideEffectPref.failedStepIds
        }
      }
    }
    if (action === 'replan_multi') {
      return {
        optimizer: { action, reason, at: new Date().toISOString() },
        fixIntent: 'multi',
        fixQuery: fixQueryForOptimizerReason('replan_multi'),
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
    if (action === 'fix') return { optimizer: { action, reason, at: new Date().toISOString() }, retryCount: retryCount + 1 }
    if (action === 'clarify') {
      return {
        optimizer: { action, reason, at: new Date().toISOString() },
        fixQuery: '',
        fixIntent: undefined
      }
    }
    const passMeta: Record<string, unknown> = { finalSynthPass: true }
    if (adminTerminal.terminal) passMeta.adminWriteTerminal = true
    if (guiTerminal.terminal) {
      passMeta.guiTerminal = true
      if (guiTerminal.code) passMeta.guiTerminalCode = guiTerminal.code
    }
    return {
      optimizer: { action, reason, at: new Date().toISOString() },
      fixQuery: '',
      fixIntent: undefined,
      meta: { ...(state?.meta || {}), ...passMeta }
    }
  }
}
