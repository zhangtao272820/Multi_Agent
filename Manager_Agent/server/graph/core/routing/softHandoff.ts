/**
 * 跨 Agent 软交接（softHandoff）：步进摘要标准化，供 continuation 剪枝与下游依赖注入。
 * 确定性组装，不新开 LLM；不改变 cap / 单源透传契约。
 */
import type { SpecialistHandoff } from '../../../utils/agents/types'
import {
  buildSpecialistHandoffFromStep,
  formatHandoffForParentContext,
  type HandoffBuildInput
} from '../../../utils/agents/specialistHandoff'
import { clipHandoffSummary } from '../shared/promptBudget'

export type SoftHandoffRecord = {
  stepId: string
  agent: string
  summary: string
  evidenceRefs: string[]
  confidence: number
  failure?: { code: string; message: string }
  rawRef?: string
  /** 可选：上游 taskForm（观察用，不改路由） */
  taskForm?: string
  at: string
}

export function buildSoftHandoffFromStep(
  input: HandoffBuildInput & { taskForm?: string }
): SoftHandoffRecord {
  const handoff = buildSpecialistHandoffFromStep(input)
  const stepId = String(input.stepId || '').trim() || `agent:${String(input.agent || 'unknown')}`
  const agent = String(input.agent || '').trim() || 'unknown'
  const taskForm = String(input.taskForm || '').trim().slice(0, 40)
  return {
    stepId,
    agent,
    summary: clipHandoffSummary(handoff.summary),
    evidenceRefs: [...(handoff.evidenceRefs || [])].slice(0, 12),
    confidence: handoff.confidence,
    ...(handoff.failure ? { failure: handoff.failure } : {}),
    ...(handoff.rawRef ? { rawRef: handoff.rawRef } : {}),
    ...(taskForm ? { taskForm } : {}),
    at: new Date().toISOString()
  }
}

export function softHandoffToSpecialist(h: SoftHandoffRecord): SpecialistHandoff {
  return {
    summary: h.summary,
    evidenceRefs: h.evidenceRefs,
    confidence: h.confidence,
    ...(h.failure ? { failure: h.failure } : {}),
    ...(h.rawRef ? { rawRef: h.rawRef } : {})
  }
}

/** continuation 编排 Human：只拼锚点级软交接，禁止整段历史 */
export function formatSoftHandoffsForContinuation(
  records: SoftHandoffRecord[] | null | undefined,
  max = 3
): string {
  const rows = (Array.isArray(records) ? records : []).slice(-Math.max(1, max))
  if (!rows.length) return ''
  const blocks = rows.map((r) =>
    formatHandoffForParentContext(r.agent, softHandoffToSpecialist(r))
  )
  return ['【上轮软交接·不得扩 allowedAgents】', ...blocks].join('\n')
}

export function softHandoffsFromMeta(meta: unknown): SoftHandoffRecord[] {
  if (!meta || typeof meta !== 'object') return []
  const bag = (meta as { softHandoffs?: unknown }).softHandoffs
  if (!Array.isArray(bag)) return []
  const out: SoftHandoffRecord[] = []
  for (const row of bag) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const agent = String(r.agent || '').trim()
    const summary = String(r.summary || '').trim()
    if (!agent && !summary) continue
    out.push({
      stepId: String(r.stepId || '').trim() || `agent:${agent || 'unknown'}`,
      agent: agent || 'unknown',
      summary: clipHandoffSummary(summary),
      evidenceRefs: Array.isArray(r.evidenceRefs)
        ? r.evidenceRefs.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
        : [],
      confidence: Number.isFinite(Number(r.confidence)) ? Math.min(1, Math.max(0, Number(r.confidence))) : 0.5,
      ...(r.failure && typeof r.failure === 'object'
        ? {
            failure: {
              code: String((r.failure as { code?: unknown }).code || 'unknown').slice(0, 64),
              message: String((r.failure as { message?: unknown }).message || '').slice(0, 160)
            }
          }
        : {}),
      ...(r.rawRef ? { rawRef: String(r.rawRef).slice(0, 80) } : {}),
      ...(r.taskForm ? { taskForm: String(r.taskForm).slice(0, 40) } : {}),
      at: String(r.at || '').trim() || new Date().toISOString()
    })
  }
  return out.slice(-12)
}

/** 合并本轮步进 softHandoff 到 meta 列表（保序去重 by stepId） */
export function mergeSoftHandoffsIntoMeta(
  meta: Record<string, unknown> | null | undefined,
  next: SoftHandoffRecord | SoftHandoffRecord[]
): SoftHandoffRecord[] {
  const prior = softHandoffsFromMeta(meta)
  const add = Array.isArray(next) ? next : [next]
  const byId = new Map<string, SoftHandoffRecord>()
  for (const r of [...prior, ...add]) {
    byId.set(r.stepId, r)
  }
  return Array.from(byId.values()).slice(-12)
}

/** 依赖步 → 结构化 softHandoff 摘要（供 internal payload） */
export function formatDependencySoftHandoffs(
  deps: Array<{
    id?: string
    agent?: string
    summary?: string
    evidenceRefs?: string[]
    confidence?: number
    failure?: { code?: string; message?: string }
    rawRef?: string
  }>
): string {
  const records: SoftHandoffRecord[] = (Array.isArray(deps) ? deps : [])
    .map((d) => ({
      stepId: String(d.id || '').trim() || `agent:${String(d.agent || 'unknown')}`,
      agent: String(d.agent || 'unknown').trim() || 'unknown',
      summary: clipHandoffSummary(String(d.summary || '')),
      evidenceRefs: Array.isArray(d.evidenceRefs) ? d.evidenceRefs.map(String).slice(0, 8) : [],
      confidence: Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : 0.5,
      ...(d.failure?.code
        ? { failure: { code: String(d.failure.code), message: String(d.failure.message || '') } }
        : {}),
      ...(d.rawRef ? { rawRef: String(d.rawRef) } : {}),
      at: new Date().toISOString()
    }))
    .filter((r) => r.summary)
  return formatSoftHandoffsForContinuation(records, 5)
}
