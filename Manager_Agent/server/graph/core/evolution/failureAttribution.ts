import { isDbNoData } from '../runtime/runtimePersistence'
import {
  looksLikeAgentError,
  looksLikeFinalTextClaimsMissingMedia,
  textIncludesAny,
  PLAN_FAILURE_MARKERS,
} from '#agent-shared/textMarkers'

import { extractSearchRunMetrics } from '../../../utils/search/managerSearchMetrics'
import { ragPassthroughHasSubstantiveAnswer } from '#agent-shared/deterministicPassthrough'

export type FailureAttribution = {
  category:
    | 'success'
    | 'clarify_needed'
    | 'route_error'
    | 'plan_error'
    | 'tool_failure'
    | 'evidence_gap'
    | 'search_gap'
    | 'synthesis_error'
    | 'verification_gap'
    | 'policy_boundary'
    | 'timeout'
    | 'unclear'
  severity: 'low' | 'medium' | 'high'
  reasons: string[]
}

function hasText(v: unknown) {
  return String(v ?? '').trim().length > 0
}

function collectResults(state: any) {
  const bag = state?.results && typeof state.results === 'object' ? state.results : {}
  return Object.entries(bag)
    .map(([agent, value]) => ({ agent, text: String(value ?? '').trim() }))
    .filter((x) => x.text.length > 0)
}

function resultLooksLikeAgentError(agent: string, text: string, evidence: any[]): boolean {
  if (agent === 'rag' && ragPassthroughHasSubstantiveAnswer({ text, evidence })) return false
  return looksLikeAgentError(text)
}

export function attributeFailure(state: any, opts?: { timeLeftMs?: number; finalText?: string }): FailureAttribution {
  const reasons: string[] = []
  const finalText = String(opts?.finalText ?? state?.final ?? '').trim()
  const needsClarify = Boolean(state?.meta?.needsClarify)
  const capabilityOk = state?.meta?.capabilityOk !== false
  const evidence = Array.isArray(state?.evidence) ? state.evidence : []
  const results = collectResults(state)
  const evidenceKinds = new Set(evidence.map((e: any) => String(e?.kind || '').trim()).filter(Boolean))
  const routeConf = typeof state?.meta?.routeConfidence === 'number' ? Number(state.meta.routeConfidence) : 0
  const finalConf = typeof state?.meta?.finalConfidence === 'number' ? Number(state.meta.finalConfidence) : 0
  const unsupportedClaims = Array.isArray(state?.meta?.unsupportedClaims) ? state.meta.unsupportedClaims : []
  const timeLeft = typeof opts?.timeLeftMs === 'number' ? opts.timeLeftMs : undefined
  const plan = Array.isArray(state?.plan) ? state.plan : []
  const retryCount = Number(state?.retryCount ?? 0) || 0

  if (!capabilityOk) return { category: 'policy_boundary', severity: 'high', reasons: ['capabilityOk=false'] }
  if (timeLeft != null && timeLeft < 1500) return { category: 'timeout', severity: 'high', reasons: ['time budget nearly exhausted'] }
  if (needsClarify) return { category: 'clarify_needed', severity: 'medium', reasons: ['meta.needsClarify=true'] }

  if (retryCount > 0 && !finalText) reasons.push('has retry but no final text')
  if (routeConf < 0.45 && !hasText(state?.routedQuery)) reasons.push('low route confidence')
  if (plan.length > 0 && results.length === 0) reasons.push('plan exists but no agent results')
  if (results.some((r) => resultLooksLikeAgentError(r.agent, r.text, evidence))) reasons.push('agent output contains error/timeout')
  if (evidenceKinds.size === 0) reasons.push('no evidence')
  if (unsupportedClaims.length > 0) reasons.push('unsupported claims present')
  if (finalText && !hasText(state?.results?.multimodal) && looksLikeFinalTextClaimsMissingMedia(finalText)) {
    reasons.push('final text may misread media availability')
  }
  if (results.some((r) => isDbNoData(r.text))) reasons.push('db no data')

  // 仅「库内无匹配」且已有可读终答：业务空结果，不当失败
  const onlySoftDbEmpty =
    reasons.length > 0 &&
    reasons.every((r) => r === 'db no data') &&
    Boolean(finalText) &&
    !results.some((r) => resultLooksLikeAgentError(r.agent, r.text, evidence) && !isDbNoData(r.text))

  const search = extractSearchRunMetrics(state)
  if (search.searchRequested && search.searchHitCount === 0) {
    if (search.searchFailed) reasons.push(`web search error: ${search.searchError || 'unknown'}`)
    else reasons.push('web search returned no SERP hits')
    if (needsClarify || finalConf < 0.55 || !finalText) {
      return {
        category: 'search_gap',
        severity: search.searchFailed ? 'high' : 'medium',
        reasons: reasons.length ? reasons : ['search requested but no hits']
      }
    }
  }

  if (!finalText && results.length > 0) {
    return { category: 'synthesis_error', severity: 'high', reasons: reasons.length ? reasons : ['results exist but no final synthesis'] }
  }
  if (results.length === 0 && evidenceKinds.size > 0) {
    return { category: 'verification_gap', severity: 'medium', reasons: reasons.length ? reasons : ['evidence exists but no agent outputs'] }
  }
  if (results.length > 0 && evidenceKinds.size === 0) {
    return { category: 'evidence_gap', severity: 'medium', reasons: reasons.length ? reasons : ['agent outputs exist but no evidence'] }
  }
  if (routeConf < 0.5 && finalConf < 0.55) {
    return { category: 'route_error', severity: 'medium', reasons: reasons.length ? reasons : ['route and final confidence both low'] }
  }
  if (results.some((r) => textIncludesAny(r.agent, ['plan', '规划', '拆解'])) && textIncludesAny(finalText, PLAN_FAILURE_MARKERS)) {
    return { category: 'plan_error', severity: 'medium', reasons: reasons.length ? reasons : ['planning-related weakness'] }
  }
  if (
    results.some((r) => resultLooksLikeAgentError(r.agent, r.text, evidence) && !isDbNoData(r.text))
  ) {
    return { category: 'tool_failure', severity: 'high', reasons: reasons.length ? reasons : ['one or more agent outputs indicate failure'] }
  }
  if (results.length > 0 && !finalText) {
    return { category: 'synthesis_error', severity: 'medium', reasons: reasons.length ? reasons : ['no synthesized final answer'] }
  }
  if (onlySoftDbEmpty) {
    return { category: 'success', severity: 'low', reasons: ['db empty is business outcome'] }
  }

  return { category: 'success', severity: 'low', reasons: reasons.length ? reasons : ['no obvious failure signal'] }
}
