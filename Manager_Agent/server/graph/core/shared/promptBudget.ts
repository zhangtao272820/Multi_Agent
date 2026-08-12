/**
 * B2 Prompt / 上下文预算层 — Rules / Skill / Obs / Handoff 分块硬截断。
 * W4：优先按 token 预算裁剪（shared/tokenEstimate）；失败回退字符预算。
 * G3：Observation 摘要入模前走 redactObservation（去密钥 + 截断）。
 */

import { redactObservation } from '#agent-shared/redact'
import { clipToTokenBudget, estimateTokensSync } from '#agent-shared/tokenEstimate'

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

/** Synth / Critic 等 SystemMessage 软上限（字符）；超限应拆 profile 而非 silent 截断正文语义 */
export function promptBudgetSystemChars(): number {
  return envInt('MANAGER_PROMPT_BUDGET_SYSTEM_CHARS', 5200, 1200, 16000)
}

/** Token 预算（未设则由 chars≈tokens*4 推导） */
export function promptBudgetRulesTokens(): number {
  const explicit = process.env.MANAGER_PROMPT_BUDGET_RULES_TOKENS
  if (explicit != null && String(explicit).trim() !== '') {
    return envInt('MANAGER_PROMPT_BUDGET_RULES_TOKENS', 500, 80, 4000)
  }
  return Math.max(80, Math.ceil(promptBudgetRulesChars() / 4))
}

export function promptBudgetSkillTokens(): number {
  const explicit = process.env.MANAGER_PROMPT_BUDGET_SKILL_TOKENS
  if (explicit != null && String(explicit).trim() !== '') {
    return envInt('MANAGER_PROMPT_BUDGET_SKILL_TOKENS', 600, 80, 6000)
  }
  return Math.max(80, Math.ceil(promptBudgetSkillChars() / 4))
}

export function obsSummaryMaxTokens(): number {
  const explicit = process.env.MANAGER_OBS_SUMMARY_MAX_TOKENS
  if (explicit != null && String(explicit).trim() !== '') {
    return envInt('MANAGER_OBS_SUMMARY_MAX_TOKENS', 100, 20, 800)
  }
  return Math.max(20, Math.ceil(obsSummaryMaxChars() / 4))
}

export function useTokenPromptBudget(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_PROMPT_BUDGET_TOKEN_MODE ?? '1').trim() !== '0'
}

export function assertSystemPromptWithinBudget(text: string, context: string): void {
  const max = promptBudgetSystemChars()
  const n = String(text || '').length
  if (n > max) {
    throw new Error(`${context}: system prompt ${n} chars exceeds budget ${max}`)
  }
}

/**
 * 运行时软守卫：超预算只 warn，不截断语义（避免 silent 砍规则）。
 * @returns true 表示在预算内
 */
export function warnIfSystemPromptOverBudget(text: string, context: string): boolean {
  const max = promptBudgetSystemChars()
  const n = String(text || '').length
  if (n <= max) return true
  console.warn(`[promptBudget] ${context}: system prompt ${n} chars exceeds budget ${max} (not truncated)`)
  return false
}

/** 软字符截断（按字符，非 tokenizer） */
export function clipChars(text: string, max: number): string {
  const s = String(text || '')
  if (max <= 0) return ''
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

function clipByBudget(text: string, maxChars: number, maxTokens: number): string {
  if (!useTokenPromptBudget()) return clipChars(text, maxChars)
  const byTok = clipToTokenBudget(text, maxTokens)
  // 再套字符硬顶，防止估计偏差撑爆
  return clipChars(byTok.text, maxChars)
}

export function clipRulesBlock(text: string): string {
  return clipByBudget(text, promptBudgetRulesChars(), promptBudgetRulesTokens())
}

export function clipSkillBlock(text: string): string {
  return clipByBudget(text, promptBudgetSkillChars(), promptBudgetSkillTokens())
}

export function clipObsSummary(text: string): string {
  const maxChars = obsSummaryMaxChars()
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  const redacted = redactObservation(cleaned, maxChars)
  return clipByBudget(redacted, maxChars, obsSummaryMaxTokens())
}

export function clipHandoffSummary(text: string): string {
  const maxChars = handoffSummaryMaxChars()
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  const maxTok = Math.max(40, Math.ceil(maxChars / 4))
  return clipByBudget(cleaned, maxChars, maxTok)
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
  systemChars: number
  rulesTokens: number
  skillTokens: number
  obsSummaryTokens: number
  tokenMode: boolean
}

export function promptBudgetSnapshot(): PromptBudgetSnapshot {
  return {
    rulesChars: promptBudgetRulesChars(),
    skillChars: promptBudgetSkillChars(),
    obsSummaryChars: obsSummaryMaxChars(),
    obsKeepLast: obsKeepLast(),
    handoffSummaryChars: handoffSummaryMaxChars(),
    systemChars: promptBudgetSystemChars(),
    rulesTokens: promptBudgetRulesTokens(),
    skillTokens: promptBudgetSkillTokens(),
    obsSummaryTokens: obsSummaryMaxTokens(),
    tokenMode: useTokenPromptBudget(),
  }
}

export function estimatePromptTokens(text: string): ReturnType<typeof estimateTokensSync> {
  return estimateTokensSync(text)
}
