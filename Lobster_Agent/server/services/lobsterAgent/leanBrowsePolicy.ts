/**
 * OpenClaw 对齐 · 精简浏览策略（少步、DOM/snapshot 优先、视觉兜底）
 * 参考：https://docs.openclaw.ai/tools/browser — snapshot → act → re-snapshot，非每步 OCR/截图多模态。
 */

import { baiduNeedsDirectSearch, baiduSearchUrl, isBaiduHost } from './taskLoginIntent'

export type LeanBrowseKind = 'search_extract' | 'search_open' | 'video' | 'form' | 'general'

export function extractSearchQueryFromTask(task: string): string {
  const t = String(task || '')
  const quotedCn = t.match(/\u300c([^\u300d]{1,120})\u300d/)
  if (quotedCn?.[1]) return String(quotedCn[1]).trim().slice(0, 80)
  const quoted = t.match(/["“]([^"”]{1,120})["”]/)
  if (quoted?.[1]) return String(quoted[1]).trim().slice(0, 80)
  const m = t.match(/(?:搜索|搜一下|查找|search)\s*[「『"“]?([^」』"”\n]{1,80})/i)
  if (m?.[1]) return String(m[1]).replace(/[，。！？、].*$/, '').trim().slice(0, 80)
  return ''
}

export function classifyLeanBrowseKind(input: {
  task?: string
  goals?: Record<string, unknown> | null
  /** LobsterTaskUnderstand.task_kind */
  taskKind?: string
}): LeanBrowseKind {
  const g = input.goals && typeof input.goals === 'object' ? input.goals : {}
  const watch = Math.max(0, Math.floor(Number((g as any).watchSeconds || 0)))
  if (watch > 0 || !!(g as any).waitForVideoEnd) return 'video'
  const tk = String(input.taskKind || '').trim()
  if (tk === 'video_play' || tk === 'social_engagement') return 'video'
  if (tk === 'form_fill' || tk === 'login') return 'form'
  const mustSearch = !!(g as any).mustSearch || tk === 'search'
  const mustEnter = !!(g as any).mustEnterDetail
  const mustExtract = !!(g as any).mustExtract || tk === 'extract'
  const t = String(input.task || '')
  if (/(填表|登录|sign\s*in|log\s*in|表单|form)/i.test(t) && !mustSearch) return 'form'
  if (mustSearch && (mustEnter || /打开第|第一条|第一个|首条|first\s*result/i.test(t))) return 'search_open'
  if (mustSearch || mustExtract || /搜索|search/i.test(t)) return 'search_extract'
  if (/(视频|播放|点赞|投币|弹幕|bilibili|哔哩)/i.test(t)) return 'video'
  return 'general'
}

/** classic 搜索/抽取类任务收紧步数预算（视频/长观看不裁） */
export function leanClassicMaxSteps(kind: LeanBrowseKind, baseMaxSteps: number): number {
  const base = Math.max(4, Math.floor(Number(baseMaxSteps) || 20))
  if (kind === 'video') return Math.max(base, 20)
  if (kind === 'form') return Math.min(base, 16)
  if (kind === 'search_open') return Math.min(base, 12)
  if (kind === 'search_extract') return Math.min(base, 10)
  return Math.min(base, 14)
}

/** MCP 同理：简单搜索少绕圈 */
export function leanMcpMaxSteps(kind: LeanBrowseKind, baseMaxSteps: number): number {
  const base = Math.max(4, Math.floor(Number(baseMaxSteps) || 24))
  if (kind === 'video' || kind === 'form') return base
  if (kind === 'search_open') return Math.min(base, 14)
  if (kind === 'search_extract') return Math.min(base, 12)
  return Math.min(base, 16)
}

export function isResultListUrl(url: string): boolean {
  const u = String(url || '')
  return (
    /\/s(\?|$)/i.test(u) ||
    /[?&](wd|q|query|keyword|search)=/i.test(u) ||
    /search\./i.test(u) ||
    /\/search(\/|\?|$)/i.test(u)
  )
}

/**
 * OpenClaw：默认用结构化 snapshot/DOM；视觉仅兜底（遮罩/验证码/强停滞）。
 * 旧逻辑把 mustSearch 当 critical → 每步 vision，既费 token 又拖慢。
 */
export function shouldSpendVisionThisTurn(input: {
  kind: LeanBrowseKind
  useVisionConfig: boolean
  stallCount: number
  overlayLikely: boolean
  captchaLikely: boolean
  pageUrl: string
  candidateCount: number
  pageTextLen: number
}): boolean {
  if (!input.useVisionConfig) return false
  if (input.captchaLikely || input.overlayLikely) return true
  if (input.stallCount >= 2) return true
  if (input.kind === 'video') return true
  // 搜索/列表页：DOM 足够则跳过多模态
  if (input.kind === 'search_extract' || input.kind === 'search_open') {
    if (isResultListUrl(input.pageUrl) && input.candidateCount >= 4) return false
    if (input.candidateCount >= 8 && input.pageTextLen >= 400) return false
    // 首页且候选够：用 type/goto，不必先 vision
    if (input.candidateCount >= 6 && input.stallCount < 1) return false
    return input.stallCount >= 1
  }
  return input.stallCount >= 1 || input.candidateCount < 4
}

/** 能直达结果页时改写 startUrl，一步少一轮首页 type */
export function resolveLeanSearchLandingUrl(input: {
  startUrl: string
  searchQuery: string
  kind: LeanBrowseKind
}): string | null {
  const q = String(input.searchQuery || '').trim()
  if (!q) return null
  if (input.kind !== 'search_extract' && input.kind !== 'search_open') return null
  const start = String(input.startUrl || '').trim()
  if (isBaiduHost(start) && baiduNeedsDirectSearch(start)) return baiduSearchUrl(q)
  if (!start && q) return baiduSearchUrl(q)
  return null
}

/** 落地结果页后跳过 stage=search，直接进详情/抽取 */
export function leanStageAfterLanding(input: {
  kind: LeanBrowseKind
  landedOnResults: boolean
  mustEnterDetail: boolean
  mustExtract: boolean
}): string {
  if (!input.landedOnResults) {
    return input.kind === 'search_extract' || input.kind === 'search_open' ? 'search' : 'home'
  }
  if (input.mustEnterDetail) return 'enter_detail'
  if (input.mustExtract) return 'extract'
  return 'done'
}

export function mcpOpenClawLeanPromptAddon(kind: LeanBrowseKind): string {
  const budget =
    kind === 'search_extract'
      ? '目标步数 ≤ 6：navigate（或直达搜索 URL）→ snapshot → 必要时 type+Enter → snapshot → 抽取/点第一条 → finish。'
      : kind === 'search_open'
        ? '目标步数 ≤ 8：进结果页 → snapshot → 点第一条结果 → snapshot 确认 → finish（标题+URL）。打开详情后禁止返回搜索引擎首页。'
        : '优先 snapshot→act→再 snapshot；避免无意义重复截图与空转。'
  return [
    '## OpenClaw 式少步浏览（强制）',
    '- 推理以 browser_snapshot（无障碍树/refs）为准，不要依赖每步截图多模态。',
    '- 导航或 DOM 变化后必须再 snapshot，再对最新 ref 操作。',
    '- 搜索类：优先直达结果 URL（如百度 /s?wd=）；避免首页反复 type。',
    '- 拿到标题/链接/列表后立刻 finish，不要继续滚动或重复 snapshot。',
    '- search_open：已进入非结果列表的详情页（如公众号/文档站）必须立刻 finish(标题+URL)，禁止再 goto 百度首页。',
    '- 禁止在同一 URL 连续 3 次无进展 tool 调用。',
    budget,
  ].join('\n')
}

/**
 * search_open：当前是否已到达「第一条结果」详情页（离开 SERP，且非验证码/搜索站导航页）
 * 注意：站点首页（如 runoob.com/）也会匹配「非 SERP」——调用方必须再用 startUrl 排除起始页。
 */
export function isSearchOpenDestinationUrl(url: string): boolean {
  const u = String(url || '').trim()
  if (!u || !/^https?:\/\//i.test(u)) return false
  if (/wappass\.|\/captcha|recaptcha|turnstile|challenge/i.test(u)) return false
  if (isResultListUrl(u)) return false
  if (/^https?:\/\/([\w-]+\.)?baidu\.com\/?$/i.test(u)) return false
  if (/baidu\.com\/(news|map|tieba|image|zhidao|wenku|baike|v|video)/i.test(u)) return false
  // 百度结果常跳转到第三方；站内 /s? 已在 isResultListUrl 排除
  return true
}

/** hostname+pathname 相同（忽略尾斜杠与 query）视为同一落地页 */
export function urlsSameSitePath(a: string, b: string): boolean {
  try {
    const ua = new URL(String(a || '').trim())
    const ub = new URL(String(b || '').trim())
    return (
      ua.hostname.replace(/^www\./i, '') === ub.hostname.replace(/^www\./i, '') &&
      ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
    )
  } catch {
    const na = String(a || '')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase()
    const nb = String(b || '')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase()
    return Boolean(na && nb && na === nb)
  }
}

/** 是否已离开任务起始页（无 startUrl 时不做起始页约束） */
export function hasLeftStartPage(currentUrl: string, startUrl?: string): boolean {
  const start = String(startUrl || '').trim()
  if (!start) return true
  const cur = String(currentUrl || '').trim()
  if (!cur) return false
  return !urlsSameSitePath(cur, start)
}
