/**
 * B2 Prompt / 上下文预算层 — Rules / Skill / Obs / Handoff 分块硬截断。
 * 确定性 clip；不为省钱 silent fallback 到 regex 路由。
 * G3：Observation 摘要入模前走 redactObservation（去密钥 + 截断）。
 */

import { redactObservation } from '#agent-shared/redact'

export function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function promptBudgetRulesChars(): number {
  return envInt('MANAGER_PROMPT_BUDGET_RULES_CHARS', 2000, 400, 8000)
}

export function promptBudgetSkillChars(): number {
  return envInt('MANAGER_PROMPT_BUDGET_SKILL_CHARS', 2500, 400, 12000)
}

export function obsSummaryMaxChars(): number {
  return envInt('MANAGER_OBS_SUMMARY_MAX_CHARS', 400, 80, 2000)
}

export function obsKeepLast(): number {
  return envInt('MANAGER_OBS_KEEP_LAST', 4, 1, 20)
}

export function handoffSummaryMaxChars(): number {
  return envInt('MANAGER_HANDOFF_SUMMARY_MAX_CHARS', 600, 120, 2000)
}

/** 软字符截断（按字符，非 tokenizer） */
export function clipChars(text: string, max: number): string {
  const s = String(text || '')
  if (max <= 0) return ''
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

export function clipRulesBlock(text: string): string {
  return clipChars(text, promptBudgetRulesChars())
}

export function clipSkillBlock(text: string): string {
  return clipChars(text, promptBudgetSkillChars())
}

export function clipObsSummary(text: string): string {
  const max = obsSummaryMaxChars()
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  return redactObservation(cleaned, max)
}

export function clipHandoffSummary(text: string): string {
  return clipChars(String(text || '').replace(/\s+/g, ' ').trim(), handoffSummaryMaxChars())
}

/** 父上下文只保留最近 N 条 Observation 摘要 */
export function keepLastObservations<T>(rows: T[], n = obsKeepLast()): T[] {
  const list = Array.isArray(rows) ? rows : []
  const keep = Math.max(1, n)
  if (list.length <= keep) return list
  return list.slice(list.length - keep)
}

export type PromptBudgetSnapshot = {
  rulesChars: number
  skillChars: number
  obsSummaryChars: number
  obsKeepLast: number
  handoffSummaryChars: number
}

export function promptBudgetSnapshot(): PromptBudgetSnapshot {
  return {
    rulesChars: promptBudgetRulesChars(),
    skillChars: promptBudgetSkillChars(),
    obsSummaryChars: obsSummaryMaxChars(),
    obsKeepLast: obsKeepLast(),
    handoffSummaryChars: handoffSummaryMaxChars()
  }
}
