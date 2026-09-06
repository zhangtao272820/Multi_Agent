/**
 * B站专属互动（P4 MVP）：工具白名单 + HITL/登录闸 + Playwright DOM 选择器。
 * 意图仍由 TaskUnderstand / guiOperateKind LLM 判定；本模块只做闸门与确定性点击。
 * 弹幕 / 投稿 / 支付 / 批量刷互动：硬拒或后置。
 */
import type { Page } from 'playwright'

export const BILI_WRITE_TOOLS = ['bili_like', 'bili_coin', 'bili_favorite', 'bili_follow'] as const
export const BILI_PLAY_TOOLS = ['bili_play', 'bili_pause'] as const
export const BILI_DEFERRED_TOOLS = ['bili_danmaku'] as const
export const BILI_FORBIDDEN_TOOLS = ['bili_upload', 'bili_pay', 'bili_batch', 'bili_spam'] as const

export type BiliWriteTool = (typeof BILI_WRITE_TOOLS)[number]
export type BiliPlayTool = (typeof BILI_PLAY_TOOLS)[number]
export type BiliKnownTool =
  | BiliWriteTool
  | BiliPlayTool
  | (typeof BILI_DEFERRED_TOOLS)[number]
  | (typeof BILI_FORBIDDEN_TOOLS)[number]

const WRITE_SET = new Set<string>(BILI_WRITE_TOOLS)
const PLAY_SET = new Set<string>(BILI_PLAY_TOOLS)
const DEFERRED_SET = new Set<string>(BILI_DEFERRED_TOOLS)
const FORBIDDEN_SET = new Set<string>(BILI_FORBIDDEN_TOOLS)

export const BILI_HOST_RE = /bilibili\.com|b23\.tv/i

/** 单次 run 写互动上限（防批量） */
export const BILI_MAX_WRITE_PER_RUN = 3

export const BILI_SELECTORS: Record<BiliWriteTool | BiliPlayTool, string[]> = {
  bili_like: [
    '.video-like:not(.on)',
    '.video-toolbar-left .like',
    '[class*="video-like"]',
    'div.like',
  ],
  bili_coin: [
    '.video-coin:not(.on)',
    '.video-toolbar-left .coin',
    '[class*="video-coin"]',
    'div.coin',
  ],
  bili_favorite: [
    '.video-fav:not(.on)',
    '.video-toolbar-left .collect',
    '[class*="video-fav"]',
    'div.collect',
  ],
  bili_follow: [
    '.up-info .follow-btn:not(.is-following)',
    '.follow-btn:not(.following)',
    'button:has-text("关注")',
    '.up-panel-right .follow',
  ],
  bili_play: [
    '.bpx-player-ctrl-play',
    '.bpx-player-ctrl-btn[aria-label*="播放"]',
    'button[aria-label*="播放"]',
    '.bilibili-player-video-btn-start',
  ],
  bili_pause: [
    '.bpx-player-ctrl-play.bpx-state-paused',
    '.bpx-player-ctrl-btn[aria-label*="暂停"]',
    'button[aria-label*="暂停"]',
  ],
}

export function isBilibiliEngagementHost(urlOrHost: string): boolean {
  return BILI_HOST_RE.test(String(urlOrHost || ''))
}

export function normalizeBiliToolName(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

export function isBiliWriteTool(tool: string): tool is BiliWriteTool {
  return WRITE_SET.has(normalizeBiliToolName(tool))
}

export function isBiliPlayTool(tool: string): tool is BiliPlayTool {
  return PLAY_SET.has(normalizeBiliToolName(tool))
}

export function isAllowedBiliTool(tool: string): boolean {
  const t = normalizeBiliToolName(tool)
  return WRITE_SET.has(t) || PLAY_SET.has(t)
}

export type BiliLoginSignals = {
  /** cookie / storage 已导入 */
  hasStorageProfile?: boolean
  /** 页面是否出现登录墙文案或登录按钮主导 */
  loginWallVisible?: boolean
  /** 顶栏已登录头像等正信号 */
  loggedInUi?: boolean
  /** 用户显式声明已登录 / 复用 CDP */
  userClaimsLoggedIn?: boolean
}

/** 纯函数：是否具备写互动登录态 */
export function detectBilibiliLoggedIn(signals: BiliLoginSignals): boolean {
  if (signals.loginWallVisible === true && signals.loggedInUi !== true) return false
  if (signals.loggedInUi === true) return true
  if (signals.hasStorageProfile === true || signals.userClaimsLoggedIn === true) return true
  return false
}

export type GateBilibiliEngagementInput = {
  tool: string
  loggedIn: boolean
  hitlApproved: boolean
  /** 本 run 已执行写互动次数 */
  writeCountInRun?: number
  maxWritePerRun?: number
  hostOrUrl?: string
}

export type GateBilibiliEngagementResult =
  | { ok: true; tool: string }
  | { ok: false; code: string; message: string }

/**
 * 写互动 / 播放闸门（纯函数，供 smoke）。
 * 弹幕后置；投稿支付批量硬拒。
 */
export function gateBilibiliEngagement(input: GateBilibiliEngagementInput): GateBilibiliEngagementResult {
  const tool = normalizeBiliToolName(input.tool)
  if (!tool) {
    return { ok: false, code: 'bili_tool_empty', message: '未指定 B站互动工具' }
  }
  if (input.hostOrUrl && !isBilibiliEngagementHost(input.hostOrUrl)) {
    return { ok: false, code: 'bili_host_mismatch', message: '非 bilibili 域名，拒绝专属互动工具' }
  }
  if (FORBIDDEN_SET.has(tool)) {
    return { ok: false, code: 'bili_forbidden', message: `禁止工具：${tool}（投稿/支付/批量）` }
  }
  if (DEFERRED_SET.has(tool)) {
    return { ok: false, code: 'bili_danmaku_deferred', message: '发弹幕本阶段未启用，请人工在播放器发送' }
  }
  if (!isAllowedBiliTool(tool)) {
    return { ok: false, code: 'bili_tool_unknown', message: `未知工具：${tool}` }
  }
  if (WRITE_SET.has(tool)) {
    if (!input.hitlApproved) {
      return { ok: false, code: 'bili_hitl_required', message: '写互动须人工确认（HITL）后执行' }
    }
    if (!input.loggedIn) {
      return {
        ok: false,
        code: 'bili_login_required',
        message: '未检测到登录态：请导入 cookie / 使用 user CDP，或在 noVNC 登录后再试',
      }
    }
    const max = Math.max(1, Number(input.maxWritePerRun ?? BILI_MAX_WRITE_PER_RUN) || BILI_MAX_WRITE_PER_RUN)
    const used = Math.max(0, Number(input.writeCountInRun || 0) || 0)
    if (used >= max) {
      return { ok: false, code: 'bili_batch_blocked', message: `单次任务写互动已达上限 ${max}` }
    }
  }
  return { ok: true, tool }
}

export type BiliEngagementPlan = {
  tools: string[]
  needsLogin: boolean
  needsHitl: boolean
  deferred: string[]
  engine: 'classic' | 'stagehand'
}

/**
 * 由已结构化的 task_kind + 可选声明工具生成计划（非用户原话意图路由）。
 */
export function planBilibiliEngagementFromSpec(input: {
  taskKind?: string
  declaredTools?: string[] | null
}): BiliEngagementPlan {
  const kind = String(input.taskKind || '').trim()
  const declared = Array.isArray(input.declaredTools)
    ? input.declaredTools.map(normalizeBiliToolName).filter(Boolean)
    : []
  const deferred = declared.filter((t) => DEFERRED_SET.has(t))
  const allowedDeclared = declared.filter((t) => isAllowedBiliTool(t))

  if (kind === 'video_play') {
    return {
      tools: allowedDeclared.length ? allowedDeclared.filter(isBiliPlayTool) : ['bili_play'],
      needsLogin: false,
      needsHitl: false,
      deferred,
      engine: 'classic',
    }
  }
  if (kind === 'social_engagement') {
    const writes = allowedDeclared.length
      ? allowedDeclared.filter(isBiliWriteTool)
      : (['bili_like'] as string[])
    return {
      tools: writes.slice(0, BILI_MAX_WRITE_PER_RUN),
      needsLogin: true,
      needsHitl: true,
      deferred,
      engine: 'classic',
    }
  }
  return { tools: [], needsLogin: false, needsHitl: false, deferred, engine: 'classic' }
}

/** 从 Manager/Lobster meta 或 workflow_args 读取声明工具 */
export function declaredBiliToolsFromArgs(args: Record<string, unknown> | null | undefined): string[] {
  if (!args || typeof args !== 'object') return []
  const raw =
    args.engagement_ops ??
    args.engagementOps ??
    args.bili_tools ??
    args.biliTools ??
    args.tools
  if (Array.isArray(raw)) return raw.map((x) => normalizeBiliToolName(x)).filter(Boolean)
  if (typeof raw === 'string') {
    return raw
      .split(/[,;\s]+/)
      .map((s) => normalizeBiliToolName(s))
      .filter(Boolean)
  }
  return []
}

async function clickFirstVisible(page: Page, selectors: string[], timeoutMs = 8_000): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 4000) })
      await loc.click({ timeout: timeoutMs })
      return true
    } catch {
      /* try next */
    }
  }
  return false
}

export async function detectBilibiliLoginOnPage(page: Page): Promise<BiliLoginSignals> {
  const url = page.url()
  if (!isBilibiliEngagementHost(url)) return { loginWallVisible: false, loggedInUi: false }
  try {
    const signals = await page.evaluate(() => {
      const text = String(document.body?.innerText || '').slice(0, 4000)
      const loginWall =
        /登录后|请先登录|扫码登录|密码登录/.test(text) &&
        !document.querySelector('.header-avatar-wrap, .bili-avatar, .header-entry-avatar')
      const loggedInUi = Boolean(
        document.querySelector('.header-avatar-wrap, .bili-avatar img, .header-entry-avatar, .vip-name'),
      )
      return { loginWallVisible: loginWall, loggedInUi }
    })
    return signals
  } catch {
    return {}
  }
}

export async function runBilibiliToolOnPage(
  page: Page,
  tool: string,
): Promise<{ ok: boolean; detail: string }> {
  const t = normalizeBiliToolName(tool)
  if (t === 'bili_play') {
    const clicked = await clickFirstVisible(page, BILI_SELECTORS.bili_play, 10_000)
    // 已在播放：尝试点画面中央
    if (!clicked) {
      try {
        await page.locator('.bpx-player-video-wrap, video').first().click({ timeout: 5000 })
      } catch {
        /* ignore */
      }
    }
    const playing = await page
      .evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement | null
        return Boolean(v && !v.paused && v.readyState >= 2)
      })
      .catch(() => false)
    const player = await page.locator('.bpx-player-container, video').first().count().catch(() => 0)
    if (playing || player > 0) {
      return { ok: true, detail: playing ? 'video_playing' : 'player_present' }
    }
    return { ok: false, detail: 'play_unverified' }
  }
  if (t === 'bili_pause') {
    const clicked = await clickFirstVisible(page, BILI_SELECTORS.bili_pause, 8_000)
    return clicked ? { ok: true, detail: 'paused_click' } : { ok: false, detail: 'pause_control_missing' }
  }
  if (!isBiliWriteTool(t)) {
    return { ok: false, detail: `unsupported:${t}` }
  }
  const clicked = await clickFirstVisible(page, BILI_SELECTORS[t], 10_000)
  if (!clicked) return { ok: false, detail: `selector_miss:${t}` }
  await page.waitForTimeout(600)
  return { ok: true, detail: `${t}_clicked` }
}

export type RunBilibiliEngagementSessionInput = {
  page: Page
  taskKind: string
  declaredTools?: string[]
  hitlApproved: boolean
  hasStorageProfile?: boolean
  userClaimsLoggedIn?: boolean
  maxWritePerRun?: number
}

/**
 * 在已打开的 page 上执行计划工具（调用方负责 goto + HITL）。
 */
export async function runBilibiliEngagementSession(
  input: RunBilibiliEngagementSessionInput,
): Promise<{
  ok: boolean
  answer: string
  failureType?: string
  results: Array<{ tool: string; ok: boolean; detail: string; gateCode?: string }>
}> {
  const plan = planBilibiliEngagementFromSpec({
    taskKind: input.taskKind,
    declaredTools: input.declaredTools,
  })
  const url = input.page.url()
  if (!isBilibiliEngagementHost(url)) {
    return {
      ok: false,
      answer: '当前页非 B站域名，无法执行专属互动。',
      failureType: 'bili_host_mismatch',
      results: [],
    }
  }

  const pageSignals = await detectBilibiliLoginOnPage(input.page)
  const loggedIn = detectBilibiliLoggedIn({
    ...pageSignals,
    hasStorageProfile: input.hasStorageProfile,
    userClaimsLoggedIn: input.userClaimsLoggedIn,
  })

  const results: Array<{ tool: string; ok: boolean; detail: string; gateCode?: string }> = []
  let writeCount = 0

  for (const tool of plan.tools) {
    const gate = gateBilibiliEngagement({
      tool,
      loggedIn,
      hitlApproved: input.hitlApproved || !plan.needsHitl,
      writeCountInRun: writeCount,
      maxWritePerRun: input.maxWritePerRun,
      hostOrUrl: url,
    })
    if (!gate.ok) {
      results.push({ tool, ok: false, detail: gate.message, gateCode: gate.code })
      if (gate.code === 'bili_login_required' || gate.code === 'bili_hitl_required') {
        return {
          ok: false,
          answer: gate.message,
          failureType: gate.code === 'bili_login_required' ? 'need_login' : 'need_human',
          results,
        }
      }
      continue
    }
    const r = await runBilibiliToolOnPage(input.page, tool)
    results.push({ tool, ok: r.ok, detail: r.detail })
    if (r.ok && isBiliWriteTool(tool)) writeCount++
  }

  const anyOk = results.some((r) => r.ok)
  const allOk = results.length > 0 && results.every((r) => r.ok)
  const lines = results.map((r) => `${r.tool}:${r.ok ? 'ok' : 'fail'}(${r.detail})`)
  return {
    ok: allOk || (plan.tools.length === 1 && anyOk),
    answer: lines.length
      ? `B站互动结果：${lines.join('；')}`
      : '未执行任何 B站互动工具',
    failureType: allOk ? undefined : anyOk ? 'incomplete_task_output' : 'element_not_found',
    results,
  }
}
