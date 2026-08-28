/**
 * Code 下游一致性审计（结构层）：孤儿数字、报告 evidence 引用。
 * LLM 审计见 managerCodeAuthorityLlm.assessCodeDownstreamConsistencyByLlm。
 */

import { extractAuxBlocksStructural } from './auxBlocks'
import type { ExtractPayloadFn } from './codeFirstAuthority'
import type { CodeAuthorityPayload, CodeDownstreamConsistencyResult } from './codeAuthorityPayload'
import { isMultiSourceDataPipeline } from './dbPipelineDeterministic'

/** 孤儿数字审计只看叙事 prose；ECHARTS/REPORT 块内样式常数（fontSize/top 等）不得当业务数 */
export function stripDownstreamAuxBlocksForOrphanAudit(text: string): string {
  return extractAuxBlocksStructural(String(text ?? '')).narrative.trim()
}

function coerceChartNumericValue(value: unknown, display?: string): { value: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { value }
  const s = String(display ?? value ?? '').trim()
  if (!s) return null
  if (/^\d+:\d+$/.test(s)) {
    const tail = Number(s.split(':').pop())
    return Number.isFinite(tail) ? { value: tail } : null
  }
  if (s.includes('%') || s.includes('％')) {
    const n = Number(s.replace(/[%％]/g, ''))
    return Number.isFinite(n) ? { value: n } : null
  }
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? { value: n } : null
}

function walkNumbers(value: unknown, out: number[], depth = 0): void {
  if (depth > 6) return
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value)
    return
  }
  if (typeof value === 'string') {
    const c = coerceChartNumericValue(value, value)
    if (c) out.push(c.value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkNumbers(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) walkNumbers(v, out, depth + 1)
  }
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** 从 db/crawler/clean/rag/code/admin 收集可比对数值（结构化 facts + 散文显著数字） */
export function collectUpstreamEvidenceNumbers(
  results: Record<string, unknown>,
  extractPayload?: ExtractPayloadFn
): Set<number> {
  const out = new Set<number>()
  const add = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return
    out.add(n)
    out.add(Math.round(n * 100) / 100)
  }
  const agents = ['db', 'rag', 'crawler', 'clean', 'code', 'admin', 'gui'] as const
  for (const agent of agents) {
    const raw = String(results[agent] ?? '').trim()
    if (!raw) continue
    if (extractPayload) {
      const parsed = extractPayload(raw)
      const facts = Array.isArray(parsed.facts) ? parsed.facts : []
      for (const f of facts) {
        const c = coerceChartNumericValue(f.value, String(f.value ?? ''))
        if (c) add(c.value)
        else add(coerceFiniteNumber(f.value))
      }
      const buf: number[] = []
      walkNumbers(parsed.data, buf)
      for (const n of buf) add(n)
      const answer = String(parsed.answer ?? '').trim()
      if (answer) {
        for (const n of extractSignificantNumbers(answer)) add(n)
      }
    }
    const buf: number[] = []
    walkNumbers(raw, buf)
    for (const n of buf) add(n)
    // 散文/Markdown 表格：整串 coerce 拿不到多数字，须扫描显著数值
    for (const n of extractSignificantNumbers(raw)) add(n)
  }
  return out
}

/**
 * 多取数源（db/rag/crawler≥2）跳过结构孤儿硬门禁，改由 LLM 审计。
 * 常见 db→code 单管道不 skip：靠 collectUpstreamEvidenceNumbers 把上游散文数字并入 extraAllowed，
 * 合法引用上游数不误伤；捏造数仍 fail。
 */
export function shouldSkipStructuralOrphanAudit(results?: Record<string, unknown> | null): boolean {
  if (!results || typeof results !== 'object') return false
  return isMultiSourceDataPipeline(results)
}

/** 从 Code facts/data 收集可比对数值集合（含 display 变体） */
export function collectCodeAuthorityNumbers(payload: CodeAuthorityPayload): Set<number> {
  const out = new Set<number>()
  const add = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return
    out.add(n)
    out.add(Math.round(n * 100) / 100)
    if (Math.abs(n) > 0 && Math.abs(n) < 1) {
      out.add(Math.round(n * 10000) / 100)
      out.add(Math.round(n * 100000) / 1000)
    }
  }

  for (const f of payload.facts) {
    const c = coerceChartNumericValue(f.value, String(f.value ?? ''))
    if (c) add(c.value)
    else add(coerceFiniteNumber(f.value))
  }
  const buf: number[] = []
  walkNumbers(payload.data, buf)
  for (const n of buf) add(n)

  return out
}

function numberMatchesAllowed(n: number, allowed: Set<number>, tolerance: number): boolean {
  if (!Number.isFinite(n)) return true
  if (allowed.has(n)) return true
  for (const a of allowed) {
    if (Math.abs(a - n) <= tolerance) return true
    if (Math.abs(a) <= 1 && Math.abs(a * 100 - n) <= tolerance) return true
    if (Math.abs(n) <= 1 && Math.abs(a - n * 100) <= tolerance) return true
  }
  return false
}

function shouldAuditNumber(n: number): boolean {
  if (!Number.isFinite(n)) return false
  const abs = Math.abs(n)
  if (abs < 0.001) return false
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return false
  if (Number.isInteger(n) && abs <= 1) return false
  return abs >= 2 || !Number.isInteger(n)
}

/** 从 Markdown / 表格 / 正文提取显著数值（仅用于 chart/report 块校验） */
export function extractSignificantNumbers(text: string): number[] {
  const raw = String(text ?? '')
  const out: number[] = []
  const re = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const s = m[1]!.replace(/,/g, '')
    const n = Number(s)
    if (Number.isFinite(n) && shouldAuditNumber(n)) out.push(n)
  }
  return out
}

export function findOrphanNumbers(
  text: string,
  payload: CodeAuthorityPayload,
  extraAllowed?: Set<number>
): number[] {
  const allowed = collectCodeAuthorityNumbers(payload)
  if (extraAllowed?.size) {
    for (const n of extraAllowed) allowed.add(n)
  }
  if (!allowed.size) return []
  const orphans: number[] = []
  for (const n of extractSignificantNumbers(text)) {
    const tol = Math.max(0.01, Math.abs(n) * 0.002)
    if (!numberMatchesAllowed(n, allowed, tol)) orphans.push(n)
  }
  return [...new Set(orphans.map((x) => Math.round(x * 100) / 100))]
}

export function assessDownstreamOrphanNumbers(
  payload: CodeAuthorityPayload,
  texts: string[],
  opts?: { extraAllowed?: Set<number> }
): CodeDownstreamConsistencyResult {
  const combined = texts
    .filter(Boolean)
    .map((t) => stripDownstreamAuxBlocksForOrphanAudit(t))
    .filter(Boolean)
    .join('\n')
  if (!combined.trim()) return { pass: true }
  const orphans = findOrphanNumbers(combined, payload, opts?.extraAllowed)
  if (!orphans.length) return { pass: true }
  return {
    pass: false,
    reason: `下游出现 Code 中不存在的数字：${orphans.slice(0, 4).join('、')}${orphans.length > 4 ? '…' : ''}`,
    retryIntent: combined.includes('ECHARTS_OPTION') ? 'visualize' : 'report'
  }
}
