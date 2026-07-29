import { ChatOpenAI } from '@langchain/openai'
import {
  assessVisualizeIntegrity,
  countTimeoutErrors,
  resolveWantsVisualize,
} from '../../llm/evaluatorLlm'

import { detectGuiSemanticBlockFromState } from '../../../utils/gui/guiHumanConfirm'
import { wrapAdminResult } from '../../../utils/agents/agentResult'
import { hasSuccessfulGuiBrowseInRun } from '../../core/output/criticEvidence'
import type { CreateEvaluatorNodeDeps } from './types'
import { evaluatorModel } from './types'


export function createEvaluatorNode(deps: CreateEvaluatorNodeDeps) {
  const { opts, mergeMeta } = deps
  return async (state: any) => {
    opts.sendEvent({ event: 'phase', data: 'evaluator', from: 'manager' })
    const evidence = Array.isArray(state.evidence) ? state.evidence : []
    const results = state?.results && typeof state.results === 'object' ? state.results : {}
    const errorCount =
      evidence.filter((e: any) => String(e?.kind || '') === 'error').length +
      evidence.filter((e: any) => e?.agentResult?.ok === false || e?.failed === true).length
    const guiBrowseOk = hasSuccessfulGuiBrowseInRun({ results, evidence })
    const hasFailedGuiEvidence =
      !guiBrowseOk &&
      evidence.some(
        (e: any) =>
          String(e?.kind || '') === 'gui' &&
          (e?.agentResult?.ok === false || e?.failed === true)
      )
    const adminOut = String(results?.admin || '').trim()
    const adminWrapped = adminOut ? wrapAdminResult(adminOut) : null
    const hasFailedAdminEvidence =
      evidence.some(
        (e: any) =>
          String(e?.kind || '') === 'admin' &&
          (e?.agentResult?.ok === false || e?.failed === true)
      ) || Boolean(adminWrapped && adminWrapped.ok === false)
    const hasDataEvidence = evidence.some((e: any) => {
      const kind = String(e?.kind || '')
      if (kind === 'gui') {
        if (guiBrowseOk) return true
        if (e?.agentResult?.ok === false || e?.failed === true) return false
      }
      if (kind === 'admin' && (e?.agentResult?.ok === false || e?.failed === true)) return false
      return ['rag', 'db', 'crawler', 'gui', 'admin'].includes(kind)
    })
    const timeoutErrorCount = countTimeoutErrors(evidence)
    const finalText = String(state.final || '').trim()
    const hasAnswer = finalText.length > 0
    const hasImplicitDataEvidence = ['db', 'rag', 'crawler', 'gui', 'code', 'clean', 'visualize', 'report', 'admin']
      .some((k) => {
        if (k === 'gui' && hasFailedGuiEvidence && !guiBrowseOk) return false
        if (k === 'admin' && hasFailedAdminEvidence) return false
        return String((results as any)?.[k] || '').trim().length > 0
      }) || guiBrowseOk
    const hasEffectiveDataFoundation = hasDataEvidence || hasImplicitDataEvidence
    const visualizeText = String(results?.visualize || '').trim()
    const effectivePlan = Array.isArray(state?.plan) ? state.plan : []
    const plannedVisualize = effectivePlan.some((s: any) => String(s?.agent || '') === 'visualize')
    const wantsVisualize = await resolveWantsVisualize(evaluatorModel(deps), {
      routedQuery: String(state?.routedQuery ?? ''),
      userInput: String(state?.input ?? ''),
      plannedVisualize,
      intent: String(state?.intent ?? ''),
    })
    const hasVisualizeOutput = visualizeText.length > 0
    const visualizeIntegrityOk = assessVisualizeIntegrity({
      wantsVisualize,
      visualizeText,
      finalText,
    })
    const needsClarify = Boolean(state?.meta?.needsClarify)
    const guiSemanticBlock = detectGuiSemanticBlockFromState(state)
    const unsupportedClaims = Array.isArray(state?.meta?.unsupportedClaims) ? state.meta.unsupportedClaims.length : 0
    const supportRate = typeof state?.meta?.evidenceSupportedClaimRate === 'number' ? Number(state.meta.evidenceSupportedClaimRate) : undefined

    let score = 1
    if (!hasAnswer) score -= 0.28
    const webOnlyIntent = ['gui', 'crawler'].includes(String(state.intent || '').trim())
    if (!hasEffectiveDataFoundation && state.intent !== 'admin' && !webOnlyIntent) score -= 0.22
    if (errorCount > 0 && !guiBrowseOk) score -= Math.min(0.3, errorCount * 0.08)
    if (hasFailedGuiEvidence) score -= 0.36
    if (guiBrowseOk) score = Math.max(score, 0.72)
    if (hasFailedAdminEvidence) score -= 0.32
    if (guiSemanticBlock.blocked) score -= 0.28
    if (needsClarify || guiSemanticBlock.blocked) score -= 0.16
    if (unsupportedClaims > 0) score -= Math.min(0.2, unsupportedClaims * 0.03)
    if (timeoutErrorCount > 0) score -= Math.min(0.16, timeoutErrorCount * 0.06)
    if (!visualizeIntegrityOk) score -= 0.24
    if (typeof supportRate === 'number') score = Math.min(score, Math.max(0, supportRate))
    score = Math.max(0, Math.min(1, score))

    const recommendation =
      needsClarify || hasFailedAdminEvidence
        ? 'clarify'
        : guiSemanticBlock.blocked
          ? 'accept'
          : !visualizeIntegrityOk
            ? 'retry'
            : score < 0.45
              ? 'retry'
              : score < 0.65
                ? 'retry_if_possible'
                : 'accept'
    opts.sendEvent({
      event: 'thinking',
      data: `评估结果：score=${score.toFixed(2)}, errors=${errorCount}, dataEvidence=${hasDataEvidence ? 'yes' : 'no'}, implicitData=${hasImplicitDataEvidence ? 'yes' : 'no'}, recommend=${recommendation}`,
      from: 'manager'
    })
    return {
      evaluation: {
        score,
        hasAnswer,
        hasDataEvidence,
        hasImplicitDataEvidence,
        errorCount,
        timeoutErrorCount,
        wantsVisualize,
        hasVisualizeOutput,
        visualizeIntegrityOk,
        unsupportedClaims,
        recommendation,
        checkedAt: new Date().toISOString()
      },
      meta: mergeMeta(state, {
        uncertainty: score < 0.45 ? 'high' : score < 0.7 ? 'medium' : state?.meta?.uncertainty ?? 'low'
      })
    }
  }
}

