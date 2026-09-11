/**
 * A2：专才摘要交接 — 确定性组装，不新堆 LLM。
 * 父会话只消费 summary / evidenceRefs / confidence / failure；全文经 rawRef 按需取。
 */
import type { AgentResult, SpecialistHandoff } from './types'
import { clipHandoffSummary, handoffSummaryMaxChars } from '../../graph/core/shared/promptBudget'
import {
  formatMultimodalStructuredDigest,
  normalizeMultimodalStructured
} from '#agent-shared/multimodalStructuredHandoff'

const RAW_STORE_MAX = 12000

export type HandoffBuildInput = {
  agent: string
  stepId?: string
  ok?: boolean
  output?: string
  error?: string
  agentResult?: AgentResult | null
  evidence?: Record<string, unknown> | null
}

function trimSummary(text: string, max?: number): string {
  const limit =
    typeof max === 'number' && Number.isFinite(max) ? Math.max(40, Math.floor(max)) : handoffSummaryMaxChars()
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}…`
}

function refsFromAgentResult(ar?: AgentResult | null): string[] {
  if (!ar?.sources?.length) return []
  return ar.sources
    .map((s) => {
      const t = String(s?.type || '').trim()
      const r = String(s?.ref || '').trim()
      if (!r) return ''
      return t ? `${t}:${r}` : r
    })
    .filter(Boolean)
    .slice(0, 12)
}

function refsFromEvidence(evidence?: Record<string, unknown> | null): string[] {
  if (!evidence || typeof evidence !== 'object') return []
  const out: string[] = []
  const kind = String(evidence.kind || '').trim()
  const query = String(evidence.query || '').trim()
  if (kind && query) out.push(`${kind}:${query.slice(0, 100)}`)
  else if (kind) out.push(kind)
  const ar = evidence.agentResult as AgentResult | undefined
  out.push(...refsFromAgentResult(ar))
  const citations = evidence.citations
  if (Array.isArray(citations)) {
    for (const c of citations.slice(0, 6)) {
      if (!c || typeof c !== 'object') continue
      const row = c as Record<string, unknown>
      const s = String(row.source || row.title || row.url || '').trim()
      const excerpt = String(row.excerpt || '').trim()
      if (s && excerpt) out.push(`cite:${s.slice(0, 80)}|${excerpt.slice(0, 160)}`)
      else if (s) out.push(`cite:${s.slice(0, 120)}`)
      else if (excerpt) out.push(`cite:excerpt:${excerpt.slice(0, 160)}`)
    }
  }
  return Array.from(new Set(out)).slice(0, 12)
}

function confidenceFromInput(input: HandoffBuildInput): number {
  const ar = input.agentResult
  if (ar && typeof ar.structured?.confidence === 'number') {
    const c = Number(ar.structured.confidence)
    if (Number.isFinite(c)) return Math.min(1, Math.max(0, c))
  }
  if (input.ok === false || input.error) return 0.25
  if (ar?.ok === false) return 0.3
  const out = String(input.output || ar?.answer || '').trim()
  if (!out) return 0.35
  if (out.length < 24) return 0.45
  return 0.75
}

/**
 * 从步结果确定性组装 SpecialistHandoff。
 * 失败时 summary 只用 error_code / 短失败信息，禁止把长 answer（如错域遥测）当结论。
 * 成功时优先步输出 output（含 RAG 事实块），勿被 agentResult.answer=问句盖住。
 */
export function buildSpecialistHandoffFromStep(input: HandoffBuildInput): SpecialistHandoff {
  const agent = String(input.agent || '').trim() || 'unknown'
  const stepId = String(input.stepId || '').trim()
  const ar = input.agentResult
  const stepOutput = String(input.output || '').trim()
  const arAnswer = String(ar?.answer || '').trim()
  // 步输出优先：RAG 旧契约曾把 ar.answer 写成问句，会盖住事实块
  const rawFull = stepOutput || arAnswer
  const err = String(input.error || ar?.error_code || '').trim()
  const failed = input.ok === false || Boolean(err) || ar?.ok === false

  let summary = ''
  if (failed) {
    // 失败：禁止倾倒全文；只用短失败语义
    if (ar?.handoff?.failure?.message) summary = trimSummary(ar.handoff.failure.message, 160)
    if (!summary && err) summary = trimSummary(err, 160)
    if (!summary && ar?.handoff?.summary) summary = trimSummary(ar.handoff.summary, 160)
    if (!summary) summary = `${agent} 未产出可用结论`
  } else {
    if (ar?.handoff?.summary) summary = trimSummary(ar.handoff.summary)
    if (!summary) summary = trimSummary(rawFull)
    if (!summary) summary = `${agent} 已完成`
    // multimodal：把 entities/metrics/OCR 确定性挂进摘要，供下游 dependsOn 消费
    if (agent === 'multimodal') {
      const mm = normalizeMultimodalStructured(ar?.structured)
      const digest = formatMultimodalStructuredDigest(mm, 200)
      if (digest && !summary.includes(digest.slice(0, Math.min(24, digest.length)))) {
        summary = trimSummary(`${summary}｜${digest}`)
      }
    }
  }
  summary = clipHandoffSummary(summary)

  const evidenceRefs = Array.from(
    new Set([
      ...(ar?.handoff?.evidenceRefs || []),
      ...refsFromAgentResult(ar),
      ...refsFromEvidence(input.evidence)
    ])
  ).slice(0, 12)

  const confidence =
    typeof ar?.handoff?.confidence === 'number' && Number.isFinite(ar.handoff.confidence)
      ? Math.min(1, Math.max(0, ar.handoff.confidence))
      : confidenceFromInput(input)

  const failure =
    failed || ar?.handoff?.failure
      ? ar?.handoff?.failure || {
          code: String(ar?.error_code || (failed ? 'step_failed' : 'unknown')).slice(0, 64),
          message: trimSummary(err || summary, 160)
        }
      : undefined

  const rawRef =
    ar?.handoff?.rawRef || (stepId ? `step:${stepId}` : agent ? `agent:${agent}` : undefined)

  return {
    summary,
    evidenceRefs,
    confidence,
    ...(failure ? { failure } : {}),
    ...(rawRef ? { rawRef } : {})
  }
}

/** 父上下文 / synth 用：只拼摘要与证据指针，不含全文；不注入置信度以免用户面鹦鹉学舌 */
export function formatHandoffForParentContext(
  agent: string,
  handoff: SpecialistHandoff,
  opts?: { includeRawHint?: boolean; includeConfidence?: boolean; failureOnly?: boolean }
): string {
  if (opts?.failureOnly && handoff.failure) {
    return [
      `[HANDOFF:${agent}]`,
      `失败：${handoff.failure.code} — ${trimSummary(handoff.failure.message, 160)}`,
      `[/HANDOFF]`
    ].join('\n')
  }
  const lines = [
    `[HANDOFF:${agent}]`,
    `结论：${clipHandoffSummary(handoff.summary)}`,
    opts?.includeConfidence
      ? `置信度：${Math.round(handoff.confidence * 100) / 100}`
      : '',
    handoff.evidenceRefs.length
      ? `证据指针：${handoff.evidenceRefs.slice(0, 8).join(' | ')}`
      : '证据指针：（无）',
    handoff.failure ? `失败：${handoff.failure.code} — ${handoff.failure.message}` : '',
    opts?.includeRawHint && handoff.rawRef ? `原文句柄：${handoff.rawRef}（默认不注入）` : '',
    `[/HANDOFF]`
  ]
  return lines.filter(Boolean).join('\n')
}

/** 从 evidence 列表抽取 handoff 块供 synth（跳过超长 raw；error 步只输出失败行） */
export function formatHandoffsFromEvidence(evidences: Array<Record<string, unknown>>): string {
  const blocks: string[] = []
  for (const ev of Array.isArray(evidences) ? evidences : []) {
    if (!ev || typeof ev !== 'object') continue
    const handoff = ev.handoff as SpecialistHandoff | undefined
    const agent = String(ev.agent || ev.kind || '').trim()
    if (!handoff || !agent) continue
    const isError = String(ev.kind || '') === 'error'
    if (isError) {
      if (!handoff.failure) continue
      blocks.push(formatHandoffForParentContext(agent, handoff, { failureOnly: true }))
      continue
    }
    if (!handoff.summary) continue
    blocks.push(formatHandoffForParentContext(agent, handoff))
  }
  return blocks.join('\n\n')
}

/** 可选：把 raw 截断存进 evidence，供「查看原文」；默认不进父 prompt */
export function attachRawSnippetForEvidence(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.length > RAW_STORE_MAX ? `${s.slice(0, RAW_STORE_MAX)}…` : s
}

/** 断言：父上下文字符串不应含超长 crawler/SQL 全文（用于 smoke） */
export function parentContextLooksIsolated(text: string, maxChunk = 800): boolean {
  const s = String(text || '')
  if (s.includes('[HANDOFF:') && s.length > 4000) {
    const parts = s.split('[HANDOFF:')
    for (const p of parts.slice(1)) {
      const body = p.split('[/HANDOFF]')[0] || ''
      if (body.length > maxChunk) return false
    }
  }
  return true
}
