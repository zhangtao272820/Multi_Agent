/**
 * 结果页 / 成功契约（P3-L2）
 * TaskSpec.successCriteria + siteRecipes.resultPageHints → verify 消费
 */

import { z } from 'zod'
import { isResultListUrl } from './lobsterAgent/leanBrowsePolicy'
import { matchSiteRecipe, type ResultPageHints } from './siteRecipes'
import type { LobsterTaskGoals, LobsterTaskKind, LobsterTaskSpec } from './lobsterTaskUnderstandSchema'

export type { ResultPageHints }

export const SuccessCriteriaSchema = z
  .object({
    urlIncludes: z.array(z.string().min(1).max(120)).max(8).optional(),
    urlMatches: z.string().max(200).optional(),
    selectorPresent: z.string().max(160).optional(),
    extractMin: z.number().int().min(0).max(50).optional(),
    /** form_fill：至少成功填写并校验 value 的字段数 */
    filledMin: z.number().int().min(0).max(50).optional(),
    titleIncludes: z.array(z.string().min(1).max(80)).max(6).optional(),
  })
  .passthrough()

export type SuccessCriteria = z.infer<typeof SuccessCriteriaSchema>

/** 网页主路径失败码 SSOT（与总管 agentResult.error_code 对齐） */
export const WEB_FAILURE_CODES = [
  'navigation_unverified',
  'element_not_found',
  'captcha',
  'timeout',
  'network',
  'success_criteria_unmet',
  'step_budget_exceeded',
  'canceled',
] as const

export type WebFailureCode = (typeof WEB_FAILURE_CODES)[number]

const WEB_FAILURE_SET = new Set<string>(WEB_FAILURE_CODES)

export function parseSuccessCriteria(raw: unknown): SuccessCriteria {
  if (!raw) return {}
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return {}
    if (s.startsWith('{')) {
      try {
        return parseSuccessCriteria(JSON.parse(s))
      } catch {
        return {}
      }
    }
    return {}
  }
  if (typeof raw !== 'object') return {}
  const parsed = SuccessCriteriaSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/** 缺 criteria 时按 task_kind / goals 给默认可判定条件 */
export function assembleDefaultSuccessCriteria(input: {
  taskKind?: LobsterTaskKind | string | null
  goals?: LobsterTaskGoals | null
  startUrl?: string
  mustExtract?: boolean
}): SuccessCriteria {
  const kind = String(input.taskKind || '').trim()
  const goals = input.goals || {}
  const mustExtract =
    input.mustExtract === true ||
    goals.must_extract === true ||
    kind === 'extract' ||
    kind === 'search' ||
    kind === 'navigate'
  const out: SuccessCriteria = {}
  // 离开起始页由 goals + navigation_unverified 硬闸；此处只保证「有可判定产物」
  if (mustExtract) out.extractMin = 1
  if (kind === 'form_fill') {
    // 填表成功看 filled 证据，禁止用首页标题凑 extractMin
    out.filledMin = 1
    delete (out as { extractMin?: number }).extractMin
  }
  return out
}

/**
 * 合并：TaskSpec 结构化字段 / JSON 字符串 / recipe hints / 默认值
 */
export function resolveStructuredSuccessCriteria(input: {
  taskSpec?: LobsterTaskSpec | null
  task?: string
  startUrl?: string
  structured?: unknown
}): SuccessCriteria {
  const spec = input.taskSpec
  const startUrl = String(input.startUrl || spec?.start_url || '').trim()
  const recipeHints = resultPageHintsFor(String(input.task || spec?.canonical_task || ''), startUrl)
  const fromSpecField =
    (spec as { successCriteria?: unknown } | null | undefined)?.successCriteria ??
    input.structured
  const fromString = parseSuccessCriteria(spec?.success_criteria || spec?.completion_criteria)
  const fromObject = parseSuccessCriteria(fromSpecField)
  const defaults = assembleDefaultSuccessCriteria({
    taskKind: spec?.task_kind,
    goals: spec?.goals,
    startUrl,
  })
  const mergedObj = mergeSuccessCriteria(
    {
      ...defaults,
      ...fromString,
      ...fromObject,
    },
    recipeHints,
  )
  // 若合并后仍为空对象，至少要求 extractMin=1（避免「点了就算」）；form_fill 用 filledMin
  if (
    !mergedObj.urlIncludes?.length &&
    !mergedObj.urlMatches &&
    !mergedObj.selectorPresent &&
    !mergedObj.titleIncludes?.length &&
    typeof mergedObj.extractMin !== 'number' &&
    typeof mergedObj.filledMin !== 'number'
  ) {
    if (String(spec?.task_kind || '').trim() === 'form_fill') return { filledMin: 1 }
    return { extractMin: 1 }
  }
  if (String(spec?.task_kind || '').trim() === 'form_fill' && typeof mergedObj.filledMin !== 'number') {
    return { ...mergedObj, filledMin: 1, extractMin: undefined }
  }
  return mergedObj
}

/** 将引擎 failureType / verify reason 归一到网页失败码 */
export function normalizeWebFailureCode(raw?: string | null): WebFailureCode | string {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (!s) return 'task_blocked'
  if (WEB_FAILURE_SET.has(s)) return s as WebFailureCode
  if (s === 'network_unreachable' || s.includes('network')) return 'network'
  if (s.includes('captcha')) return 'captcha'
  if (s.includes('element') || s.includes('click_fail') || s === 'no_candidates') return 'element_not_found'
  if (s.includes('timeout') || s.includes('deadline')) return 'timeout'
  if (s.includes('success_criteria') || s.startsWith('success_criteria_missing')) {
    return 'success_criteria_unmet'
  }
  if (s.includes('step_budget') || s.includes('max_steps') || s.includes('incomplete_max')) {
    return 'step_budget_exceeded'
  }
  if (s.includes('navigation_unverified') || s === 'still_on_start') return 'navigation_unverified'
  if (s === 'canceled' || s === 'cancelled') return 'canceled'
  return s
}

export function criteriaIsEmpty(c?: SuccessCriteria | null): boolean {
  if (!c || typeof c !== 'object') return true
  return !(
    (Array.isArray(c.urlIncludes) && c.urlIncludes.length > 0) ||
    Boolean(c.urlMatches) ||
    Boolean(c.selectorPresent) ||
    (Array.isArray(c.titleIncludes) && c.titleIncludes.length > 0) ||
    typeof c.extractMin === 'number' ||
    typeof c.filledMin === 'number'
  )
}

export function mergeSuccessCriteria(
  fromTaskSpec: unknown,
  recipeHints?: ResultPageHints | null,
): SuccessCriteria {
  const base = parseSuccessCriteria(fromTaskSpec)
  if (!recipeHints) return base
  const urlIncludes = [
    ...(Array.isArray(base.urlIncludes) ? base.urlIncludes : []),
    ...(Array.isArray(recipeHints.urlIncludes) ? recipeHints.urlIncludes : []),
  ]
  return {
    ...base,
    urlIncludes: urlIncludes.length ? Array.from(new Set(urlIncludes)).slice(0, 8) : undefined,
    urlMatches: base.urlMatches || recipeHints.urlMatches,
    selectorPresent: base.selectorPresent || recipeHints.listSelector || recipeHints.resultRootSelector,
  }
}

export function resultPageHintsFor(task: string, startUrl?: string): ResultPageHints | null {
  return matchSiteRecipe(task, startUrl)?.resultPageHints || null
}

export function isOnResultPage(url: string, criteria?: SuccessCriteria | null, hints?: ResultPageHints | null): boolean {
  const u = String(url || '')
  if (isResultListUrl(u)) return true
  const includes = [
    ...(Array.isArray(criteria?.urlIncludes) ? criteria!.urlIncludes! : []),
    ...(Array.isArray(hints?.urlIncludes) ? hints!.urlIncludes! : []),
  ]
  if (includes.some((p) => p && u.includes(p))) return true
  const pattern = String(criteria?.urlMatches || hints?.urlMatches || '').trim()
  if (pattern) {
    try {
      if (new RegExp(pattern, 'i').test(u)) return true
    } catch {
      /* invalid pattern */
    }
  }
  return false
}

export function evaluateSuccessCriteria(input: {
  url: string
  title?: string
  extractCount?: number
  filledCount?: number
  selectorHits?: number
  criteria: SuccessCriteria
}): { ok: boolean; reason: string; missing: string[] } {
  const missing: string[] = []
  const c = input.criteria || {}
  if (Array.isArray(c.urlIncludes) && c.urlIncludes.length) {
    const ok = c.urlIncludes.some((p) => String(input.url || '').includes(p))
    if (!ok) missing.push(`urlIncludes:${c.urlIncludes.join('|')}`)
  }
  if (c.urlMatches) {
    try {
      if (!new RegExp(String(c.urlMatches), 'i').test(String(input.url || ''))) {
        missing.push(`urlMatches:${c.urlMatches}`)
      }
    } catch {
      missing.push('urlMatches:invalid')
    }
  }
  if (Array.isArray(c.titleIncludes) && c.titleIncludes.length) {
    const t = String(input.title || '')
    if (!c.titleIncludes.some((p) => t.includes(p))) missing.push(`titleIncludes`)
  }
  if (typeof c.filledMin === 'number' && c.filledMin > 0) {
    if (Math.max(0, Number(input.filledCount || 0)) < c.filledMin) {
      missing.push(`filledMin:${c.filledMin}`)
    }
  }
  if (typeof c.extractMin === 'number' && c.extractMin > 0) {
    if (Math.max(0, Number(input.extractCount || 0)) < c.extractMin) {
      missing.push(`extractMin:${c.extractMin}`)
    }
  }
  if (c.selectorPresent && typeof input.selectorHits === 'number' && input.selectorHits <= 0) {
    missing.push(`selectorPresent:${c.selectorPresent}`)
  }
  if (!missing.length) return { ok: true, reason: 'success_criteria_met', missing: [] }
  return { ok: false, reason: `success_criteria_missing:${missing[0]}`, missing }
}
