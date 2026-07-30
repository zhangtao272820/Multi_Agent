import type { AgentResult } from '../../../utils/agents/types'
import { wrapAdminResult } from '../../../utils/agents/agentResult'
import { looksLikeNetworkFailure } from '#agent-shared/lobsterRunVerifyLite'

function collapse(text: string, max = 900): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** 本轮是否已有成功的 admin 写操作证据（日程/提醒等） */
export function hasSuccessfulAdminWriteInRun(input: {
  results?: Record<string, unknown> | null
  evidence?: Array<Record<string, unknown>> | null
}): boolean {
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const results = input.results && typeof input.results === 'object' ? input.results : {}
  const adminOut = String((results as any)?.admin || '').trim()
  const hasFailedAdminEvidence = evidence.some(
    (e) =>
      String(e?.kind || '') === 'admin' &&
      ((e?.agentResult as AgentResult | undefined)?.ok === false || e?.failed === true)
  )
  if (hasFailedAdminEvidence) return false
  const okEvidence = evidence.some((e) => {
    if (String(e?.kind || '') !== 'admin') return false
    if (e?.failed === true) return false
    const ar = e?.agentResult as AgentResult | undefined
    if (ar && ar.ok === false) return false
    return true
  })
  if (okEvidence && adminOut) {
    const wrapped = wrapAdminResult(adminOut)
    return wrapped.ok === true
  }
  if (adminOut) {
    const wrapped = wrapAdminResult(adminOut)
    return wrapped.ok === true
  }
  return okEvidence
}

/** 本轮是否已有成功的 admin 只读结论（天气/路线等，非待确认写） */
export function hasSuccessfulAdminReadInRun(input: {
  results?: Record<string, unknown> | null
  evidence?: Array<Record<string, unknown>> | null
}): boolean {
  if (hasSuccessfulAdminWriteInRun(input)) return true
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const results = input.results && typeof input.results === 'object' ? input.results : {}
  const adminOut = String((results as any)?.admin || '').trim()
  if (!adminOut || /【待确认】|未能完成写操作|协议异常|未确认，未写入/i.test(adminOut)) return false
  const failed = evidence.some(
    (e) =>
      String(e?.kind || '') === 'admin' &&
      (e?.failed === true || (e?.agentResult as AgentResult | undefined)?.ok === false)
  )
  if (failed) return false
  const wrapped = wrapAdminResult(adminOut)
  return wrapped.ok === true && adminOut.length >= 8
}

/**
 * 本轮 GUI 是否任务目标已达成（须 agentResult.ok===true）。
 * 仅有 finalUrl / 截图 / 首页文案不算成功（打开≠完成点击/抽取）。
 */
export function hasSuccessfulGuiBrowseInRun(input: {
  results?: Record<string, unknown> | null
  evidence?: Array<Record<string, unknown>> | null
}): boolean {
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const results = input.results && typeof input.results === 'object' ? input.results : {}
  const guiOut = String((results as any)?.gui || '').trim()
  if (/GUI 自动化失败|lobster_workflow_not_found|仍停留在起始页|navigation_unverified/i.test(guiOut)) {
    return false
  }
  if (looksLikeNetworkFailure(guiOut)) return false

  for (const e of evidence) {
    if (String(e?.kind || '') !== 'gui') continue
    if (e?.failed === true) continue
    const ar = e?.agentResult as AgentResult | undefined
    if (!ar || ar.ok !== true) continue
    if (looksLikeNetworkFailure(ar.answer || '')) continue
    const errCode = String(ar.error_code || (ar as any)?.structured?.failureType || '').trim()
    if (
      /^(navigation_unverified|incomplete_|search_no_results|search_extract_empty|empty_result|network)/i.test(
        errCode,
      )
    ) {
      continue
    }
    const finalUrl = String(
      e?.finalUrl || (ar as any)?.structured?.finalUrl || '',
    ).trim()
    const answer = String(ar.answer || guiOut).trim()
    // 成功：ok=true 且有实质产物（URL 或可读 answer）；items=0 仍可算成功
    if (finalUrl.startsWith('http') || answer.length >= 12 || Number(e?.itemCount || 0) > 0) {
      return true
    }
    if (Array.isArray(ar.sources) && ar.sources.length > 0) return true
  }

  return false
}

/** 为 Critic 审计构造「本轮证据」摘要（rag/db/crawler/admin/code 等） */
export function formatEvidenceForCriticAudit(input: {
  evidence?: Array<Record<string, unknown>>
  results?: Record<string, unknown>
  maxChars?: number
}): string {
  const maxChars = input.maxChars ?? 4200
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const results = input.results && typeof input.results === 'object' ? input.results : {}
  const lines: string[] = []
  const seen = new Set<string>()

  for (const e of evidence.slice(0, 10)) {
    const kind = String(e?.kind || '').trim()
    if (!kind || seen.has(kind)) continue
    seen.add(kind)
    if (kind === 'rag') {
      const citations = Array.isArray(e?.citations) ? e.citations : []
      const cites = citations
        .slice(0, 5)
        .map((c: any) => String(c?.source || c?.title || c?.url || '').trim())
        .filter(Boolean)
      const hits = Number(e?.hits) || 0
      lines.push(`rag：hits=${hits}；引用=${cites.join(' | ') || '（见子输出）'}`)
      const ragOut = collapse(String(results.rag ?? ''), 1000)
      if (ragOut) lines.push(`rag 子输出：${ragOut}`)
    } else if (kind === 'db') {
      lines.push(
        `db：query=${collapse(String(e?.query ?? ''), 120)}；empty=${Boolean(e?.empty)}；run_id=${String(e?.run_id ?? '')}`
      )
      const dbOut = collapse(String(results.db ?? ''), 1000)
      if (dbOut) lines.push(`db 子输出：${dbOut}`)
    } else if (kind === 'crawler') {
      const items = Array.isArray(e?.items) ? e.items : []
      const urls = items
        .slice(0, 4)
        .map((it: any) => String(it?.url || '').trim())
        .filter((u: string) => u.startsWith('http'))
      lines.push(`crawler：items=${items.length}；urls=${urls.join(' | ') || 'n/a'}`)
      const crawlerOut = collapse(String(results.crawler ?? ''), 800)
      if (crawlerOut) lines.push(`crawler 子输出：${crawlerOut}`)
    } else if (kind === 'gui') {
      const guiOut = collapse(String(results.gui ?? ''), 1000)
      const ar = e?.agentResult as AgentResult | undefined
      const finalUrl = String(
        e?.finalUrl || (ar as any)?.structured?.finalUrl || ''
      ).trim()
      const ok = e?.failed !== true && ar?.ok !== false
      const itemCount = Number(e?.itemCount || 0)
      const hasShot = e?.hasScreenshot === true
      const src = (ar?.sources || [])
        .slice(0, 3)
        .map((s) => String((s as any)?.ref || (s as any)?.url || (s as any)?.title || '').trim())
        .filter(Boolean)
      lines.push(
        `gui：ok=${ok ? 'yes' : 'no'}；finalUrl=${finalUrl || 'n/a'}；items=${itemCount}${hasShot ? '；hasScreenshot=yes' : ''}${src.length ? `；sources=${src.join(' | ')}` : ''}`
      )
      lines.push(
        '（说明：GUI 成功须 agentResult.ok=true 且完成任务目标；仅有首页 finalUrl/截图不算成功；items=0 不单独否定成功）'
      )
      if (guiOut) lines.push(`gui 子输出：${guiOut}`)
    } else if (kind === 'code') {
      lines.push(`code：threadId=${String(e?.threadId ?? '')}`)
      const codeOut = collapse(String(results.code ?? ''), 800)
      if (codeOut) lines.push(`code 子输出：${codeOut}`)
    } else if (kind === 'admin') {
      const ar = e?.agentResult as AgentResult | undefined
      const ok = ar?.ok !== false && e?.failed !== true
      const pendingDecide = Boolean(e?.pendingDecide)
      lines.push(
        `admin：ok=${ok ? 'yes' : 'no'}；pendingDecide=${pendingDecide ? 'yes' : 'no'}；query=${collapse(String(e?.query ?? ''), 120)}`
      )
      const adminOut = collapse(String(results.admin ?? ''), 1000)
      if (adminOut) lines.push(`admin 子输出：${adminOut}`)
    } else {
      lines.push(`${kind}：（已记录 evidence）`)
    }
  }

  for (const key of ['rag', 'db', 'crawler', 'gui', 'code', 'clean', 'visualize', 'report', 'admin'] as const) {
    if (seen.has(key)) continue
    const out = collapse(String(results[key] ?? ''), 600)
    if (out) lines.push(`${key} 子输出（无独立 evidence 行）：${out}`)
  }

  const arRows = evidence
    .map((e) => e?.agentResult as AgentResult | undefined)
    .filter((ar): ar is AgentResult => Boolean(ar?.agent))
  for (const ar of arRows.slice(0, 4)) {
    const src = (ar.sources || [])
      .slice(0, 3)
      .map((s) => String(s?.title || s?.url || '').trim())
      .filter(Boolean)
    if (src.length) lines.push(`${ar.agent} AgentResult.sources：${src.join(' | ')}`)
  }

  const body = lines.join('\n').trim()
  return body ? body.slice(0, maxChars) : '（本轮尚无结构化 evidence；仅可依据拟回答本身审计）'
}

export function formatEvaluatorForCriticAudit(evaluation: Record<string, unknown> | null | undefined): string {
  if (!evaluation || typeof evaluation !== 'object') return '评估器：（未运行）'
  const score = Number(evaluation.score ?? 0)
  const rec = String(evaluation.recommendation ?? '')
  const dataEv = Boolean(evaluation.hasDataEvidence)
  const implicit = Boolean(evaluation.hasImplicitDataEvidence)
  return `评估器：score=${score.toFixed(2)}；dataEvidence=${dataEv ? 'yes' : 'no'}；implicitData=${implicit ? 'yes' : 'no'}；recommend=${rec || 'n/a'}`
}

/**
 * Critic 要求重试，但评估器已确认本轮有数据依据且质量可接受 → 忽略改道重试。
 * 与 agent 类型无关（rag/db/crawler 等均适用）。
 */
export function criticRetryContradictsRunEvidence(input: {
  evaluation?: Record<string, unknown> | null
  minScore?: number
}): boolean {
  const score = Number(input.evaluation?.score ?? 0)
  const minScore = input.minScore ?? 0.8
  const hasData =
    Boolean(input.evaluation?.hasDataEvidence) || Boolean(input.evaluation?.hasImplicitDataEvidence)
  const rec = String(input.evaluation?.recommendation ?? '')
  if (!hasData || score < minScore) return false
  if (rec === 'clarify' || rec === 'retry') return false
  return true
}
