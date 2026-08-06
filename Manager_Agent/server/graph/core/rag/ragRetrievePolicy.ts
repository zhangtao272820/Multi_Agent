import { shouldSkipRagEvidenceSelect } from './ragPrefetch'

export type RagRetrieveAttemptMode = 'default' | 'relaxed'

/**
 * 是否用 retrieve/probe 事实块作为终答快路径。
 * 默认关闭：与独立文档助手一致，主路径走 /api/chat；设 1 可恢复旧 retrieve-first。
 */
export function isManagerRagRetrieveFirstEnabled(): boolean {
  return String(process.env.MANAGER_RAG_RETRIEVE_FIRST ?? '0').trim() === '1'
}

export function ragRetrieveCallOptions(mode: RagRetrieveAttemptMode, probeHits: number) {
  if (mode === 'relaxed') {
    return { skipLlmRerank: false, skipEvidenceSelect: shouldSkipRagEvidenceSelect() }
  }
  const probeAligned = probeHits > 0
  return {
    skipLlmRerank: probeAligned,
    skipEvidenceSelect: probeAligned || shouldSkipRagEvidenceSelect()
  }
}

const RAG_MISS_MARKERS = [
  '暂未找到',
  '未检索到',
  '知识库检索未找到',
  '未找到相关',
  '查不到',
  '无法进行后续分析',
  '未找到相关背景信息',
  'RAG_NEEDS_CLARIFY',
  '【需要补充信息】'
] as const

/** 文本是否表达「未命中」（子串匹配，不用正则） */
export function textIndicatesRagMiss(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  const lower = t.toLowerCase()
  for (const m of RAG_MISS_MARKERS) {
    if (lower.includes(m.toLowerCase())) return true
  }
  return false
}

export function ragEvidenceUnitCount(
  evidence: Record<string, unknown> | null | undefined,
  probeHits = 0
): number {
  let units = Number(evidence?.hits ?? 0) || 0
  if (Array.isArray(evidence?.citations)) units += evidence.citations.length
  if (Array.isArray(evidence?.sources)) units += evidence.sources.length
  if (units === 0 && probeHits > 0) units = probeHits
  return units
}

/** 有 evidence 时不应判为 miss（防假阴性） */
export function shouldTreatRagAsMiss(text: string, evidenceUnits: number): boolean {
  if (evidenceUnits > 0) return false
  return textIndicatesRagMiss(text)
}

/** 有 citations/hits 且回答非空时，跳过相关性裁判重试（防 judge 假阴性） */
export function shouldSkipRagRelevanceRefine(
  evidence: Record<string, unknown> | null | undefined,
  answer: string
): boolean {
  const units = ragEvidenceUnitCount(evidence)
  if (units === 0) return false
  const ans = String(answer || '').trim()
  if (ans.length < 20) return false
  if (textIndicatesRagMiss(ans)) return false
  return true
}

/** 裁判判不相关但有 evidence 时，保留原回答 */
export function ragJudgeFalseNegativeOverride(
  verdict: { relevant?: boolean; complete?: boolean },
  evidence: Record<string, unknown> | null | undefined,
  answer: string
): boolean {
  if (verdict.relevant !== false) return false
  const units = ragEvidenceUnitCount(evidence)
  if (units === 0) return false
  return String(answer || '').trim().length >= 32
}
