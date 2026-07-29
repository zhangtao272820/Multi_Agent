import { StateGraph, StateSchema, START, END, type GraphNode } from '@langchain/langgraph'
import { z } from 'zod'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { extractFirstJsonObject, extractFirstJsonValue } from './lobster/json'
import { createQwenChatModel } from './lobster/model'
import { sanitizeStepMetaForEmit } from './lobster/stepMeta'
import { clipForPrompt, sanitize } from './lobster/text'
import type { AgentConfig, EmitEvent, LobsterPublicState, RunParams } from './lobster/types'
import { collectPageSignals } from './lobsterAgent/pageSignals'
import { applyCompliance } from './lobsterAgent/compliance'
import {
  bilibiliSearchUrl,
  isBilibiliGuestTask,
  bilibiliNeedsDirectSearch,
  bilibiliDirectSearchIntent,
  baiduSearchUrl,
  baiduNeedsDirectSearch,
  taskRequiresLogin
} from './lobsterAgent/taskLoginIntent'
import {
  classifyLeanBrowseKind,
  leanClassicMaxSteps,
  leanStageAfterLanding,
  resolveLeanSearchLandingUrl,
  shouldSpendVisionThisTurn,
  isResultListUrl,
  isSearchOpenDestinationUrl,
  hasLeftStartPage,
} from './lobsterAgent/leanBrowsePolicy'
import {
  classicStepDecide,
  toIntentCall,
} from './classicStepDecide'
import {
  isClassicStepDecideEnabled,
  isClassicGoalsHeuristicEnabled,
  classicStepDecideMinConfidence,
} from './classicStepDecideSchema'
import {
  mergeSuccessCriteria,
  parseSuccessCriteria,
  resultPageHintsFor,
} from './lobsterSuccessCriteria'
import { appendLobsterNluMetric } from './lobsterNluMetrics'
import { computeProgress } from './lobsterAgent/progress'
import { getForcedIntents } from './lobsterAgent/recipes'
import { createNodeRecover } from './lobsterAgent/recover'
import { createNodeVerify } from './lobsterAgent/verify'
import {
  actionSchema,
  intentSchema,
  normalizeVisionJson,
  skillSchema,
  type Action,
  type IntentCall,
  type Skill
} from './lobsterAgent/schemas'
import { collectCandidates as collectCandidatesFromModule, renderOverlayScreenshot as renderOverlayScreenshotFromModule } from './lobsterAgent/candidateTools'
import { resolveStorageStatePath } from './sessionStorage'
import { wrapLobsterOutput } from './lobsterResultEnvelope'
import {
  inferDetailLinkCandidates,
  pickCandidateIndexByIntent,
  pickGenericFirstResultCandidateIndex,
  rankedCandidateIndexesByIntent,
  scoreCandidateForIntent
} from './lobsterAgent/candidateSelectors'
import { executeClickCandidate } from './lobsterAgent/executorClickCandidate'
import { executeTypeCandidate } from './lobsterAgent/executorTypeCandidate'
import { executeDismissOverlays } from './lobsterAgent/executorDismissOverlays'
import { executeExtract } from './lobsterAgent/executorExtract'
import { resolveEffectiveHeadless } from '../utils/lobster_env'
import { buildChromiumLaunchOptions } from '../utils/chromiumLaunch'
import {
  managedBrowserProfileDir,
  resolveBrowserCdpUrl,
  resolveBrowserProfile,
} from './browserProfiles'
import { connectBrowserOverCdp, resolveCdpPage } from './browserCdpAttach'
import {
  normalizePageStage,
  stageAllowsIntent,
  stagePrefersIntent,
  stageTransitionAllowed,
  type PageStage
} from './adapters/pageStages'

export type { AgentConfig, EmitEvent, LobsterPublicState, RunParams } from './lobster/types'

type BrowserSession = {
  context: BrowserContext
  page: Page
  storagePath?: string
  storageLoaded?: boolean
}

const LobsterState = new StateSchema({
  task: z.string(),
  startUrl: z.string().optional(),
  listUrl: z.string().default(''),
  taskSpec: z.record(z.string(), z.any()).default({}),
  completionCriteria: z.record(z.string(), z.any()).default({}),
  goals: z.record(z.string(), z.any()).default({}),
  stage: z.string().default(''),
  phase: z.string().default('planning'),
  stepCount: z.number().default(0),
  maxSteps: z.number().default(20),
  pageUrl: z.string().default(''),
  pageTitle: z.string().default(''),
  pageText: z.string().default(''),
  screenshotDataUrl: z.string().default(''),
  plan: z.record(z.string(), z.any()).default({}),
  action: z.record(z.string(), z.any()).default({}),
  candidates: z.array(z.any()).default([]),
  waitForVideoEnd: z.boolean().default(false),
  watchSeconds: z.number().default(0),
  watchUntilAt: z.number().default(0),
  watchAnchorUrl: z.string().default(''),
  playAttemptCount: z.number().default(0),
  lastPlayAttemptAt: z.number().default(0),
  lastPlayError: z.string().default(''),
  lastUrl: z.string().default(''),
  sameUrlCount: z.number().default(0),
  lastActionKey: z.string().default(''),
  sameActionCount: z.number().default(0),
  actionSeq: z.array(z.string()).default([]),
  pageFingerprint: z.string().default(''),
  fingerprintSeq: z.array(z.string()).default([]),
  openTriedUrls: z.array(z.string()).default([]),
  lastClickCandidateIndex: z.number().default(-1),
  stallCount: z.number().default(0),
  modelCalls: z.number().default(0),
  decisionCalls: z.number().default(0),
  visionCalls: z.number().default(0),
  ocrCalls: z.number().default(0),
  stopAfterExtract: z.boolean().default(false),
  extractedCount: z.number().default(0),
  extractedCountBefore: z.number().default(0),
  lastScreenshotAt: z.number().default(0),
  crawlUrls: z.array(z.string()).default([]),
  data: z.array(z.any()).default([]),
  route: z.string().default(''),
  error: z.string().default(''),
  failureType: z.string().default(''),
  lastStepMeta: z.any().default(null),
  ocrText: z.string().default(''),
  lastOcrAt: z.number().default(0),
  visionSummary: z.string().default(''),
  visionJson: z.record(z.string(), z.any()).default({}),
  lastVisionAt: z.number().default(0),
  forcedIntents: z.array(z.any()).default([]),
  forcedIntentsExpireAt: z.number().default(0),
  forcedIntentsUsed: z.number().default(0),
  forcedIntentsSource: z.string().default(''),
  gate: z.record(z.string(), z.any()).default({}),
  recoverCount: z.number().default(0),
  forcedInjectCounts: z.record(z.string(), z.number()).default({}),
  forcedInjectTotal: z.number().default(0),
  recentFailures: z.array(z.string()).default([]),
  lastConfirmedActionKey: z.string().default(''),
  lastConfirmAt: z.number().default(0),
  lastCommentText: z.string().default(''),
  lastQualityWanted: z.string().default(''),
  lastRateWanted: z.string().default(''),
  lastDanmakuWanted: z.string().default(''),
  confirmCount: z.number().default(0),
  retry: z.number().default(0)
})


let globalBrowser: Browser | null = null
let globalBrowserHeadless: boolean | null = null

async function getBrowser(headless: boolean) {
  const cdpUrl = resolveBrowserCdpUrl()
  if (cdpUrl) {
    if (!globalBrowser) {
      globalBrowserHeadless = headless
      globalBrowser = await chromium.connectOverCDP(cdpUrl)
    }
    return globalBrowser
  }
  if (!globalBrowser) {
    globalBrowserHeadless = headless
    const launchOpts = buildChromiumLaunchOptions(headless)
    globalBrowser = await chromium.launch({
      headless,
      ignoreDefaultArgs: ['--enable-automation'],
      args: launchOpts.args,
      env: launchOpts.env
    })
  } else if (globalBrowserHeadless !== headless) {
    try {
      await globalBrowser.close()
    } catch {}
    globalBrowser = null
    globalBrowserHeadless = null
    return await getBrowser(headless)
  }
  return globalBrowser
}

async function createSession(
  headless: boolean,
  storageSavePath?: string,
  storageLoadPath?: string,
  videoDir?: string,
  opts?: { storageProfile?: string; browserProfile?: 'managed' | 'user' }
) {
  const profile = opts?.browserProfile || resolveBrowserProfile()
  const launchOpts = buildChromiumLaunchOptions(headless)
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

  if (profile === 'user') {
    const cdpUrl = resolveBrowserCdpUrl()
    if (cdpUrl) {
      const browser = await connectBrowserOverCdp(cdpUrl)
      const { context, page } = await resolveCdpPage(browser)
      if (storageLoadPath) {
        try {
          const raw = await fs.readFile(storageLoadPath, 'utf-8')
          const state = JSON.parse(raw)
          const cookies = Array.isArray(state?.cookies) ? state.cookies : []
          if (cookies.length) await context.addCookies(cookies as any)
        } catch {}
      }
      return { context, page, storagePath: storageSavePath, storageLoaded: !!storageLoadPath } satisfies BrowserSession
    }
  }

  if (profile === 'managed') {
    const profileDir = managedBrowserProfileDir(opts?.storageProfile)
    await fs.mkdir(profileDir, { recursive: true })
    const context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent,
      args: launchOpts.args,
      env: launchOpts.env,
      ...(storageLoadPath ? { storageState: storageLoadPath } : {}),
      ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {}),
    })
    const page = context.pages()[0] ?? (await context.newPage())
    page.setDefaultTimeout(20000)
    page.setDefaultNavigationTimeout(45000)
    return { context, page, storagePath: storageSavePath, storageLoaded: !!storageLoadPath } satisfies BrowserSession
  }

  const browser = await getBrowser(headless)
  const storageState = storageLoadPath ? storageLoadPath : undefined
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    userAgent,
    ...(storageState ? { storageState } : {}),
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {}),
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.setDefaultNavigationTimeout(45000)
  return { context, page, storagePath: storageSavePath, storageLoaded: !!storageLoadPath } satisfies BrowserSession
}

async function closeSession(session: BrowserSession | null) {
  if (!session) return
  try {
    if (session.storagePath) {
      try {
        await fs.mkdir(path.dirname(session.storagePath), { recursive: true })
        await session.context.storageState({ path: session.storagePath })
      } catch {}
    }
    await session.context.close()
  } catch {}
}

async function pageSnapshot(page: Page) {
  const url = String(page.url() ?? '')
  const title = String((await page.title().catch(() => '')) ?? '')
  let text = ''
  if (!text) {
    text = await page
      .evaluate(() => {
        const doc: any = (globalThis as any).document
        const body = doc?.body
        const t = body ? body.innerText : ''
        return String(t || '')
      })
      .catch(() => '')
  }
  const clipped = (() => {
    const s = String(text || '').replace(/\s+\n/g, '\n').trim()
    return s.length > 7000 ? `${s.slice(0, 7000)}…` : s
  })()
  const buf = await page.screenshot({ type: 'png' })
  const b64 = Buffer.from(buf).toString('base64')
  const dataUrl = `data:image/png;base64,${b64}`
  return { url, title, text: clipped, dataUrl }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
) {
  const out: R[] = new Array(items.length)
  let i = 0
  const n = Math.max(1, Math.floor(limit))
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      out[idx] = await fn(items[idx]!, idx)
    }
  })
  await Promise.all(workers)
  return out
}

function normalizeStartUrl(task: string, startUrl?: string) {
  const raw = String(startUrl ?? '').trim()
  if (raw) {
    if (/^https?:\/\//i.test(raw)) return raw
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) return `https://${raw}`
    return raw
  }
  const m = String(task || '').match(/https?:\/\/[^\s]+/i)
  if (m) return m[0]
  const t = String(task || '')
  const sitePresets: Array<{ re: RegExp; url: string }> = [
    { re: /(菜鸟教程|runoob)/i, url: 'https://www.runoob.com/' },
    { re: /(百度|baidu)/i, url: 'https://www.baidu.com/' },
    { re: /(政府|gov\.cn)/i, url: 'https://www.gov.cn/' },
    { re: /(github)/i, url: 'https://github.com/' },
    { re: /(知乎|zhihu)/i, url: 'https://www.zhihu.com/' },
    { re: /(微博|weibo)/i, url: 'https://weibo.com/' },
    { re: /(淘宝|taobao)/i, url: 'https://www.taobao.com/' },
    { re: /(京东|jd\\.com)/i, url: 'https://www.jd.com/' },
    { re: /(B站|bilibili|哔哩)/i, url: 'https://www.bilibili.com/' }
  ]
  const hit = sitePresets.find((x) => x.re.test(t))
  if (hit) return hit.url
  if (/搜索|search/i.test(t)) {
    const q = parseQueryFromTask(t)
    if (q) return `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`
  }
  return 'https://www.runoob.com/'
}

function parseQueryFromTask(task: string) {
  const t = String(task || '')
  const quotedCn = t.match(/\u300c([^\u300d]{1,120})\u300d/)
  if (quotedCn?.[1]) {
    const s = String(quotedCn[1]).trim()
    return s.length > 80 ? s.slice(0, 80) : s
  }
  const quoted = t.match(/["“]([^"”]{1,120})["”]/)
  if (quoted?.[1]) {
    const s = String(quoted[1]).trim()
    return s.length > 80 ? s.slice(0, 80) : s
  }
  const extractTail = (s: string) =>
    String(s || '')
      .trim()
      .replace(/^(请|帮我|麻烦|需要|想要|请先|先)?\s*/i, '')
      .replace(/^(在|去|到)\s*(?:页面|网页|网站|站内)?\s*/i, '')
      .replace(/^(搜索|查找|搜一下|搜|打开|进入|定位到|找到)\s*/i, '')
      .replace(/\s*(?:并|然后|再|之后|接着)\b[\s\S]*$/i, '')
      .replace(/\s*(?:后|以后)\b[\s\S]*$/i, '')
      .replace(/[。；;,.，]+$/g, '')
      .trim()
  const candidates = [
    t.match(/输入\s*[:：]\s*([^\n\r]+)/),
    t.match(/搜索\s*(?:关键词)?\s*[:：]?\s*([^\n\r]+)/),
    t.match(/关键词\s*[:：]\s*([^\n\r]+)/),
    t.match(/query\s*[:：]\s*([^\n\r]+)/i),
    t.match(/(?:帮我|请)?(?:在|去|到)?(?:页面|网页|网站|站内)?(?:上)?(?:搜索|查找|搜一下|搜)\s+([^\n\r]+)/i),
    t.match(/(?:打开|进入|前往)\s+([^\n\r]{2,120}?)(?:\s*(?:页面|页|视频|详情))(?:\s|$)/i)
  ]
  const raw = candidates.map((m) => (m?.[1] ? String(m[1]) : '')).find((s) => s.trim()) ?? ''
  const head =
    extractTail(raw).split(/(?:，|,|。|;|；|\s+(?:然后|并且|并|且|and|以及|并将|并抽取|抽取|提取|获取|输出)\b)/i)[0] || ''
  const q = head.replace(/[。；;,.，]+$/g, '').trim()
  return q.length > 80 ? q.slice(0, 80) : q
}

function summarizeTask(task: string) {
  const t = String(task || '').replace(/\s+/g, ' ').trim()
  const searchQuery = parseQueryFromTask(t)
  return {
    raw: t,
    searchQuery,
    wantsSearch: /搜索|\bsearch\b|查找|搜一下|搜\b/i.test(t),
    wantsOpen: /打开|进入|前往|进入详情|打开详情|进入视频|打开视频|第[一1]个|第[一1]条|第一条|首个/i.test(t),
    wantsExtract: /抽取|提取|获取|输出|列表|结果|top\s*\d+|前\s*\d+\s*条/i.test(t),
    constraints: {
      noExtract: /不要抽取|别抽取|不需要抽取|不要输出结果/i.test(t),
      noExternal: /只在本站|只在本网站|只在当前网站|不要外站|不(?:要|用|需|必)?跳出本站/i.test(t)
    }
  }
}

function parseNavLabelFromTask(task: string) {
  const t = String(task || '').replace(/\s+/g, ' ').trim()
  const m = t.match(/(?:打开|进入|前往|去|跳转到?)\s*([^\n\r，。,]{2,12})(?:页面|页|里|中)?/i)
  if (m?.[1]) return String(m[1]).trim()
  const presets = [
    '历史记录',
    '观看历史',
    'history',
    '订单',
    '购物车',
    '收藏',
    '消息',
    '个人中心',
    '我的',
    '设置'
  ]
  const hit = presets.find((k) => new RegExp(`\\b${k}\\b|${k}`, 'i').test(t))
  return hit ? String(hit) : ''
}

function parseTopNFromTask(task: string) {
  const t = String(task || '')
  const m = t.match(/前\s*(\d+)\s*条|top\s*(\d+)/i)
  const n = Number(m?.[1] || m?.[2] || '')
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(20, Math.floor(n))
}

function parseWatchSecondsFromTask(task: string) {
  const t = String(task || '')
  const mStrict = t.match(
    /(?:观看|看|播放|等待|等|停留)(?:完)?\s*(\d{1,4})\s*(?:秒|s)\s*(?:后)?(?:\s|[，,。.;；、])*\s*(?:结束|停止|退出|关闭|关|完成)/i
  )
  if (mStrict?.[1]) {
    const n = Number(mStrict[1])
    if (Number.isFinite(n) && n > 0) return Math.min(1200, Math.floor(n))
  }
  const mLoose = t.match(/(?:观看|看(?:一下|一会儿)?|播放)\s*(\d{1,4})\s*(?:秒|s)\b/i)
  if (mLoose?.[1]) {
    const n = Number(mLoose[1])
    if (Number.isFinite(n) && n > 0) return Math.min(1200, Math.floor(n))
  }
  return 0
}

function wantsWaitForVideoEnd(task: string) {
  const t = String(task || '')
  return /不要提前结束|别提前结束|不提前结束|等待视频结束|等视频结束|等到视频结束|直到(?:视频)?结束|播放结束|播完|看完/i.test(t)
}

function parseForbiddenIntentsFromTask(task: string) {
  const t = String(task || '')
  const hasNeg = (re: RegExp) => {
    const neg = /(不(?:要|用|需|必)?|别|无需|不需要|不用|禁止)\s*/i
    return new RegExp(`${neg.source}(?:.*?)(?:${re.source})`, 'i').test(t)
  }
  const out = new Set<string>()
  if (hasNeg(/(?:播放|观看|看(?:视频)?|视频|\bplay\b|\bwatch\b|\bvideo\b)/i)) out.add('play')
  if (hasNeg(/(?:点赞|\blike\b|(^|[^赞])赞(?!助))/i)) out.add('like')
  if (hasNeg(/(?:投币|\bcoin\b|硬币)/i)) out.add('coin')
  if (hasNeg(/(?:关注|\bfollow\b|\bsubscribe\b|订阅)/i)) out.add('follow')
  if (hasNeg(/(?:收藏|\bfavorite\b|\bstar\b)/i)) out.add('favorite')
  if (hasNeg(/(?:抽取|提取|获取|输出|列表|结果|\bitems\b)/i)) out.add('extract')
  if (hasNeg(/(?:搜索|\bsearch\b|keyword|query)/i)) out.add('search')
  if (hasNeg(/(?:下一页|下页|更多|\bnext\b|\bmore\b)/i)) out.add('paginate_next')
  if (hasNeg(/(?:爬取|抓取|crawl)/i)) out.add('need_crawl')
  return out
}

export function deriveGoalsFromTask(task: string) {
  const t = String(task || '')
  const searchQuery = parseQueryFromTask(t)
  const mustSearch = /搜索|search/i.test(t) && !!searchQuery
  const watchSeconds = parseWatchSecondsFromTask(t)
  const mustExtract = (t: string) => {
    const hasKeywords = /抽取|提取|获取|输出|列表|结果|items|前\s*\d+\s*条|top\s*\d+/i.test(t)
    const hasNegative = /不(?:要|需|必|用)?(?:抽取|提取|获取|输出|列表|结果|items)/i.test(t)
    return hasKeywords && !hasNegative
  }
  const wantsOpenFirst = /第[一1]条|第[一1]个|第一个|首个|首条|第一条|first\s*result|open\s*first/i.test(t)
  const wantsEnterDetail =
    wantsOpenFirst ||
    /视频详情|进入[^\n\r]{0,18}视频|打开[^\n\r]{0,18}视频|第[一1]个[^\n\r]{0,10}视频|进入[^\n\r]{0,18}详情|打开[^\n\r]{0,18}详情|\bopen\b[^\n\r]{0,30}\b(first|1st)\b/i.test(
      t
    )
  const mustExtractVal = mustExtract(t)
  const hasAccountOps = /点赞|\blike\b|(^|\b)赞(?!助)\b|投币|\bcoin\b|关注|\bfollow\b|\bsubscribe\b|订阅|收藏|\bfavorite\b|\bstar\b/i.test(t)
  const mustEnterDetail = wantsOpenFirst || (wantsEnterDetail && (mustExtractVal || !hasAccountOps))
  const n = parseTopNFromTask(t)
  const extractLimit = mustExtractVal ? (n > 0 ? n : /历史记录|观看历史|\bhistory\b/i.test(t) ? 10 : 5) : 0
  const wantsBackToList =
    /返回[^\n\r]{0,18}(搜索|结果|列表)|回到[^\n\r]{0,18}(搜索|结果|列表)|回到上[^\n\r]{0,12}(页|页面|列表|结果)|返回上[^\n\r]{0,12}(页|页面|列表|结果)/i.test(
      t
    )
  const mustReturnToListBeforeExtract = !!(mustEnterDetail && mustExtractVal && wantsBackToList)
  return { mustSearch, searchQuery, watchSeconds, mustEnterDetail, mustExtract: mustExtractVal, extractLimit, mustReturnToListBeforeExtract }
}

export function deriveGoalsFromPlan(plan: any, task: string) {
  const base = deriveGoalsFromTask(task)
  const p = plan && typeof plan === 'object' ? plan : {}
  const out = { ...base }
  const allowExtractFromPlan = !!(base as any).mustExtract
  const allowReturnListFromPlan = !!(base as any).mustReturnToListBeforeExtract

  const applyExtractLimit = (n: any) => {
    const v = Number(n)
    if (!Number.isFinite(v) || v <= 0) return
    if (!allowExtractFromPlan) return
    out.mustExtract = true
    out.extractLimit = Math.min(20, Math.floor(v))
  }

  if (typeof (p as any).extractLimit !== 'undefined') applyExtractLimit((p as any).extractLimit)
  if (typeof (p as any).itemLimit !== 'undefined') applyExtractLimit((p as any).itemLimit)

  const goalsAny = (p as any).goals
  const goalAny = (p as any).goal
  const normGoalType = (s: string) => {
    const x = String(s || '').trim().toLowerCase()
    if (!x) return ''
    if (/(wait_for_video_play|watch|watch_for|timed_watch|等待播放|观看)/i.test(x)) return 'watch'
    if (/(enter_detail|open_first_result|detail|详情)/i.test(x)) return 'enter_detail'
    if (/(return_to_list|return_list|back_to_list|back_to_results|return_to_results|返回|回到|返回搜索|回到搜索|返回结果)/i.test(x))
      return 'return_to_list'
    if (/(extract|extract_items|items|list|results|抽取|提取|结果)/i.test(x)) return 'extract'
    if (/(done|finish|end|完成|结束)/i.test(x)) return 'done'
    return x
  }

  const absorb = (entry: any) => {
    if (!entry) return
    if (typeof entry === 'string') {
      const x = String(entry).toLowerCase()
      if (/(enter_detail|open_first_result|detail|video|详情)/i.test(x)) out.mustEnterDetail = true
      if (/(return_to_list|return_list|back_to_list|back_to_results|return_to_results|返回|回到|返回搜索|回到搜索|返回结果)/i.test(x))
        if (allowReturnListFromPlan) (out as any).mustReturnToListBeforeExtract = true
      if (/(extract|extract_items|items|list|results|抽取|提取|结果)/i.test(x)) {
        if (allowExtractFromPlan) out.mustExtract = true
      }
      return
    }
    if (typeof entry === 'object') {
      const type = String((entry as any).type || (entry as any).goal || (entry as any).intent || '')
      const t = normGoalType(type)
      if (t === 'enter_detail') out.mustEnterDetail = true
      if (t === 'watch') {
        const secRaw = (entry as any).watchSeconds ?? (entry as any).duration ?? (entry as any).seconds ?? (entry as any).sec
        const sec = Math.max(0, Math.floor(Number(secRaw || 0)))
        if (sec > 0) out.watchSeconds = Math.max(Math.floor(Number((out as any).watchSeconds || 0)), Math.min(1200, sec))
      }
      if (t === 'return_to_list') {
        if (allowReturnListFromPlan) (out as any).mustReturnToListBeforeExtract = true
      }
      if (t === 'extract') {
        if (allowExtractFromPlan) out.mustExtract = true
      }
      if (typeof (entry as any).limit !== 'undefined') applyExtractLimit((entry as any).limit)
      if (typeof (entry as any).n !== 'undefined') applyExtractLimit((entry as any).n)
      return
    }
  }

  if (Array.isArray(goalsAny)) {
    for (const g of goalsAny) absorb(g)
  } else if (typeof goalAny === 'string') {
    absorb(goalAny)
  } else if (goalAny && typeof goalAny === 'object') {
    absorb(goalAny)
  }

  // Prefer structured planner output when available.
  const cc = (p as any).completionCriteria && typeof (p as any).completionCriteria === 'object' ? (p as any).completionCriteria : {}
  const planWatchRaw =
    (p as any).watchSeconds ??
    (p as any).watchSec ??
    (p as any).waitSeconds ??
    (p as any).duration ??
    (cc as any).watchSeconds ??
    (cc as any).duration
  const planWatch = Math.max(0, Math.floor(Number(planWatchRaw || 0)))
  if (planWatch > 0) (out as any).watchSeconds = Math.max(Math.floor(Number((out as any).watchSeconds || 0)), Math.min(1200, planWatch))
  if (typeof (cc as any).waitForVideoEnd === 'boolean') (out as any).waitForVideoEnd = !!(cc as any).waitForVideoEnd

  if (out.mustExtract && out.extractLimit <= 0) out.extractLimit = base.extractLimit > 0 ? base.extractLimit : 5
  return out
}

function parseMediaQualityWanted(text: string) {
  const goal = String(text || '')
  const q =
    (goal.match(/(?:\b|^)(4k|8k|1080p|720p|480p|360p)\b/i)?.[1] || '').toUpperCase() ||
    (goal.match(/原画|蓝光/i)?.[0] || '')
  if (!q) return ''
  if (q === '1080P' || q === '720P' || q === '480P' || q === '360P') return q
  if (q === '4K' || q === '8K') return q
  return q
}

function parseMediaRateWanted(text: string) {
  const goal = String(text || '')
  const m = goal.match(/(\d(?:\.\d)?)\s*(?:x|倍)/i)
  const n = Number(m?.[1] || '')
  if (!Number.isFinite(n) || n <= 0) return ''
  const clipped = Math.max(0.25, Math.min(4, n))
  const s = String(clipped)
  return s.endsWith('.0') ? s.replace(/\.0$/, '') : s
}

function normalizeIntent(intent: string) {
  const s = String(intent || '').trim().toLowerCase()
  if (!s) return ''
  const alias: Record<string, string> = {
    play: 'play',
    播放: 'play',
    watch: 'play',
    fullscreen: 'fullscreen',
    full: 'fullscreen',
    全屏: 'fullscreen',
    like: 'like',
    赞: 'like',
    点赞: 'like',
    coin: 'coin',
    投币: 'coin',
    favorite: 'favorite',
    收藏: 'favorite',
    follow: 'follow',
    关注: 'follow',
    next: 'next',
    next_page: 'next',
    下一页: 'next',
    close: 'close',
    关闭: 'close',
    login: 'login',
    登录: 'login',
    quality: 'quality',
    清晰度: 'quality',
    画质: 'quality',
    分辨率: 'quality',
    rate: 'rate',
    倍速: 'rate',
    speed: 'rate',
    danmaku: 'danmaku',
    弹幕: 'danmaku',
    comment: 'comment',
    评论: 'comment'
  }
  return alias[s] || s
}

function splitIntentArg(intent: string) {
  const raw = String(intent || '').trim()
  if (!raw) return { base: '', arg: '' }
  const parts = raw.split(':').filter(Boolean)
  const base = normalizeIntent(String(parts[0] || ''))
  const arg = String(parts.slice(1).join(':') || '').trim()
  return { base, arg }
}

type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
type RiskDecision = 'allow' | 'confirm' | 'deny'
type RiskActionKind = 'account' | 'submit' | 'auth' | 'payment' | 'destructive' | 'upload' | 'external_navigation'
type NormalizedRiskPolicyRule = {
  enabled: boolean
  defaultDecision: RiskDecision
  criticalDecision: 'confirm' | 'deny'
  maxConfirmationsPerRun: number
  confirmActions: Set<RiskActionKind>
  denyActions: Set<RiskActionKind>
  confirmTextPatterns: RegExp[]
  denyTextPatterns: RegExp[]
}
type NormalizedRiskPolicy = {
  base: NormalizedRiskPolicyRule
  siteRules: Record<string, NormalizedRiskPolicyRule>
}
type ProcedurePlan = {
  name: string
  intents: IntentCall[]
}
type ProcedureHandler = (goalRaw: string, ctx: PerformContext) => ProcedurePlan | null

function normalizeRiskDecision(value: any, fallback: RiskDecision): RiskDecision {
  const s = String(value || '')
    .trim()
    .toLowerCase()
  if (s === 'allow' || s === 'confirm' || s === 'deny') return s
  return fallback
}

function normalizeRiskActionKind(value: any): RiskActionKind | '' {
  const s = String(value || '')
    .trim()
    .toLowerCase()
  if (
    s === 'account' ||
    s === 'submit' ||
    s === 'auth' ||
    s === 'payment' ||
    s === 'destructive' ||
    s === 'upload' ||
    s === 'external_navigation'
  )
    return s
  return ''
}

function toRegexList(input: any): RegExp[] {
  const arr = Array.isArray(input) ? input : []
  const out: RegExp[] = []
  for (const item of arr) {
    const raw = String(item || '').trim()
    if (!raw) continue
    try {
      out.push(new RegExp(raw, 'i'))
    } catch {}
  }
  return out
}

function createRiskPolicyRule(input: any, parent?: NormalizedRiskPolicyRule): NormalizedRiskPolicyRule {
  const x = input && typeof input === 'object' ? input : {}
  const fallback = parent || {
    enabled: true,
    defaultDecision: 'allow' as RiskDecision,
    criticalDecision: 'deny' as const,
    maxConfirmationsPerRun: 8,
    confirmActions: new Set<RiskActionKind>(['account', 'submit', 'auth', 'external_navigation']),
    denyActions: new Set<RiskActionKind>(['payment', 'destructive', 'upload']),
    confirmTextPatterns: [],
    denyTextPatterns: []
  }
  const confirmActions = Array.isArray(x?.confirmActions)
    ? new Set((x.confirmActions as any[]).map((v) => normalizeRiskActionKind(v)).filter(Boolean) as RiskActionKind[])
    : new Set(Array.from(fallback.confirmActions))
  const denyActions = Array.isArray(x?.denyActions)
    ? new Set((x.denyActions as any[]).map((v) => normalizeRiskActionKind(v)).filter(Boolean) as RiskActionKind[])
    : new Set(Array.from(fallback.denyActions))
  const rawMax = Number(x?.maxConfirmationsPerRun)
  return {
    enabled: typeof x?.enabled === 'boolean' ? !!x.enabled : fallback.enabled,
    defaultDecision: normalizeRiskDecision(x?.defaultDecision, fallback.defaultDecision),
    criticalDecision: normalizeRiskDecision(x?.criticalDecision, fallback.criticalDecision) === 'allow' ? 'confirm' : (normalizeRiskDecision(x?.criticalDecision, fallback.criticalDecision) as 'confirm' | 'deny'),
    maxConfirmationsPerRun:
      Number.isFinite(rawMax) && rawMax >= 0 ? Math.min(100, Math.floor(rawMax)) : fallback.maxConfirmationsPerRun,
    confirmActions,
    denyActions,
    confirmTextPatterns: Array.isArray(x?.confirmTextPatterns) ? toRegexList(x.confirmTextPatterns) : fallback.confirmTextPatterns,
    denyTextPatterns: Array.isArray(x?.denyTextPatterns) ? toRegexList(x.denyTextPatterns) : fallback.denyTextPatterns
  }
}

function normalizeRiskPolicy(config: AgentConfig): NormalizedRiskPolicy {
  const raw = (config as any)?.lobster?.policy
  const base = createRiskPolicyRule(raw)
  const siteRules: Record<string, NormalizedRiskPolicyRule> = {}
  const siteAny = raw && typeof raw === 'object' && raw.siteRules && typeof raw.siteRules === 'object' ? raw.siteRules : {}
  for (const [key, value] of Object.entries(siteAny)) {
    const k = String(key || '')
      .trim()
      .toLowerCase()
    if (!k) continue
    siteRules[k] = createRiskPolicyRule(value, base)
  }
  return { base, siteRules }
}

function resolveRiskPolicyRule(policy: NormalizedRiskPolicy, adapterKey: string, pageUrl: string) {
  const host = (() => {
    try {
      return new URL(String(pageUrl || '')).hostname.trim().toLowerCase()
    } catch {
      return ''
    }
  })()
  const keys = Array.from(new Set([String(adapterKey || '').trim().toLowerCase(), host].filter(Boolean)))
  for (const key of keys) {
    if (policy.siteRules[key]) return policy.siteRules[key]
    const hit = Object.entries(policy.siteRules).find(([ruleKey]) => {
      const rk = String(ruleKey || '').trim().toLowerCase()
      if (!rk) return false
      if (rk === key) return true
      return !!host && (host === rk || host.endsWith(`.${rk}`))
    })
    if (hit?.[1]) return hit[1]
  }
  return policy.base
}

function normalizeForbiddenIntentsFromTaskSet(set: Set<string>) {
  const out = new Set<string>()
  for (const it of Array.from(set)) {
    const s = String(it || '').trim()
    if (!s) continue
    if (s === 'extract') out.add('extract_items')
    else if (s === 'next') out.add('paginate_next')
    else out.add(s)
  }
  return out
}

type PerformContext = {
  adapterKey: string
  pageUrl: string
  pageTitle: string
  pageText: string
  candidates: any[]
}

function pickBestCandidateCidByRegex(candidatesAny: any, re: RegExp, kinds: string[] = []) {
  const list: any[] = Array.isArray(candidatesAny) ? candidatesAny.map((x) => x || {}) : []
  const wantKinds = new Set(kinds.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))
  let best: any = null
  for (const c of list) {
    const cid = String(c?.cid || '').trim()
    if (!cid) continue
    const kind = String(c?.kind || '').trim().toLowerCase()
    if (wantKinds.size && !wantKinds.has(kind)) continue
    const text = `${String(c?.label || '')} ${String(c?.ariaLabel || '')} ${String(c?.title || '')} ${String(c?.placeholder || '')}`.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (!re.test(text)) continue
    const score = Number.isFinite(Number(c?.score)) ? Number(c.score) : 0
    if (!best || score > Number(best.score || 0)) best = { cid, score }
  }
  return best?.cid ? String(best.cid) : ''
}

function parseProcedureOption(goalRaw: string) {
  const goal = String(goalRaw || '').replace(/\s+/g, ' ').trim()
  if (!goal) return ''
  const patterns = [
    /(?:切换到|改成|设为|设置为|选择|选中|打开|启用|关闭)\s*["“]?([^"”]{1,24})["”]?$/i,
    /(?:切换到|改成|设为|设置为|选择|选中)\s*["“]?([^"”]{1,24})["”]?(?:模式|选项|分类|排序|标签|tab|菜单)?/i
  ]
  for (const re of patterns) {
    const m = goal.match(re)
    const value = String(m?.[1] || '').replace(/^(为|成|到)\s*/, '').trim()
    if (value && value.length <= 24) return value
  }
  return ''
}

function parseGenericFormValue(goalRaw: string) {
  const goal = String(goalRaw || '').replace(/\s+/g, ' ').trim()
  if (!goal) return ''
  const patterns = [
    /(?:搜索|查找|查询|输入|填写)\s*[:：]\s*["“]?(.{1,80}?)["”]?(?:$|\s)/i,
    /(?:搜索|查找|查询)\s*["“]?(.{1,80}?)["”]?(?:$|\s)/i,
    /(?:输入|填写)\s*["“]?(.{1,80}?)["”]?\s*(?:并|然后|后)\s*(?:提交|发送|搜索|查询)/i
  ]
  for (const re of patterns) {
    const m = goal.match(re)
    const value = String(m?.[1] || '').trim()
    if (value) return value
  }
  return ''
}

function buildProcedureHandlers(adapterKey: string): ProcedureHandler[] {
  const genericHandlers: ProcedureHandler[] = [
    (goalRaw, ctx) => {
      const goal = String(goalRaw || '').replace(/\s+/g, ' ').trim()
      if (!/(菜单|下拉|筛选|排序|分类|标签|tab|切换|选择|设为|改成)/i.test(goal)) return null
      const option = parseProcedureOption(goal)
      if (!option || /(菜单|下拉|筛选|排序|分类|标签|选项|tab)$/i.test(option)) return null
      const menuCid =
        pickBestCandidateCidByRegex(ctx.candidates, /菜单|更多|更多选项|设置|筛选|排序|分类|标签|tab|选项|展开/i, ['button', 'link']) ||
        pickBestCandidateCidByRegex(ctx.candidates, /切换|选择|设为/i, ['button', 'link'])
      if (!menuCid) return null
      return {
        name: 'generic.open_menu_and_select',
        intents: [
          { intent: 'dismiss_overlays', reason: '多步操作：先关闭遮罩/弹窗' },
          { intent: 'click_candidate', args: { cid: menuCid }, reason: '多步操作：打开菜单/筛选/设置入口' },
          { intent: 'wait', args: { ms: 350 }, reason: '多步操作：等待菜单展开' },
          { intent: 'click_by_text', args: { text: option }, reason: `多步操作：选择 ${option}` }
        ]
      }
    },
    (goalRaw, ctx) => {
      const goal = String(goalRaw || '').replace(/\s+/g, ' ').trim()
      const value = parseGenericFormValue(goal)
      if (!value) return null
      const inputCid =
        pickBestCandidateCidByRegex(ctx.candidates, /搜索|查找|查询|输入|填写|关键字|keyword|query/i, ['input']) ||
        pickBestCandidateCidByRegex(ctx.candidates, /search|query|keyword/i, ['input']) ||
        pickBestCandidateCidByRegex(ctx.candidates, /请输入|搜索内容|输入内容/i, ['input'])
      if (!inputCid) return null
      const submitCid =
        pickBestCandidateCidByRegex(ctx.candidates, /搜索|查找|查询|提交|发送|确定|go\b|search/i, ['button', 'link']) || ''
      return {
        name: 'generic.fill_form_and_submit',
        intents: [
          { intent: 'dismiss_overlays', reason: '多步操作：先关闭遮罩/弹窗' },
          { intent: 'type_into', args: { cid: inputCid, text: value }, reason: '多步操作：填写输入框' },
          { intent: 'wait', args: { ms: 150 }, reason: '多步操作：等待输入状态稳定' },
          submitCid
            ? { intent: 'click_candidate', args: { cid: submitCid }, reason: '多步操作：提交表单' }
            : { intent: 'type_into', args: { cid: inputCid, text: `${value}\n` }, reason: '多步操作：按 Enter 提交表单' }
        ]
      }
    },
    (goalRaw) => {
      const goal = String(goalRaw || '').replace(/\s+/g, ' ').trim()
      if (!/(打开第[一1]个|打开第一条|打开首个|进入第一条|进入首个|进入详情|打开详情|open first|first result|first item|详情页)/i.test(goal)) return null
      return {
        name: 'generic.collect_list_items_and_open_first',
        intents: [{ intent: 'open_first_result', reason: '多步操作：打开第一个结果/进入详情页' }]
      }
    }
  ]
  return genericHandlers
}

function planPerformByProcedures(goalRaw: string, ctx: PerformContext): ProcedurePlan | null {
  const goal = String(goalRaw || '').replace(/\s+/g, ' ').trim()
  if (!goal) return null
  for (const handler of buildProcedureHandlers(String(ctx.adapterKey || ''))) {
    const plan = handler(goal, ctx)
    if (plan?.intents?.length) return { ...plan, intents: plan.intents.slice(0, 6) }
  }
  return null
}

async function detectMediaQualitySatisfied(page: Page, wantRaw: string) {
  const want = String(wantRaw || '').replace(/\s+/g, '').toUpperCase()
  const ok = await page
    .evaluate((w) => {
      const doc: any = (globalThis as any).document
      const win: any = (globalThis as any).window
      const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
      const isVisible = (el: any) => {
        try {
          const st = win?.getComputedStyle?.(el)
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
          const r = el?.getBoundingClientRect?.()
          if (!r) return false
          if (r.width <= 2 || r.height <= 2) return false
          if (r.bottom < 0 || r.right < 0) return false
          return true
        } catch {
          return false
        }
      }
      const isActive = (el: any) => {
        const ap = String(el?.getAttribute?.('aria-pressed') || '').trim().toLowerCase()
        if (ap === 'true') return true
        const ac = String(el?.getAttribute?.('aria-checked') || '').trim().toLowerCase()
        if (ac === 'true') return true
        const cls = String(el?.className || '').toLowerCase()
        if (/(active|selected|checked|on|current|is-active)\b/.test(cls)) return true
        return false
      }
      const pickMainVideo = () => {
        const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
        let best: any = null
        let bestScore = -1
        for (const v of vids) {
          if (!v || !isVisible(v)) continue
          const w = Number(v?.videoWidth || 0)
          const h = Number(v?.videoHeight || 0)
          const area = Math.max(0, w) * Math.max(0, h)
          const readyState = Number(v?.readyState || 0)
          const paused = !!v?.paused
          const ended = !!v?.ended
          const score = area + readyState * 100_000 + (paused ? 0 : 30_000) + (ended ? 0 : 10_000)
          if (score > bestScore) {
            bestScore = score
            best = v
          }
        }
        return best || vids[0] || null
      }
      const want = String(w || '').replace(/\s+/g, '').toUpperCase()
      const selectors = [
        '[class*="quality" i]',
        '[class*="resolution" i]',
        '[class*="setting" i]',
        'button',
        '[role="button"]',
        '[aria-label]',
        '[title]'
      ]
      const nodes = Array.from(doc?.querySelectorAll?.(selectors.join(', ')) ?? []) as any[]
      const wantNorm = want.replace(/\s+/g, '')
      for (const el of nodes) {
        const labelRaw =
          String(el?.getAttribute?.('aria-label') || '').trim() ||
          String(el?.getAttribute?.('title') || '').trim() ||
          toText(el)
        const s = String(labelRaw || '').replace(/\s+/g, '').toUpperCase()
        if (!s) continue
        const looksLikeQuality = /(4K|8K|1080P|720P|480P|360P|原画|蓝光|清晰度|画质)/i.test(s)
        if (!looksLikeQuality) continue
        const active = isActive(el)
        if (wantNorm && s.includes(wantNorm) && (active || /当前|已选|已切换|现为/i.test(String(labelRaw)))) return true
        if (!wantNorm && active && looksLikeQuality) return true
      }
      const panels = Array.from(doc?.querySelectorAll?.('[class*="quality" i], [class*="setting" i], [class*="resolution" i]') ?? []) as any[]
      for (const root of panels) {
        if (!isVisible(root)) continue
        const txt = String(toText(root) || '').replace(/\s+/g, '').toUpperCase()
        if (!txt) continue
        if (wantNorm && txt.includes(wantNorm) && /(当前|已选|已切换|√|✓|选中|生效)/i.test(txt)) return true
      }
      const v = pickMainVideo()
      const h = v ? Number(v.videoHeight || 0) : 0
      if (want === '1080P') return h >= 900
      if (want === '720P') return h >= 600
      if (want === '480P') return h >= 420
      if (want === '360P') return h >= 300
      if (want === '4K') return h >= 1700
      if (want === '8K') return h >= 3300
      return false
    }, want)
    .catch(() => false)
  return !!ok
}

async function detectMediaRateSatisfied(page: Page, wantRaw: string) {
  const want = Number(String(wantRaw || '').trim())
  const ok = await page
    .evaluate((n) => {
      const doc: any = (globalThis as any).document
      const win: any = (globalThis as any).window
      const isVisible = (el: any) => {
        try {
          const st = win?.getComputedStyle?.(el)
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
          const r = el?.getBoundingClientRect?.()
          if (!r) return false
          if (r.width <= 2 || r.height <= 2) return false
          if (r.bottom < 0 || r.right < 0) return false
          return true
        } catch {
          return false
        }
      }
      const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
      const pickMainVideo = () => {
        const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
        let best: any = null
        let bestScore = -1
        for (const v of vids) {
          if (!v || !isVisible(v)) continue
          const w = Number(v?.videoWidth || 0)
          const h = Number(v?.videoHeight || 0)
          const area = Math.max(0, w) * Math.max(0, h)
          const readyState = Number(v?.readyState || 0)
          const paused = !!v?.paused
          const ended = !!v?.ended
          const score = area + readyState * 100_000 + (paused ? 0 : 30_000) + (ended ? 0 : 10_000)
          if (score > bestScore) {
            bestScore = score
            best = v
          }
        }
        return best || vids[0] || null
      }
      const v = pickMainVideo()
      const r = v ? Number(v.playbackRate || 1) : 1
      if (Number.isFinite(n) && n > 0) return Math.abs(r - n) <= 0.06
      const nodes = Array.from(doc?.querySelectorAll?.('[class*="playback" i], [class*="rate" i], button, [role="button"], [aria-label], [title]') ?? []) as any[]
      for (const el of nodes) {
        if (!isVisible(el)) continue
        const txt = toText(el).replace(/\s+/g, '')
        if (!txt) continue
        if (!/(倍速|x$|播放速度)/i.test(txt)) continue
        if (Math.abs(Number(txt.replace(/[^\d.]+/g, '') || 1) - n) <= 0.06) return true
      }
      return Math.abs(r - 1) >= 0.06
    }, want)
    .catch(() => false)
  return !!ok
}

async function detectMediaDanmakuSatisfied(page: Page, wantRaw: string) {
  const want = String(wantRaw || '').trim().toLowerCase()
  const ok = await page
    .evaluate((mode) => {
      const doc: any = (globalThis as any).document
      const win: any = (globalThis as any).window
      const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
      const isVisible = (el: any) => {
        try {
          const st = win?.getComputedStyle?.(el)
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
          const r = el?.getBoundingClientRect?.()
          if (!r) return false
          if (r.width <= 2 || r.height <= 2) return false
          if (r.bottom < 0 || r.right < 0) return false
          return true
        } catch {
          return false
        }
      }
      const isOnByToggle = (el: any) => {
        const ap = String(el?.getAttribute?.('aria-pressed') || '').trim().toLowerCase()
        if (ap === 'true') return true
        if (ap === 'false') return false
        const ac = String(el?.getAttribute?.('aria-checked') || '').trim().toLowerCase()
        if (ac === 'true') return true
        if (ac === 'false') return false
        const cls = String(el?.className || '').toLowerCase()
        if (/(off|disabled|closed)\b/.test(cls)) return false
        if (/(active|selected|checked|on|open|enabled|is-active)\b/.test(cls)) return true
        const label = `${String(el?.getAttribute?.('aria-label') || '')} ${String(el?.getAttribute?.('title') || '')} ${toText(el)}`.toLowerCase()
        if (/开启弹幕|关闭弹幕/.test(label)) return /关闭弹幕/.test(label)
        return null
      }
      const toggles = Array.from(doc?.querySelectorAll?.('[class*="danmaku" i], button, [role="button"], [aria-label], [title]') ?? []) as any[]
      for (const el of toggles) {
        const label = `${String(el?.getAttribute?.('aria-label') || '')} ${String(el?.getAttribute?.('title') || '')} ${toText(el)}`.trim()
        if (!/弹幕|danmaku/i.test(label)) continue
        const on = isOnByToggle(el)
        if (on === null) continue
        if (mode === 'on') return !!on
        if (mode === 'off') return !on
        return true
      }
      return mode !== 'on' && mode !== 'off'
    }, want)
    .catch(() => false)
  return !!ok
}

async function detectMediaCommentPosted(page: Page, textRaw: string) {
  const text = String(textRaw || '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  for (let i = 0; i < 5; i++) {
    const ok = await page
      .evaluate((needle) => {
        const doc: any = (globalThis as any).document
        const win: any = (globalThis as any).window
        const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
        const isVisible = (el: any) => {
          try {
            const st = win?.getComputedStyle?.(el)
            if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
            const r = el?.getBoundingClientRect?.()
            if (!r) return false
            if (r.width <= 2 || r.height <= 2) return false
            if (r.bottom < 0 || r.right < 0) return false
            return true
          } catch {
            return false
          }
        }
        const n = String(needle || '').trim()
        if (!n) return false
        const toastNodes = Array.from(
          doc?.querySelectorAll?.('[role="alert"], [aria-live], [class*="toast" i], [class*="message" i], [class*="notification" i]') ?? []
        ) as any[]
        for (const el of toastNodes) {
          if (!isVisible(el)) continue
          const txt = toText(el)
          if (/成功|已发送|发布|发表|评论成功|发送成功/i.test(txt)) return true
        }
        const roots = [
          doc?.querySelector?.('#comment'),
          doc?.querySelector?.('[data-anchor-id="comment"]'),
          doc?.querySelector?.('[class*="comment-container" i]'),
          doc?.querySelector?.('[class*="comment-list" i]'),
          doc?.querySelector?.('[class*="reply" i]'),
          doc?.querySelector?.('[class*="comment" i]'),
          doc?.querySelector?.('main'),
          doc?.body
        ].filter(Boolean) as any[]
        for (const root of roots) {
          const nodes = Array.from(root?.querySelectorAll?.('span, div, p, li') ?? []) as any[]
          for (const el of nodes) {
            if (!isVisible(el)) continue
            const t = toText(el)
            if (!t || t.length < Math.max(2, Math.min(8, n.length))) continue
            if (t.includes(n)) return true
          }
        }
        return false
      }, text)
      .catch(() => false)
    if (ok) return true
    if (i < 4) await page.waitForTimeout(650).catch(() => {})
  }
  return false
}

async function verifyIntentSatisfied(
  page: Page,
  intentRaw: string,
  opts: {
    pageUrl?: string
    lastCommentText?: string
    lastQualityWanted?: string
    lastRateWanted?: string
    lastDanmakuWanted?: string
    attempts?: number
    waitMs?: number
  } = {}
) {
  const intent = String(intentRaw || '').trim()
  if (!intent) return false
  const attempts = Math.max(1, Math.min(8, Math.floor(Number(opts.attempts || 1))))
  const waitMs = Math.max(100, Math.min(2000, Math.floor(Number(opts.waitMs || 350))))
  for (let i = 0; i < attempts; i++) {
    const ok = await detectIntentSatisfied(page, intent).catch(() => false)
    if (ok) return true
    if (i < attempts - 1) await page.waitForTimeout(waitMs).catch(() => {})
  }
  return false
}

function deriveAllowedIntentsFromTask(task: string, goals: any, forbidden: Set<string>) {
  const t = String(task || '')
  const allow = new Set<string>([
    'goto',
    'scroll',
    'wait',
    'dismiss_overlays',
    'reload',
    'back',
    'click_candidate',
    'click_by_text',
    'click_by_bbox',
    'done'
  ])

  const has = (re: RegExp) => re.test(t)
  const wantsSearch = (goals && typeof goals === 'object' && !!(goals as any).mustSearch) || has(/搜索|\bsearch\b|查找|查询|查詢/i)
  const wantsOpenFirst = has(/第[一1]条|第[一1]个|第一个|首个|首条|第一条|first\s*result|open\s*first/i)
  const wantsPlay = has(/播放|观看|看视频|进入视频|打开视频|视频详情|\bplay\b|\bwatch\b|\bvideo\b|播放到|看完/i)
  const wantsExtract = (goals && typeof goals === 'object' && !!(goals as any).mustExtract) || has(/抽取|提取|获取|输出|列表|结果|\bitems\b|收集|采集/i)
  const wantsNext = has(/下一页|下页|更多|\bnext\b|\bmore\b|加载更多|更多结果/i)
  const wantsNeedCrawl = has(/爬取|抓取|\bcrawl\b/i) || (has(/详情|detail/i) && has(/全部|所有|批量|大量|多页|分页|翻页/i))
  const wantsPerform = has(/清晰度|画质|分辨率|倍速|评论|发评|发送评论|弹幕|弹\s*幕|投稿|投\s*稿|菜单|下拉|筛选|排序|分类|标签|tab|输入|填写|提交|搜索|查找|查询|第一个|第一条|详情页/i)
  const wantsType = wantsPerform || wantsSearch || has(/输入|填写|回复|评论|发评|发送评论|search|query/i)
  const wantsLike = has(/点赞|\blike\b|(^|\b)赞(?!助)\b/i)
  const wantsCoin = has(/投币|\bcoin\b|硬币/i)
  const wantsFollow = has(/关注|\bfollow\b|\bsubscribe\b|订阅/i)
  const wantsFavorite = has(/收藏|\bfavorite\b|\bstar\b/i)

  if (wantsSearch) allow.add('search')
  if (wantsSearch || wantsOpenFirst || wantsPlay || (goals && typeof goals === 'object' && !!(goals as any).mustEnterDetail)) allow.add('open_first_result')
  if (wantsNext) allow.add('paginate_next')
  if (wantsPlay) allow.add('play')
  if (wantsExtract) allow.add('extract_items')
  if (wantsNeedCrawl) allow.add('need_crawl')
  if (wantsLike) allow.add('like')
  if (wantsCoin) allow.add('coin')
  if (wantsFollow) allow.add('follow')
  if (wantsFavorite) allow.add('favorite')
  if (wantsPerform) {
    allow.add('perform')
    allow.add('dismiss_overlays')
    allow.add('wait')
  }
  if (wantsType) allow.add('type_into')

  for (const it of Array.from(forbidden)) allow.delete(it)
  return Array.from(allow)
}

function deriveAllowedIntentsFromGoals(args: {
  goals: any
  completionCriteria?: any
  forbidden: Set<string>
  wantedOps?: string[]
}) {
  const { goals, completionCriteria, forbidden, wantedOps } = args
  const allow = new Set<string>([
    'goto',
    'scroll',
    'wait',
    'dismiss_overlays',
    'reload',
    'back',
    'click_candidate',
    'click_by_text',
    'click_by_bbox',
    'done'
  ])

  const wantsSearch = !!(goals && typeof goals === 'object' && (goals as any).mustSearch)
  const wantsEnterDetail = !!(goals && typeof goals === 'object' && (goals as any).mustEnterDetail)
  const wantsExtract = !!(goals && typeof goals === 'object' && (goals as any).mustExtract)
  const extractLimit = Math.max(0, Math.floor(Number((goals as any)?.extractLimit || 0)))
  const wantsPlay = !!(completionCriteria as any)?.waitForVideoEnd || Math.floor(Number((completionCriteria as any)?.watchSeconds || 0)) > 0

  if (wantsSearch) allow.add('search')
  if (wantsSearch || wantsEnterDetail || wantsPlay || wantsExtract) allow.add('open_first_result')
  if (wantsPlay) allow.add('play')
  if (wantsExtract) {
    allow.add('extract_items')
    if (extractLimit > 5) allow.add('paginate_next')
  }
  if (wantsSearch) allow.add('type_into')

  const ops = Array.isArray(wantedOps) ? wantedOps.map((x) => normalizeIntent(String(x || ''))).filter(Boolean) : []
  const wantPerform = ops.some((op) => ['quality', 'rate', 'danmaku', 'comment'].includes(op))
  if (wantPerform) allow.add('perform')
  if (ops.includes('like')) allow.add('like')
  if (ops.includes('coin')) allow.add('coin')
  if (ops.includes('follow')) allow.add('follow')
  if (ops.includes('favorite')) allow.add('favorite')

  for (const it of Array.from(forbidden)) allow.delete(it)
  return Array.from(allow)
}

function deriveIntentsOrderFromTask(task: string, goals: any, forbidden: Set<string>) {
  const t = String(task || '')
  const order: string[] = []
  const add = (it: string) => {
    const ni = normalizeIntent(it)
    if (!ni || forbidden.has(ni)) return
    if (!order.includes(ni)) order.push(ni)
  }
  if (goals?.mustSearch) add('search')
  if (goals?.mustEnterDetail) add('open_first_result')
  const ws = Math.max(0, Math.floor(Number(goals?.watchSeconds || 0)))
  if (ws > 0 || /播放|观看|看视频|\bplay\b|\bwatch\b/i.test(t)) add('play')
  if (ws > 0) add('wait')
  if (/点赞|\blike\b|(^|\b)赞(?!助)\b/i.test(t)) add('like')
  if (/投币|\bcoin\b/i.test(t)) add('coin')
  if (/关注|\bfollow\b|\bsubscribe\b|订阅/i.test(t)) add('follow')
  if (/收藏|\bfavorite\b|\bstar\b/i.test(t)) add('favorite')
  if (goals?.mustExtract) add('extract_items')
  return order
}

function emptyClassicGoalsSkeleton(plan: any) {
  const planQ =
    plan && typeof plan === 'object'
      ? String((plan as any).searchQuery || (plan as any).query || '').trim()
      : ''
  return {
    mustSearch: false,
    searchQuery: planQ,
    watchSeconds: 0,
    mustEnterDetail: false,
    mustExtract: false,
    extractLimit: 0,
    mustReturnToListBeforeExtract: false,
    waitForVideoEnd: false,
  }
}

function defaultClassicAllowedIntents() {
  return [
    'goto',
    'search',
    'open_first_result',
    'scroll',
    'wait',
    'dismiss_overlays',
    'reload',
    'back',
    'click_candidate',
    'click_by_text',
    'click_by_bbox',
    'type_into',
    'extract_items',
    'perform',
    'play',
    'like',
    'coin',
    'follow',
    'favorite',
    'paginate_next',
    'done',
  ]
}

function clampGoalsWithHeuristics(goals: any, task: string, plan: any) {
  // P3-L1：默认关闭用户原话 regex goals；仅 LOBSTER_CLASSIC_GOALS_HEURISTIC=1 时冷启动
  if (!isClassicGoalsHeuristicEnabled()) {
    const g = goals && typeof goals === 'object' ? goals : {}
    const planQ =
      plan && typeof plan === 'object'
        ? String((plan as any).searchQuery || (plan as any).query || '').trim()
        : ''
    // 注意：禁止 `...g` 覆盖后面的规范化字段
    return {
      mustSearch: !!(g as any).mustSearch,
      searchQuery: String((g as any).searchQuery || '').trim() || planQ,
      watchSeconds: Math.max(0, Math.floor(Number((g as any).watchSeconds || 0))),
      mustEnterDetail: !!(g as any).mustEnterDetail,
      mustExtract: !!(g as any).mustExtract,
      extractLimit: Math.max(0, Math.floor(Number((g as any).extractLimit || 0))),
      mustReturnToListBeforeExtract: !!(g as any).mustReturnToListBeforeExtract,
      waitForVideoEnd: !!(g as any).waitForVideoEnd,
    }
  }
  const h = deriveGoalsFromPlan(plan, task)
  const out = { ...h, ...(goals && typeof goals === 'object' ? goals : {}) }
  if (h.mustSearch) out.mustSearch = true
  if (h.mustEnterDetail) out.mustEnterDetail = true
  if (h.mustExtract) out.mustExtract = true
  if (String(h.searchQuery || '').trim() && !String(out.searchQuery || '').trim()) out.searchQuery = h.searchQuery
  const wsH = Math.max(0, Math.floor(Number(h.watchSeconds || 0)))
  const wsO = Math.max(0, Math.floor(Number(out.watchSeconds || 0)))
  if (wsH > 0) out.watchSeconds = Math.max(wsO, wsH)
  return out
}

function deriveTaskSpecFromPlan(plan: any, task: string) {
  // 启发式关时：空 goals 骨架，由 inferTaskSpecWithModel（LLM）填充
  const goals = isClassicGoalsHeuristicEnabled()
    ? deriveGoalsFromPlan(plan, task)
    : emptyClassicGoalsSkeleton(plan)
  const summary = summarizeTask(task)
  const forbiddenRaw = isClassicGoalsHeuristicEnabled() ? parseForbiddenIntentsFromTask(task) : []
  const forbidden = normalizeForbiddenIntentsFromTaskSet(forbiddenRaw)
  const allowedIntents = isClassicGoalsHeuristicEnabled()
    ? deriveAllowedIntentsFromTask(task, goals, forbidden)
    : defaultClassicAllowedIntents()
  const waitForVideoEnd = typeof (goals as any).waitForVideoEnd === 'boolean' ? !!(goals as any).waitForVideoEnd : false
  const watchSeconds = Math.max(0, Math.floor(Number((goals as any)?.watchSeconds || 0)))
  const extractLimit = Math.max(0, Math.floor(Number((goals as any)?.extractLimit || 0)))
  const mustReturnToListBeforeExtract = !!(goals as any)?.mustReturnToListBeforeExtract
  const intentsOrder = isClassicGoalsHeuristicEnabled()
    ? deriveIntentsOrderFromTask(task, goals, forbidden)
    : ['search', 'open_first_result', 'extract_items', 'done']
  return {
    summary,
    goals,
    allowedIntents,
    forbiddenIntents: Array.from(forbidden),
    intentsOrder,
    completionCriteria: { waitForVideoEnd, watchSeconds, extractLimit, mustReturnToListBeforeExtract }
  }
}

function normalizeTaskSpec(taskSpec: any, task: string, plan: any) {
  const x = taskSpec && typeof taskSpec === 'object' ? taskSpec : null
  const summary =
    x?.summary && typeof x.summary === 'object'
      ? x.summary
      : {
          objective: '',
          targetQuery: '',
          targetEntity: '',
          constraints: {},
          successCriteria: {}
        }
  const heuristicOn = isClassicGoalsHeuristicEnabled()
  const rawGoals =
    x?.goals && typeof x.goals === 'object'
      ? x.goals
      : heuristicOn
        ? deriveGoalsFromPlan(plan, task)
        : emptyClassicGoalsSkeleton(plan)
  const goals = clampGoalsWithHeuristics(rawGoals, task, plan)
  const hasOwn = (k: string) => !!x && Object.prototype.hasOwnProperty.call(x, k)

  const cc = x?.completionCriteria && typeof x.completionCriteria === 'object' ? x.completionCriteria : {}
  const waitForVideoEnd =
    typeof (cc as any).waitForVideoEnd === 'boolean' ? !!(cc as any).waitForVideoEnd : !!(goals as any)?.waitForVideoEnd
  const watchSeconds = Math.max(0, Math.floor(Number((cc as any).watchSeconds ?? (goals as any)?.watchSeconds ?? 0)))
  const extractLimitFromCc = Math.max(0, Math.floor(Number((cc as any).extractLimit ?? (goals as any)?.extractLimit ?? 0)))

  const forbidden = (() => {
    if (hasOwn('forbiddenIntents')) {
      const arr = Array.isArray(x?.forbiddenIntents) ? x.forbiddenIntents.map(String).filter(Boolean) : []
      return arr
    }
    if (!heuristicOn) return [] as string[]
    return Array.from(normalizeForbiddenIntentsFromTaskSet(parseForbiddenIntentsFromTask(task)))
  })()

  const wantedOpsRaw = Array.isArray((x as any)?.wantedInteractionOps) ? (x as any).wantedInteractionOps.map(String).filter(Boolean) : []
  const wantedOps = Array.from(new Set(wantedOpsRaw.map((op: string) => normalizeIntent(op)).filter(Boolean)))

  const allowed = (() => {
    if (hasOwn('allowedIntents')) {
      const arr = Array.isArray(x?.allowedIntents) ? x.allowedIntents.map(String).filter(Boolean) : []
      const normalized = new Set<string>()
      for (const it of arr) {
        const ni = normalizeIntent(it)
        if (!ni) continue
        if (ni === 'extract') normalized.add('extract_items')
        else if (ni === 'next') normalized.add('paginate_next')
        else normalized.add(ni)
      }
      return Array.from(normalized)
    }
    if (!heuristicOn) return defaultClassicAllowedIntents()
    return deriveAllowedIntentsFromGoals({ goals, completionCriteria: { waitForVideoEnd, watchSeconds, extractLimit: extractLimitFromCc }, forbidden: new Set(forbidden), wantedOps })
  })()
  const extractLimit = extractLimitFromCc

  // 规则校验：确保 allowedIntents 与用户 goals/forbidden 不矛盾
  const forbiddenSet = new Set<string>(forbidden)
  const modelAllowedSet = new Set<string>(allowed)
  const derivedAllowedSet = new Set<string>(
    heuristicOn
      ? deriveAllowedIntentsFromGoals({ goals, completionCriteria: { waitForVideoEnd, watchSeconds, extractLimit }, forbidden: forbiddenSet, wantedOps })
      : defaultClassicAllowedIntents(),
  )
  const mergedAllowed = new Set<string>(Array.from(derivedAllowedSet))
  for (const it of Array.from(modelAllowedSet)) {
    if (!forbiddenSet.has(it)) mergedAllowed.add(it)
  }

  // 仅启发式开时按 goals 裁剪；关闭时保留宽表交 StepDecide（否则空 goals 会删 search→wait 环）
  if (heuristicOn) {
    if (!goals?.mustSearch) {
      mergedAllowed.delete('search')
      mergedAllowed.delete('type_into')
    }
    if (!goals?.mustExtract) {
      mergedAllowed.delete('extract_items')
      mergedAllowed.delete('paginate_next')
    }
    if (!waitForVideoEnd && watchSeconds <= 0) mergedAllowed.delete('play')
  }

  const intentsOrder = (() => {
    const fromModel = Array.isArray((x as any)?.intentsOrder)
      ? ((x as any).intentsOrder as any[])
          .map((s: any) => normalizeIntent(String(s || '')))
          .filter(Boolean)
          .slice(0, 12)
      : []
    if (fromModel.length) return fromModel
    if (!heuristicOn) return ['search', 'open_first_result', 'extract_items', 'done']
    return deriveIntentsOrderFromTask(task, goals, forbiddenSet)
  })()
  const priority =
    (x as any)?.priority && typeof (x as any).priority === 'object'
      ? {
          primary: String((x as any).priority.primary || '').trim(),
          secondary: Array.isArray((x as any).priority.secondary)
            ? (x as any).priority.secondary.map((s: any) => String(s || '').trim()).filter(Boolean).slice(0, 8)
            : []
        }
      : { primary: '', secondary: [] as string[] }
  const mustReturnToListBeforeExtract =
    typeof (cc as any).mustReturnToListBeforeExtract === 'boolean'
      ? !!(cc as any).mustReturnToListBeforeExtract
      : !!(goals as any)?.mustReturnToListBeforeExtract
  const recipeHints = resultPageHintsFor(task, String((plan as any)?.startUrl || ''))
  const successCriteria = mergeSuccessCriteria(
    (summary as any)?.successCriteria || (x as any)?.successCriteria,
    recipeHints,
  )
  return {
    summary: { ...summary, successCriteria },
    goals,
    allowedIntents: Array.from(mergedAllowed),
    forbiddenIntents: forbidden,
    intentsOrder,
    priority,
    wantedInteractionOps: wantedOps,
    successCriteria,
    completionCriteria: { waitForVideoEnd, watchSeconds, extractLimit, mustReturnToListBeforeExtract }
  }
}

const taskSpecModelOutputSchema = z
  .object({
    summary: z
      .object({
        objective: z.string().optional(),
        targetQuery: z.string().optional(),
        targetEntity: z.string().optional(),
        // Zod 4.3.x：单参 z.record(z.any()) 会把 valueType 建成 undefined → safeParse 读 ._zod 崩溃
        constraints: z.record(z.string(), z.any()).optional(),
        successCriteria: z.record(z.string(), z.any()).optional()
      })
      .optional(),
    goals: z
      .object({
        mustSearch: z.boolean().optional(),
        searchQuery: z.string().optional(),
        watchSeconds: z.number().optional(),
        mustEnterDetail: z.boolean().optional(),
        mustExtract: z.boolean().optional(),
        extractLimit: z.number().optional(),
        mustReturnToListBeforeExtract: z.boolean().optional(),
        waitForVideoEnd: z.boolean().optional()
      })
      .optional(),
    allowedIntents: z.array(z.string()).optional(),
    forbiddenIntents: z.array(z.string()).optional(),
    intentsOrder: z.array(z.string()).optional(),
    priority: z
      .object({
        primary: z.string().optional(),
        secondary: z.array(z.string()).optional()
      })
      .optional(),
    completionCriteria: z
      .object({
        waitForVideoEnd: z.boolean().optional(),
        watchSeconds: z.number().optional(),
        extractLimit: z.number().optional(),
        mustReturnToListBeforeExtract: z.boolean().optional()
      })
      .optional(),
    wantedInteractionOps: z.array(z.string()).optional()
  })
  .passthrough()

async function inferTaskSpecWithModel(model: any, task: string, plan: any, fallback: any) {
  if (!model) return fallback
  const prompt = [
    '你是网页 Agent 的任务理解器。',
    '请把用户任务理解为可执行的 taskSpec，只输出一个 JSON 对象（不要 Markdown、不要解释）。',
    '字段要求：',
    '- summary: { objective, targetQuery, targetEntity, constraints, successCriteria }',
    '- goals: { mustSearch:boolean, searchQuery:string, watchSeconds:number, mustEnterDetail:boolean, mustExtract:boolean, extractLimit:number, mustReturnToListBeforeExtract:boolean }',
    '- allowedIntents: string[]',
    '- forbiddenIntents: string[]',
    '- intentsOrder: string[]（按执行优先级排序，如["search","open_first_result","play"]）',
    '- priority: { primary: string, secondary: string[] }',
    '- completionCriteria: { waitForVideoEnd:boolean, watchSeconds:number, extractLimit:number, mustReturnToListBeforeExtract:boolean }',
    '- wantedInteractionOps: string[]（仅列出用户明确要求的复杂交互：like/coin/favorite/follow/quality/rate/danmaku/comment/fullscreen；没有就填 []）',
    '规则：',
    '- allowedIntents 只保留和用户目标直接相关的最小集合。',
    '- forbiddenIntents 只在用户明确禁止时给出，不要臆测。',
    '- 如果用户没要求抽取，mustExtract=false 且不要把 extract_items 放进 allowedIntents。',
    '- 用户说「第一条/第一个结果/看N秒/点赞」时：mustEnterDetail=true、watchSeconds=N、intentsOrder 按 search→open_first_result→play→wait→like 排列。',
    '',
    `用户任务：${task}`,
    `规划结果：${JSON.stringify(plan || {})}`,
    `回退 taskSpec（仅供参考）：${JSON.stringify(fallback || {})}`
  ].join('\n')
  const resp = await model.invoke(prompt).catch(() => ({ content: '' } as any))
  const parsed = extractFirstJsonObject(String((resp as any)?.content ?? ''))
  if (!parsed || typeof parsed !== 'object') return fallback

  const safe = taskSpecModelOutputSchema.safeParse(parsed)
  if (!safe.success) return fallback
  return normalizeTaskSpec(safe.data, task, plan)
}

function buildStableTextRegex(text: string) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return new RegExp(`^\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
}

function buildLooseTextRegex(text: string) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

async function detectVideoPlaybackState(page: Page) {
  const st = await page
    .evaluate(() => {
      const doc: any = (globalThis as any).document
      const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
      const pick = () => {
        for (const v of vids) {
          if (!v) continue
          const w = Number(v?.videoWidth || 0)
          const h = Number(v?.videoHeight || 0)
          if (w >= 200 && h >= 120) return v
        }
        return vids[0] || null
      }
      const v: any = pick()
      if (!v) return { hasVideo: false, paused: true, ended: false, currentTime: 0, duration: 0, readyState: 0 }
      const paused = !!v.paused
      const ended = !!v.ended
      const currentTime = Number(v.currentTime || 0)
      const duration = Number(v.duration || 0)
      const readyState = Number(v.readyState || 0)
      return { hasVideo: true, paused, ended, currentTime, duration, readyState }
    })
    .catch(() => ({ hasVideo: false, paused: true, ended: false, currentTime: 0, duration: 0, readyState: 0 }))
  return st as { hasVideo: boolean; paused: boolean; ended: boolean; currentTime: number; duration: number; readyState: number }
}

async function detectVideoPlaybackStateDeep(page: Page) {
  const frames = page.frames()
  const results = await Promise.all(
    frames.map(async (f) => {
      try {
        const r = await f.evaluate(() => {
          const doc: any = (globalThis as any).document
          const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
          let best: any = null
          let bestScore = -1
          for (const v of vids) {
            if (!v) continue
            const w = Number(v?.videoWidth || 0)
            const h = Number(v?.videoHeight || 0)
            const area = w > 0 && h > 0 ? w * h : 0
            const rs = Number(v?.readyState || 0)
            const paused = !!v.paused
            const ended = !!v.ended
            const currentTime = Number(v.currentTime || 0)
            const duration = Number(v.duration || 0)
            const score = area + rs * 100_000 + (paused ? 0 : 30_000) + (ended ? 0 : 10_000)
            if (score > bestScore) {
              bestScore = score
              best = { w, h, area, paused, ended, currentTime, duration, readyState: rs }
            }
          }
          if (!best) return { hasVideo: false, paused: true, ended: false, currentTime: 0, duration: 0, readyState: 0, area: 0 }
          return { hasVideo: true, ...best }
        })
        return { ok: true as const, frameUrl: String(f.url() || ''), ...r }
      } catch (e: any) {
        return { ok: false as const, frameUrl: String(f.url() || ''), error: e?.message ? String(e.message) : String(e) }
      }
    })
  )
  const candidates = results.filter((x: any) => x && x.ok && x.hasVideo)
  if (!candidates.length) return { hasVideo: false, paused: true, ended: false, currentTime: 0, duration: 0, readyState: 0 }
  candidates.sort((a: any, b: any) => (Number(b.area || 0) - Number(a.area || 0)) || (Number(b.readyState || 0) - Number(a.readyState || 0)))
  const best = candidates[0] as any
  return {
    hasVideo: !!best.hasVideo,
    paused: !!best.paused,
    ended: !!best.ended,
    currentTime: Number(best.currentTime || 0),
    duration: Number(best.duration || 0),
    readyState: Number(best.readyState || 0)
  }
}

async function detectFullscreenSatisfied(page: Page) {
  const ok = await page
    .evaluate(() => {
      const doc: any = (globalThis as any).document
      const el = doc?.fullscreenElement
      return !!el
    })
    .catch(() => false)
  return !!ok
}

function splitSelectorList(selector: string) {
  return String(selector || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeUrlForCompare(url: string) {
  const u = String(url || '').trim()
  if (!u) return ''
  try {
    const x = new URL(u)
    x.hash = ''
    for (const [k] of Array.from(x.searchParams.entries())) {
      if (/^utm_/i.test(k)) x.searchParams.delete(k)
    }
    ;['spm_id_from', 'from_source', 'vd_source', 'share_source'].forEach((k) => x.searchParams.delete(k))
    const s = x.toString()
    return s.endsWith('/') ? s.slice(0, -1) : s
  } catch {
    return u.endsWith('/') ? u.slice(0, -1) : u
  }
}

function sleepMs(ms: number) {
  const t = Number(ms || 0)
  if (!Number.isFinite(t) || t <= 0) return Promise.resolve()
  return new Promise<void>((r) => setTimeout(r, Math.floor(t)))
}

function textDigest(text: string) {
  const s = String(text || '')
  const clipped = s.length > 6000 ? s.slice(0, 6000) : s
  try {
    return crypto.createHash('sha1').update(clipped).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

function normalizeHost(host: string) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '')
}

function registrableDomainHeuristic(host: string) {
  const h = normalizeHost(host)
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 1) return h
  const tail2 = parts.slice(-2).join('.')
  const secondLevel = parts[parts.length - 2]
  const ccSecondLevels = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])
  if (ccSecondLevels.has(String(secondLevel || '')) && parts.length >= 3) return parts.slice(-3).join('.')
  return tail2
}

function isHostSuffixMatch(host: string, suffix: string) {
  const h = normalizeHost(host)
  const s = normalizeHost(suffix)
  if (!h || !s) return false
  if (h === s) return true
  return h.endsWith(`.${s}`)
}

function isBlockedHostname(host: string) {
  const h = normalizeHost(host)
  if (!h) return true
  if (h === 'localhost' || h === 'localhost.localdomain') return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.test')) return true
  return false
}

function isPrivateIp(ip: string) {
  const addr = String(ip || '').trim()
  const v = net.isIP(addr)
  if (!v) return false
  if (v === 4) {
    const parts = addr.split('.').map((x) => Number(x))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    if (a === 0) return true
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  const s = addr.toLowerCase()
  if (s === '::' || s === '::1') return true
  if (s.startsWith('fe80:')) return true
  if (s.startsWith('fc') || s.startsWith('fd')) return true
  if (s.startsWith('2001:db8:')) return true
  return false
}

const hostPublicCache = new Map<string, { ok: boolean; ts: number }>()
async function isPublicHostname(host: string, timeoutMs: number) {
  const h = normalizeHost(host)
  if (!h) return false
  if (isBlockedHostname(h)) return false
  const cached = hostPublicCache.get(h)
  const now = Date.now()
  if (cached && now - cached.ts < 5 * 60 * 1000) return cached.ok
  if (net.isIP(h)) {
    const ok = !isPrivateIp(h)
    hostPublicCache.set(h, { ok, ts: now })
    return ok
  }
  const lookup = dns.lookup(h, { all: true, verbatim: true })
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), Math.max(200, timeoutMs)))
  try {
    const addrs = (await Promise.race([lookup, timer])) as Array<{ address: string }>
    const ok = Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => !isPrivateIp(String(a.address || '')))
    hostPublicCache.set(h, { ok, ts: now })
    return ok
  } catch {
    hostPublicCache.set(h, { ok: false, ts: now })
    return false
  }
}

function effectivePort(u: URL) {
  if (u.port) {
    const p = Number(u.port)
    return Number.isFinite(p) && p > 0 && p <= 65535 ? Math.floor(p) : 0
  }
  if (u.protocol === 'https:') return 443
  if (u.protocol === 'http:') return 80
  return 0
}

function isAllowedPortForCrawl(port: number, basePort: number) {
  const p = Number(port || 0)
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return false
  if (p === 80 || p === 443) return true
  if (p === basePort) return true
  if (p === 8080 || p === 8443) return true
  return false
}

async function readTextWithLimit(res: Response, maxBytes: number, signal: AbortSignal) {
  const max = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 512_000
  if (!res.body) return ''
  const reader = (res.body as any).getReader?.()
  if (!reader) {
    const t = await res.text().catch(() => '')
    return t.length > max ? t.slice(0, max) : t
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    if (signal.aborted) throw new Error('canceled')
    const { done, value } = await reader.read()
    if (done) break
    const buf = value as Uint8Array
    total += buf.byteLength
    if (total > max) throw new Error('response too large')
    chunks.push(buf)
  }
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(all)
}

async function safeFetchText(rawUrl: string, opts: { signal: AbortSignal; timeoutMs: number; maxBytes: number; allowHostSuffixes: string[]; basePort: number; minIntervalMs: number }) {
  const timeoutMs = Math.max(500, Math.floor(Number(opts.timeoutMs || 0) || 12000))
  const maxBytes = Math.max(10_000, Math.floor(Number(opts.maxBytes || 0) || 512_000))
  const allowHostSuffixes = Array.isArray(opts.allowHostSuffixes) ? opts.allowHostSuffixes.map(String).filter(Boolean) : []
  const basePort = Number(opts.basePort || 0)
  const minIntervalMs = Math.max(0, Math.floor(Number(opts.minIntervalMs || 0) || 0))
  const redirects = 5
  let current = String(rawUrl || '').trim()
  let lastUrl = current

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  opts.signal.addEventListener('abort', onAbort, { once: true })

  try {
    for (let i = 0; i <= redirects; i++) {
      const u = new URL(current)
      if (u.username || u.password) throw new Error('url contains credentials')
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol')
      const host = normalizeHost(u.hostname)
      if (isBlockedHostname(host)) throw new Error('blocked hostname')
      if (allowHostSuffixes.length && !allowHostSuffixes.some((s) => isHostSuffixMatch(host, s))) throw new Error('host not allowed')
      if (!isAllowedPortForCrawl(effectivePort(u), basePort)) throw new Error('port not allowed')
      const publicOk = await isPublicHostname(host, 1500)
      if (!publicOk) throw new Error('host resolves to private ip')

      if (minIntervalMs > 0) await sleepMs(minIntervalMs)

      const res = await fetch(u.toString(), { signal: controller.signal, redirect: 'manual' })
      lastUrl = String((res as any).url || u.toString())
      if (res.status >= 300 && res.status < 400) {
        const loc = String(res.headers.get('location') || '').trim()
        if (!loc) throw new Error('redirect without location')
        const next = new URL(loc, u).toString()
        current = next
        continue
      }

      const ct = String(res.headers.get('content-type') ?? '')
      const isText = /text\/html|application\/json|text\/plain/i.test(ct)
      const text = isText ? await readTextWithLimit(res, maxBytes, controller.signal) : ''
      return { finalUrl: lastUrl, status: res.status, contentType: ct, text }
    }
    throw new Error('too many redirects')
  } finally {
    clearTimeout(t)
    try {
      opts.signal.removeEventListener('abort', onAbort as any)
    } catch {}
  }
}

function actionKey(action: Action) {
  const t = String(action?.type || '')
  if (t === 'goto') return `goto:${normalizeUrlForCompare((action as any).url || '')}`
  if (t === 'click') return `click:${String((action as any).selector || '').trim()}`
  if (t === 'click_candidate') return `click_candidate:${String((action as any).index ?? '')}`
  if (t === 'click_by_bbox') return `click_by_bbox:${String((action as any).index ?? '')}`
  if (t === 'click_by_text') return `click_by_text:${String((action as any).text || '').trim().slice(0, 80)}`
  if (t === 'type') return `type:${String((action as any).selector || '').trim()}:${String((action as any).text || '').trim().slice(0, 80)}`
  if (t === 'type_candidate') return `type_candidate:${String((action as any).index ?? '')}:${String((action as any).text || '').trim().slice(0, 80)}`
  if (t === 'scroll') return `scroll:${String((action as any).dy || '')}`
  if (t === 'wait') return `wait:${String((action as any).ms || '')}`
  if (t === 'ensure_play') return 'ensure_play'
  if (t === 'extract')
    return `extract:${Array.isArray((action as any).fields) ? (action as any).fields.join(',') : ''}:${String((action as any).limit ?? '')}`
  if (t === 'dismiss_overlays') return 'dismiss_overlays'
  if (t === 'reload') return 'reload'
  if (t === 'back') return 'back'
  if (t === 'need_crawl') return 'need_crawl'
  if (t === 'done') return 'done'
  return t
}

function looksLikeLoginUrl(url: string) {
  const u = String(url || '')
  return /(login|signin|passport|oauth|auth|sso)/i.test(u)
}

function classifyFailureType(message: string, pageUrl: string) {
  const msg = String(message || '')
  const u = String(pageUrl || '')
  if (/canceled/i.test(msg)) return 'canceled'
  if (/human denied/i.test(msg)) return 'denied'
  if (/no_effect/i.test(msg)) return 'no_effect'
  if (/blocked hostname|host not allowed|port not allowed|host resolves to private ip/i.test(msg)) return 'crawler_blocked'
  if (/response too large/i.test(msg)) return 'crawler_too_large'
  if (/dns timeout/i.test(msg)) return 'dns_timeout'
  if (/timeout|timed out/i.test(msg)) return 'timeout'
  if (/Target closed|Browser has been closed|closed/i.test(msg)) return 'target_closed'
  if (/net::ERR|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_NAME_NOT_RESOLVED/i.test(msg)) return 'network'
  if (/索引无效|invalid/i.test(msg)) return 'bad_candidate'
  if (/strict mode violation/i.test(msg)) return 'selector_ambiguous'
  if (/waiting for selector|No node found|No element found|resolved to 0 elements/i.test(msg)) return 'selector_not_found'
  if (/Element is not attached|detached/i.test(msg)) return 'detached'
  if (/not visible|outside of the viewport|not in viewport/i.test(msg)) return 'not_visible'
  if (/receiving pointer events|another element|intercepts pointer events|not clickable/i.test(msg)) return 'blocked_by_overlay'
  if (/captcha|recaptcha|turnstile|cloudflare|人机|验证|安全校验/i.test(msg)) return 'captcha'
  if (/429|too many requests|rate limit/i.test(msg)) return 'rate_limited'
  if (looksLikeLoginUrl(u) || /登录|注册|sign in|log in|passport/i.test(msg)) return 'need_login'
  return 'unknown'
}

function pickAdapterKey(_url: string) {
  return 'generic'
}


async function detectLoginSignals(page: Page) {
  const result = await page
    .evaluate(() => {
      const doc: any = (globalThis as any).document
      const root = doc?.querySelector?.('header') || doc?.body
      const text = String(root?.innerText || '').replace(/\s+/g, ' ').trim()
      const hasLogout = /(退出|登出|注销|logout|sign out)/i.test(text)
      const hasLogin = /(登录|注册|sign in|log in)/i.test(text)
      const hasAvatar = !!(doc?.querySelector?.('img[class*="avatar" i]') || doc?.querySelector?.('[class*="avatar" i]'))
      return { hasLogout, hasLogin, hasAvatar }
    })
    .catch(() => ({ hasLogout: false, hasLogin: false, hasAvatar: false }))
  return result as { hasLogout: boolean; hasLogin: boolean; hasAvatar: boolean }
}

async function extractGenericListItems(page: Page, limit: number) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5
  const items = await page
    .evaluate((maxItems) => {
      const doc: any = (globalThis as any).document
      const root =
        doc?.querySelector?.('main') ||
        doc?.querySelector?.('#app') ||
        doc?.querySelector?.('#root') ||
        doc?.body
      const toText = (el: any) => String(el?.textContent || '').replace(/\s+/g, ' ').trim()
      const anchors = Array.from((root?.querySelectorAll?.('a[href]') as any) ?? []) as any[]
      const out: any[] = []
      const seen = new Set<string>()
      const badHref = (h: string) =>
        !h ||
        /^javascript:/i.test(h) ||
        /^mailto:/i.test(h) ||
        /#/.test(h) ||
        /\/login\b/i.test(h)
      for (const a of anchors) {
        const href = String(a?.href || '').trim()
        if (badHref(href)) continue
        if (!/^https?:\/\//i.test(href)) continue
        if (seen.has(href)) continue
        const title = String(a?.getAttribute?.('title') || '').trim() || toText(a)
        if (!title || title.length < 4) continue
        const rootCard = a?.closest?.('article') || a?.closest?.('li') || a?.closest?.('div') || a?.parentElement
        const author =
          (rootCard && (toText(rootCard.querySelector?.('a[rel="author"]')) || toText(rootCard.querySelector?.('[class*="author"]')))) ||
          ''
        seen.add(href)
        out.push({ title, url: href, author })
        if (out.length >= maxItems) break
      }
      return out
    }, n)
    .catch(() => [] as any[])

  return Array.isArray(items) ? items : []
}

async function adoptPopup(session: BrowserSession, popup: Page | null) {
  if (!popup) return false
  try {
    if ((popup as any).isClosed?.()) return false
  } catch {}
  try {
    await popup.waitForLoadState('domcontentloaded', { timeout: 5000 })
  } catch {}
  const prev = session.page
  session.page = popup
  try {
    if (prev !== popup) await prev.close()
  } catch {}
  return true
}

async function tryFocus(page: Page, selectorList: string[]) {
  for (const sel of selectorList) {
    try {
      const loc = page.locator(sel).first()
      const count = await loc.count().catch(() => 0)
      if (!count) continue
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.focus({ timeout: 2500 }).catch(() => {})
      return { ok: true as const, selector: sel }
    } catch {}
  }
  return { ok: false as const, selector: selectorList[0] || '' }
}

async function tryClick(page: Page, selectorList: string[]) {
  for (const sel of selectorList) {
    try {
      const loc = page.locator(sel).first()
      const count = await loc.count().catch(() => 0)
      if (!count) continue
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click({ timeout: 2500 })
      return { ok: true as const, selector: sel }
    } catch {}
  }
  return { ok: false as const, selector: selectorList[0] || '' }
}

async function tryFill(page: Page, selectorList: string[], text: string) {
  for (const sel of selectorList) {
    try {
      const loc = page.locator(sel).first()
      const count = await loc.count().catch(() => 0)
      if (!count) continue
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.fill(text, { timeout: 2500 })
      return { ok: true as const, selector: sel }
    } catch {}
  }
  return { ok: false as const, selector: selectorList[0] || '' }
}

async function tryDismissOverlays(page: Page) {
  try {
    await page.keyboard.press('Escape').catch(() => {})
  } catch {}
  try {
    await page
      .evaluate(() => {
        const doc: any = (globalThis as any).document
        const toText = (el: any) => String(el?.textContent || '').replace(/\s+/g, ' ').trim()
        const safeRe = /(关闭|关\s*闭|取消|我知道了|知道了|好的|允许|同意|接受|accept|allow|agree|ok|got it|dismiss|close)/i
        const biliSafeRe = /(暂不登录|稍后再说|以后再说|游客|跳过登录|跳过)/i
        const dangerousRe = /(购买|支付|下单|提交订单|确认支付|删除|移除|退订|开通|订阅|充值)/i
        const nodes = Array.from(
          doc?.querySelectorAll?.('button, [role="button"], a, [aria-label], [title], span, div') ?? []
        ) as any[]
        let clicked = 0
        for (const el of nodes) {
          if (clicked >= 4) break
          const label =
            String(el?.getAttribute?.('aria-label') || '').trim() ||
            String(el?.getAttribute?.('title') || '').trim() ||
            toText(el)
          const s = String(label || '')
          if (!s || s.length > 40) continue
          if (dangerousRe.test(s)) continue
          if (!safeRe.test(s) && !biliSafeRe.test(s)) continue
          try {
            ;(el as any).click?.()
            clicked++
            if (biliSafeRe.test(s)) return clicked
          } catch {}
        }
        const closeSel =
          '.bili-mini-mask-close, .login-tip-close, [class*="close" i][class*="icon" i], .close-btn'
        const closeBtn = doc?.querySelector?.(closeSel)
        if (closeBtn) {
          try {
            closeBtn.click?.()
            clicked++
          } catch {}
        }
        return clicked
      })
      .catch(() => 0)
  } catch {}
}

function intentFromReason(reason: any) {
  const s = String(reason || '').trim()
  const m = s.match(/\bintent:([a-z_]+)(?::([^\s]+))?\b/i)
  if (!m?.[1]) return ''
  const key = normalizeIntent(String(m[1]))
  const arg = m?.[2] ? String(m[2]).trim() : ''
  return arg ? `${key}:${arg}` : key
}

async function collectToastText(page: Page) {
  const t = await page
    .evaluate(() => {
      const doc: any = (globalThis as any).document
      const win: any = (globalThis as any).window
      const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
      const isVisible = (el: any) => {
        try {
          const st = win?.getComputedStyle?.(el)
          if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false
          const r = el?.getBoundingClientRect?.()
          if (!r) return false
          if (r.width <= 2 || r.height <= 2) return false
          if (r.bottom < 0 || r.right < 0) return false
          return true
        } catch {
          return false
        }
      }
      const nodes = Array.from(
        doc?.querySelectorAll?.(
          '[role="alert"], [aria-live], [class*="toast" i], [class*="snackbar" i], [class*="message" i], [class*="notification" i]'
        ) ?? []
      ) as any[]
      const out: string[] = []
      for (const el of nodes) {
        if (!isVisible(el)) continue
        const txt = toText(el)
        if (!txt) continue
        if (txt.length > 140) out.push(txt.slice(0, 140))
        else out.push(txt)
        if (out.length >= 3) break
      }
      return out.join(' | ')
    })
    .catch(() => '')
  return String(t || '').slice(0, 220)
}

async function detectIntentSatisfied(page: Page, intentRaw: string) {
  const intent = normalizeIntent(intentRaw)
  if (!intent) return false
  const ok = await page
    .evaluate((intentKeyRaw) => {
      const doc: any = (globalThis as any).document
      const win: any = (globalThis as any).window
      const intentKey = String(intentKeyRaw || '')
      const parts = intentKey.split(':').filter(Boolean)
      const base = String(parts[0] || '').trim()
      const arg = String(parts.slice(1).join(':') || '').trim()
      const toText = (el: any) => String(el?.textContent || '').replace(/\s+/g, ' ').trim()
      const isVisible = (el: any) => {
        try {
          const st = win?.getComputedStyle?.(el)
          if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false
          const r = el?.getBoundingClientRect?.()
          if (!r) return false
          if (r.width <= 2 || r.height <= 2) return false
          if (r.bottom < 0 || r.right < 0) return false
          return true
        } catch {
          return false
        }
      }
      const isActive = (el: any) => {
        const ap = String(el?.getAttribute?.('aria-pressed') || '').trim().toLowerCase()
        if (ap === 'true') return true
        const ac = String(el?.getAttribute?.('aria-checked') || '').trim().toLowerCase()
        if (ac === 'true') return true
        const cls = String(el?.className || '').toLowerCase()
        if (/(active|selected|checked|on|liked|following|favorited|is-active)\b/.test(cls)) return true
        return false
      }
      const patterns: Record<string, RegExp> = {
        like: /(点赞|\blike\b|(^|\b)赞(?!助)\b)/i,
        coin: /(投币|\bcoin\b|硬币)/i,
        favorite: /(收藏|\bfavorite\b|\bstar\b)/i,
        follow: /(关注|\bfollow\b|\bsubscribe\b|订阅)/i
      }
      if (base === 'play') {
        const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
        for (const v of vids) {
          if (!v) continue
          if (!isVisible(v)) continue
          const paused = !!(v as any).paused
          const ended = !!(v as any).ended
          const ready = Number((v as any).readyState || 0)
          if (!paused && !ended && ready >= 2) return true
        }
        return false
      }
      if (base === 'fullscreen') {
        return !!doc?.fullscreenElement
      }
      if (base === 'rate') {
        const want = arg ? Number(arg) : NaN
        const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
        for (const v of vids) {
          if (!v) continue
          if (!isVisible(v)) continue
          const r = Number((v as any).playbackRate || 1)
          if (!Number.isFinite(r)) continue
          if (Number.isFinite(want) && want > 0) {
            if (Math.abs(r - want) <= 0.06) return true
          } else {
            if (Math.abs(r - 1) >= 0.06) return true
          }
        }
        return false
      }
      if (base === 'quality') {
        const want = arg ? String(arg).toUpperCase() : ''
        const nodes = Array.from(doc?.querySelectorAll?.('button, [role="button"], [aria-label], [title], span, div') ?? []) as any[]
        let seenWant = false
        for (const el of nodes) {
          if (!isVisible(el)) continue
          const label =
            String(el?.getAttribute?.('aria-label') || '').trim() ||
            String(el?.getAttribute?.('title') || '').trim() ||
            toText(el)
          if (!label) continue
          const s = String(label || '').replace(/\s+/g, '').toUpperCase()
          if (!s) continue
          if (want) {
            if (s.includes(want.replace(/\s+/g, ''))) {
              seenWant = true
              if (isActive(el)) return true
            }
          } else if (/(4K|8K|1080P|720P|480P|360P|原画|蓝光)/i.test(s)) {
            if (isActive(el)) return true
          }
        }
        return want ? seenWant : false
      }
      if (base === 'danmaku') {
        const want = arg ? String(arg).toLowerCase() : ''
        const nodes = Array.from(doc?.querySelectorAll?.('button, [role="button"], [aria-label], [title]') ?? []) as any[]
        for (const el of nodes) {
          if (!isVisible(el)) continue
          const label =
            String(el?.getAttribute?.('aria-label') || '').trim() ||
            String(el?.getAttribute?.('title') || '').trim() ||
            toText(el)
          if (!label) continue
          if (!/弹幕|danmaku/i.test(String(label))) continue
          const on = isActive(el)
          if (want === 'on') return on
          if (want === 'off') return !on
          return true
        }
        return false
      }
      if (base === 'comment') {
        const nodes = Array.from(
          doc?.querySelectorAll?.(
            '[role="alert"], [aria-live], [class*="toast" i], [class*="snackbar" i], [class*="message" i], [class*="notification" i]'
          ) ?? []
        ) as any[]
        for (const el of nodes) {
          if (!isVisible(el)) continue
          const txt = toText(el)
          if (!txt) continue
          if (/成功|已发送|发布|发表|评论成功|发送成功/i.test(txt)) return true
        }
        return false
      }
      const re = patterns[base] || null
      if (!re) return false
      const nodes = Array.from(doc?.querySelectorAll?.('button, [role="button"], a, [aria-label], [title]') ?? []) as any[]
      for (const el of nodes) {
        if (!isVisible(el)) continue
        const label =
          String(el?.getAttribute?.('aria-label') || '').trim() ||
          String(el?.getAttribute?.('title') || '').trim() ||
          toText(el)
        if (!label) continue
        if (!re.test(String(label))) continue
        if (isActive(el)) return true
      }
      return false
    }, intent)
    .catch(() => false)
  return !!ok
}

export async function runLobsterAgent(params: RunParams) {
  const emitLog = (level: 'info' | 'warn' | 'error', message: string) => {
    params.emit({ type: 'log', payload: { level, message: sanitize(message), ts: Date.now() } })
  }

  const emitThinking = (() => {
    let last = ''
    return (stage: string, text: string) => {
      const s = sanitize(String(text || '').trim())
      if (!s) return
      const key = `${stage}:${s}`
      if (key === last) return
      last = key
      params.emit({ type: 'thinking', payload: { stage: String(stage || ''), text: s, ts: Date.now() } })
    }
  })()

  const emitStepBegin = (meta: any) => {
    try {
      params.emit({ type: 'step', payload: { kind: 'begin', meta, ts: Date.now() } })
    } catch {}
  }
  const emitStepEnd = (meta: any) => {
    const safe = sanitizeStepMetaForEmit(meta)
    const level: 'info' | 'error' = safe?.ok === false ? 'error' : 'info'
    emitLog(level, `step_end ${JSON.stringify(safe)}`)
    try {
      params.emit({ type: 'step', payload: { kind: 'end', meta: safe, ts: Date.now() } })
    } catch {}
  }

  const ensureNotAborted = () => {
    if (params.signal.aborted) throw new Error('canceled')
  }

  const waitWhilePaused = async () => {
    if (params.human) await params.human.waitWhilePaused(params.signal)
  }

  const requestConfirm = async (title: string, message: string) => {
    if (!params.human) throw new Error('confirmation unavailable')
    const id = crypto.randomUUID()
    params.emit({ type: 'confirm', payload: { id, title: sanitize(title), message: sanitize(message), ts: Date.now() } })
    const ok = await params.human.waitConfirm(id, params.signal)
    if (!ok) throw new Error('human denied')
    return true
  }

  const riskPolicy = normalizeRiskPolicy(params.config)
  const rankRiskLevel = (level: RiskLevel) => ({ low: 1, medium: 2, high: 3, critical: 4 })[level] || 1
  const assessActionRisk = (input: {
    actionType: string
    intent?: string
    label?: string
    selector?: string
    href?: string
    pageUrl?: string
  }) => {
    const intent = String(input.intent || '').trim().toLowerCase()
    const signalText = [input.label, input.selector, intent, input.href].map((x) => String(x || '').trim()).filter(Boolean).join(' | ')
    const signalLower = signalText.toLowerCase()
    const reasons: string[] = []
    const actions = new Set<RiskActionKind>()
    let level: RiskLevel = 'low'
    const add = (kind: RiskActionKind, nextLevel: RiskLevel, reason: string) => {
      actions.add(kind)
      reasons.push(reason)
      if (rankRiskLevel(nextLevel) > rankRiskLevel(level)) level = nextLevel
    }
    const { base } = splitIntentArg(intent)
    if (['like', 'coin', 'follow', 'favorite'].includes(base) || /(点赞|投币|关注|收藏|订阅)/i.test(signalText)) add('account', 'high', '账号动作')
    if (base === 'comment' || /发送|发布|发表评论|提交|投递|reply|comment|submit/i.test(signalText)) add('submit', 'high', '发送/提交流程')
    if (/登录|log in|sign in|授权|authorize|allow|允许|同意并继续|扫码登录|验证码|otp|verify/i.test(signalText)) add('auth', 'high', '登录/授权流程')
    if (/购买|支付|下单|提交订单|确认支付|buy now|checkout|pay\b|充值/i.test(signalText)) add('payment', 'critical', '支付/下单动作')
    if (/删除|移除|退订|注销|清空|永久删除|remove|delete|unsubscribe/i.test(signalText)) add('destructive', 'critical', '删除/退订动作')
    if (/上传|投稿|发布视频|上传文件|选择文件|choose file|upload/i.test(signalText)) add('upload', 'critical', '上传/投稿动作')
    const href = String(input.href || '').trim()
    const pageUrl = String(input.pageUrl || '').trim()
    const hrefHost = (() => {
      try {
        return new URL(href).hostname.trim().toLowerCase()
      } catch {
        return ''
      }
    })()
    const pageHost = (() => {
      try {
        return new URL(pageUrl).hostname.trim().toLowerCase()
      } catch {
        return ''
      }
    })()
    const toRegDomain = (host: string) => {
      const h = String(host || '').trim().toLowerCase().replace(/\.$/, '')
      const parts = h.split('.').filter(Boolean)
      if (parts.length <= 2) return h
      const second = String(parts[parts.length - 2] || '')
      const ccSecond = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])
      if (ccSecond.has(second) && parts.length >= 3) return parts.slice(-3).join('.')
      return parts.slice(-2).join('.')
    }
    const sameRegDomain = !!hrefHost && !!pageHost && toRegDomain(hrefHost) === toRegDomain(pageHost)
    if (hrefHost && pageHost && !sameRegDomain && hrefHost !== pageHost && !hrefHost.endsWith(`.${pageHost}`) && !pageHost.endsWith(`.${hrefHost}`)) {
      add('external_navigation', 'medium', '跨站跳转')
    }
    return {
      level,
      actions: Array.from(actions),
      reasons: Array.from(new Set(reasons)),
      signalText: signalLower.slice(0, 240)
    }
  }
  const decideRiskAction = (risk: ReturnType<typeof assessActionRisk>, rule: NormalizedRiskPolicyRule, confirmCount: number): RiskDecision => {
    if (!rule.enabled || !risk.actions.length) return 'allow'
    const hitDenyText = rule.denyTextPatterns.some((re) => re.test(risk.signalText))
    if (hitDenyText || risk.actions.some((x) => rule.denyActions.has(x))) return 'deny'
    const hitConfirmText = rule.confirmTextPatterns.some((re) => re.test(risk.signalText))
    const isCriticalRisk = rankRiskLevel(risk.level as RiskLevel) >= rankRiskLevel('critical')
    let decision: RiskDecision =
      hitConfirmText || risk.actions.some((x) => rule.confirmActions.has(x))
        ? 'confirm'
        : isCriticalRisk
          ? rule.criticalDecision
          : rule.defaultDecision
    if (decision === 'confirm' && confirmCount >= rule.maxConfirmationsPerRun) decision = 'deny'
    return decision
  }

  const replay: any[] = []
  const traceId = String(params.runId || crypto.randomUUID())
  const configHeadless = !!params.config?.lobster?.headless
  const headless = resolveEffectiveHeadless(configHeadless)
  if (!configHeadless && headless) {
    emitLog(
      'warn',
      '配置为 headed（LOBSTER_HEADLESS=false），但 DISPLAY 未设置或 Xvfb 未就绪。已自动使用 headless 启动浏览器；Docker 请确认 docker-entrypoint 已启动 Xvfb，或访问 noVNC。'
    )
  }
  const initialStartUrl = normalizeStartUrl(params.task, params.startUrl)
  const storage = await resolveStorageStatePath({
    startUrl: initialStartUrl,
    sessionId: params.sessionId,
    storageProfile: params.storageProfile,
    storageDir: String(params.config?.lobster?.storageDir || '').trim() || undefined
  })
  let session: BrowserSession | null = null
  const enableTrace = params.config?.lobster?.enableTrace !== false
  const traceDirRaw = String(
    params.config?.lobster?.traceDir ||
      params.config?.lobster?.storageDir ||
      path.resolve(process.cwd(), '.data', 'traces')
  ).trim()
  const traceZipPath = enableTrace && traceDirRaw ? path.resolve(traceDirRaw, `${traceId}.zip`) : ''
  const enableVideo = !!params.config?.lobster?.enableVideo
  const videoDirRaw = enableVideo
    ? String(params.config?.lobster?.videoDir || path.resolve(process.cwd(), '.data', 'videos')).trim()
    : ''
  const videoDir = enableVideo && videoDirRaw ? path.resolve(videoDirRaw) : undefined
  let tracingStarted = false
  try {
    if (videoDir) {
      try {
        await fs.mkdir(videoDir, { recursive: true })
      } catch {}
    }
    session = await createSession(headless, storage.savePath, storage.loadPath, videoDir, {
      storageProfile: params.storageProfile,
      browserProfile: params.taskSpec?.browser_profile,
    })
    if (enableTrace && traceZipPath) {
      try {
        await fs.mkdir(path.dirname(traceZipPath), { recursive: true })
        await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
        tracingStarted = true
      } catch {}
    }
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e)
    emitLog('error', `启动浏览器失败：${msg}`)
    params.emit({ type: 'error', payload: { message: sanitize(msg), ts: Date.now() } })
    throw e
  }

  const pushState = (state: any) => {
    const taskSpec = state?.taskSpec && typeof state.taskSpec === 'object' ? state.taskSpec : {}
    const cc =
      state?.completionCriteria && typeof state.completionCriteria === 'object'
        ? state.completionCriteria
        : taskSpec?.completionCriteria && typeof taskSpec.completionCriteria === 'object'
          ? taskSpec.completionCriteria
          : {}
    const gate = state?.gate && typeof state.gate === 'object' ? state.gate : {}
    params.emit({
      type: 'state',
      payload: {
        phase: String(state.phase || ''),
        stepCount: Number(state.stepCount || 0),
        pageUrl: String(state.pageUrl || ''),
        stage: String(state.stage || ''),
        completionCriteria: cc,
        gate
      }
    })
  }

  const nodePlanner: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()
    const start = normalizeStartUrl(state.task, state.startUrl)
    const needsLogin = taskRequiresLogin(state.task, start)
    emitLog('info', `规划任务：startUrl=${start}${needsLogin ? '; needsLogin=true' : ''}`)
    emitThinking('planner', `正在规划任务… startUrl=${start}`)

    const model = createQwenChatModel(params.config, 'planner')
    let plan: any = {
      startUrl: start,
      needsLogin,
      mode: /反爬|验证码|captcha|blocked/i.test(state.task) ? 'lobster_only' : 'hybrid',
      hints: {
        pagination: /分页|下一页|page\s*\d+/i.test(state.task),
        manyDetails: /详情|detail|SKU|商品|帖子|文章/i.test(state.task)
      }
    }

    if (model) {
      const prompt = [
        '你是“龙虾 Agent”的 planner_node（任务规划）。',
        '目标：把用户任务规划为可执行的 GUI 自动化策略，并给出需要使用的模式。',
        '原则（OpenClaw）：少步、可验证；搜索任务优先给出结果页 startUrl（如百度 /s?wd=关键词），避免只给首页。',
        '可选 mode:',
        '- hybrid：龙虾负责登录/导航/拿到列表 URL，爬虫负责批量详情',
        '- lobster_only：全程 GUI 自动化（慢但稳，适合反爬严重）',
        '输出必须为 JSON（不要 Markdown），字段：startUrl, needsLogin, mode, goals, notes, summary。',
        'summary 应包含：objective, targetQuery, targetEntity, constraints, successCriteria。',
        'goals 是数组，元素示例：',
        '- {"type":"enter_detail"}',
        '- {"type":"return_to_list"}',
        '- {"type":"extract_items","limit":5}',
        '- {"type":"done"}',
        '',
        `用户任务：${state.task}`,
        `候选 startUrl：${start}`
      ].join('\n')
      emitThinking('planner', '调用规划模型生成计划…')
      const resp = await model.invoke(prompt)
      const parsed = extractFirstJsonObject(String(resp.content ?? ''))
      if (parsed && typeof parsed === 'object') Object.assign(plan, parsed)
      emitThinking('planner', `计划输出：${JSON.stringify(plan).slice(0, 1200)}`)
    } else {
      emitThinking('planner', '未配置规划模型（检查 OPENAI_API_KEY / LOBSTER_PLANNER_MODEL），使用启发式规划。')
    }

    const maxStepsCfg = Number(params.config?.lobster?.maxSteps ?? 20)
    const baseMaxSteps = Number.isFinite(maxStepsCfg) && maxStepsCfg > 0 ? Math.floor(maxStepsCfg) : 20
    const heuristicTaskSpec = deriveTaskSpecFromPlan(plan, state.task)
    const taskSpec = await inferTaskSpecWithModel(model, state.task, plan, heuristicTaskSpec)
    const ccForPlan = (taskSpec as any)?.completionCriteria && typeof (taskSpec as any).completionCriteria === 'object' ? (taskSpec as any).completionCriteria : {}
    const goalsForPlan = (taskSpec as any)?.goals && typeof (taskSpec as any).goals === 'object' ? (taskSpec as any).goals : {}
    const wantsWait = !!(ccForPlan as any).waitForVideoEnd || Math.max(0, Math.floor(Number((ccForPlan as any).watchSeconds ?? (goalsForPlan as any).watchSeconds ?? 0))) > 0
    const goals = (taskSpec as any).goals
    const mustSearch = !!(goals as any).mustSearch
    const searchQuery = String((goals as any).searchQuery || '').trim() || parseQueryFromTask(state.task) || ''
    const watchSeconds = Math.max(0, Math.floor(Number((goals as any).watchSeconds || 0)))
    const leanKind = classifyLeanBrowseKind({ task: state.task, goals })
    const maxSteps = wantsWait
      ? Math.max(baseMaxSteps, 900)
      : leanClassicMaxSteps(leanKind, baseMaxSteps)
    let plannedStartUrl = String(plan.startUrl || start)
    const leanLanding = resolveLeanSearchLandingUrl({
      startUrl: plannedStartUrl,
      searchQuery,
      kind: leanKind
    })
    if (leanLanding) {
      plannedStartUrl = leanLanding
      plan = { ...plan, startUrl: leanLanding }
      emitLog('info', `OpenClaw 精简：直达搜索结果页 ${leanLanding}`)
    }
    const landedOnResults = isResultListUrl(plannedStartUrl)
    const stage = leanStageAfterLanding({
      kind: leanKind,
      landedOnResults: landedOnResults || (!mustSearch && !!(goals as any).mustExtract),
      mustEnterDetail: !!(goals as any).mustEnterDetail,
      mustExtract: !!(goals as any).mustExtract
    })
    emitLog(
      'info',
      `规划目标：lean=${leanKind} stage=${stage} maxSteps=${maxSteps} enter_detail=${goals.mustEnterDetail ? 1 : 0} extract=${goals.mustExtract ? 1 : 0} return_list=${
        (goals as any).mustReturnToListBeforeExtract ? 1 : 0
      } limit=${Number((goals as any).extractLimit || 0) || 0}`
    )
    const listUrl = String(plan.startUrl || start)
    const completionCriteria =
      (taskSpec as any)?.completionCriteria && typeof (taskSpec as any).completionCriteria === 'object' ? (taskSpec as any).completionCriteria : {}
    return {
      plan,
      startUrl: plannedStartUrl,
      listUrl,
      taskSpec,
      completionCriteria,
      goals,
      stage,
      phase: 'planning',
      maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 20,
      route: (plan.needsLogin ? 'login' : 'perception'),
      waitForVideoEnd: wantsWait,
      watchSeconds,
      watchUntilAt: 0,
      extractedCount: 0,
      extractedCountBefore: 0,
      actionSeq: [],
      gate: {},
      recoverCount: 0,
      forcedInjectCounts: {},
      forcedInjectTotal: 0
    }
  }

  const nodeLogin: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()
    const start = String(state.plan?.startUrl || state.startUrl || normalizeStartUrl(state.task))
    emitLog('info', '登录处理：需要用户完成登录')
    emitThinking('login', `检测到任务需要登录。请在弹出的浏览器窗口中完成登录，然后等待系统自动继续。\nstartUrl=${start}`)

    if (headless) {
      emitLog('warn', '当前为 headless=true，无法进行人工登录，继续执行（可能失败）')
      return { phase: 'login', route: 'perception' }
    }

    try {
      await session!.page.goto(start, { waitUntil: 'domcontentloaded' })
      await session!.page.waitForTimeout(400)
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e)
      emitLog('error', `打开登录页面失败：${msg}`)
      return { phase: 'login', error: msg, route: 'recover' }
    }

    const waitMs = Number(params.config?.lobster?.loginWaitMs ?? 120000)
    const pollMs = Number(params.config?.lobster?.loginPollMs ?? 2000)
    const t0 = Date.now()
    const minWaitMs = session!.storageLoaded ? 0 : 8000
    let lastShotAt = 0

    while (Date.now() - t0 < waitMs) {
      ensureNotAborted()
      const urlNow = String(session!.page.url() ?? '')

      if (Date.now() - lastShotAt > 5000) {
        const snap = await pageSnapshot(session!.page).catch(() => null as any)
        if (snap?.dataUrl) params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        lastShotAt = Date.now()
      }

      const sig = await detectLoginSignals(session!.page)
      const waitedMs = Date.now() - t0
      const likelyDone =
        waitedMs >= minWaitMs && !looksLikeLoginUrl(urlNow) && (sig.hasLogout || sig.hasAvatar)

      emitThinking(
        'login',
        `等待登录完成… url=${urlNow}\nlogout=${sig.hasLogout} loginBtn=${sig.hasLogin} avatar=${sig.hasAvatar}\n已等待：${Math.floor(waitedMs / 1000)}s`
      )

      if (likelyDone) {
        emitLog('info', '登录完成：继续执行任务')
        return { phase: 'login', route: 'perception' }
      }
      await session!.page.waitForTimeout(Math.max(200, pollMs)).catch(() => {})
    }

    emitLog('warn', '登录等待超时：继续执行（可能仍未登录）')
    return { phase: 'login', route: 'perception' }
  }

  const nodeCaptcha: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()
    emitLog('warn', '人机校验处理：需要用户完成验证')
    emitThinking('captcha', '检测到疑似人机校验/反爬页面。请在弹出的浏览器窗口中完成验证（必要时登录/点选/滑块），完成后系统将继续。')

    if (headless) {
      emitLog('warn', '当前为 headless=true，无法进行人工验证，继续执行（可能失败）')
      return { phase: 'captcha', route: 'perception' }
    }

    const waitMs = Number(params.config?.lobster?.loginWaitMs ?? 120000)
    const pollMs = Number(params.config?.lobster?.loginPollMs ?? 2000)
    const t0 = Date.now()
    let lastShotAt = 0

    const isCaptchaLike = (u: string, title: string, text: string) =>
      /captcha|recaptcha|turnstile|cloudflare|人机|验证|安全校验/i.test(`${u}\n${title}\n${text}`.slice(0, 2000))

    while (Date.now() - t0 < waitMs) {
      ensureNotAborted()
      await waitWhilePaused()
      const urlNow = String(session!.page.url() ?? '')
      const titleNow = String((await session!.page.title().catch(() => '')) ?? '')
      const textNow = await session!.page
        .evaluate(() => {
          const doc: any = (globalThis as any).document
          const body = doc?.body
          return String(body?.innerText || '')
        })
        .catch(() => '')

      if (Date.now() - lastShotAt > 5000) {
        const snap = await pageSnapshot(session!.page).catch(() => null as any)
        if (snap?.dataUrl) params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        lastShotAt = Date.now()
      }

      const waitedMs = Date.now() - t0
      emitThinking('captcha', `等待验证完成… url=${urlNow}\n已等待：${Math.floor(waitedMs / 1000)}s`)

      if (!isCaptchaLike(urlNow, titleNow, textNow)) {
        emitLog('info', '人机校验处理：疑似已完成，继续执行任务')
        return { phase: 'captcha', failureType: '', route: 'perception' }
      }
      await session!.page.waitForTimeout(Math.max(250, pollMs)).catch(() => {})
    }

    emitLog('warn', '人机校验等待超时：继续执行（可能仍未完成验证）')
    return { phase: 'captcha', route: 'perception' }
  }

  const nodePerception: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()
    emitLog('info', '视觉感知：获取页面快照与截图')
    const url = state.pageUrl || String(state.plan?.startUrl || state.startUrl || normalizeStartUrl(state.task))
    if (!state.pageUrl) {
      emitLog('info', `打开页面：${url}`)
      emitThinking('perception', `正在打开页面：${url}`)
      try {
        await session!.page.goto(url, { waitUntil: 'domcontentloaded' })
        await session!.page.waitForTimeout(300)
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e)
        emitLog('error', `打开页面失败：${msg}`)
        return { phase: 'perceiving', error: msg, route: 'recover' }
      }
    }

    const snap = await pageSnapshot(session!.page)
    const now = Date.now()
    const urlChanged = normalizeUrlForCompare(snap.url) !== normalizeUrlForCompare(state.pageUrl)
    const lastShotAt = Number(state.lastScreenshotAt || 0)
    if (urlChanged || now - lastShotAt >= 1200) {
      params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: now } })
    }

    let ocrText = String((state as any).ocrText || '')
    let lastOcrAt = Number((state as any).lastOcrAt || 0)
    let visionSummary = String((state as any).visionSummary || '')
    let visionJson: any = (state as any).visionJson && typeof (state as any).visionJson === 'object' ? (state as any).visionJson : {}
    let lastVisionAt = Number((state as any).lastVisionAt || 0)
    let visionCalls = Math.max(0, Math.floor(Number((state as any).visionCalls || 0)))
    let ocrCalls = Math.max(0, Math.floor(Number((state as any).ocrCalls || 0)))
    const useVision = !!params.config?.lobster?.useVision
    const taskSpecNow = normalizeTaskSpec((state as any).taskSpec, String(state.task || ''), (state as any).plan)
    const goalsCfg = (taskSpecNow as any)?.goals && typeof (taskSpecNow as any).goals === 'object' ? (taskSpecNow as any).goals : {}
    const stageNow = String((state as any).stage || '')
    const leanKindNow = classifyLeanBrowseKind({ task: String(state.task || ''), goals: goalsCfg })
    const stall = Math.max(0, Math.floor(Number((state as any).stallCount || 0)))
    const sameUrlPrev = Math.max(0, Math.floor(Number(state.sameUrlCount || 0)))
    const textHint = `${String(snap.title || '')}\n${String(snap.text || '')}`.slice(0, 1200)
    const overlayLikelyByText = /弹窗|对话框|遮罩|蒙层|同意|允许|继续|我知道了|知道了|cookie|隐私|协议|登录|验证|captcha|turnstile|cloudflare/i.test(textHint)
    const captchaLikelyByText = /验证码|captcha|wappass|人机验证|turnstile|cloudflare/i.test(textHint)
    const baseCandidates = await collectCandidatesFromModule(session!.page, 35)
    // OpenClaw：snapshot/DOM 优先；搜索类默认不开 vision（旧逻辑把 mustSearch 当 critical 导致每步烧图）
    const useVisionDynamic = shouldSpendVisionThisTurn({
      kind: leanKindNow,
      useVisionConfig: useVision,
      stallCount: stall,
      overlayLikely: overlayLikelyByText,
      captchaLikely: captchaLikelyByText || stageNow === 'captcha',
      pageUrl: String(snap.url || ''),
      candidateCount: baseCandidates.length,
      pageTextLen: String(snap.text || '').length
    })
    const enableOcr = useVisionDynamic && params.config?.lobster?.enableOcr !== false
    const maxVisionCalls = Math.max(
      0,
      Math.floor(Number(params.config?.lobster?.maxVisionCalls ?? (leanKindNow.startsWith('search') ? 1 : 4)))
    )
    const maxOcrCalls = Math.max(
      0,
      Math.floor(Number(params.config?.lobster?.maxOcrCalls ?? (leanKindNow.startsWith('search') ? 1 : 2)))
    )
    const overlayForVision = useVisionDynamic ? await renderOverlayScreenshotFromModule(session!.page, baseCandidates, 30).catch(() => '') : ''
    const visionImageDataUrl = overlayForVision || snap.dataUrl
    const canOcrByImage = enableOcr && visionImageDataUrl && String(visionImageDataUrl).length < 280_000
    const canSpendOcr = canOcrByImage && (maxOcrCalls === 0 ? false : ocrCalls < maxOcrCalls)
    const shouldOcr = overlayLikelyByText || captchaLikelyByText || stall >= 2 || sameUrlPrev >= 2
    if (canSpendOcr && shouldOcr && (urlChanged || !ocrText || now - lastOcrAt > 60_000)) {
      const modelVision = createQwenChatModel(params.config, 'vision')
      if (modelVision) {
        const maxChars = Number(params.config?.lobster?.ocrMaxChars ?? 900)
        const prompt = [
          '请对图片进行 OCR，只输出识别到的可见文字（纯文本，不要解释，不要 Markdown）。',
          `限制：最多 ${Math.max(200, Math.min(2000, Math.floor(Number.isFinite(maxChars) ? maxChars : 900)))} 字符。`
        ].join('\n')
        emitThinking('ocr', '正在进行 OCR…')
        const resp = await modelVision
          .invoke([
            {
              role: 'user',
              content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: visionImageDataUrl } }] as any
            } as any
          ])
          .catch(() => null as any)
        const raw = resp?.content ? String(resp.content) : ''
        const cleaned = sanitize(raw).replace(/\s+\n/g, '\n').trim()
        if (cleaned) {
          const cap = Math.max(200, Math.min(2000, Math.floor(Number.isFinite(maxChars) ? maxChars : 900)))
          ocrText = cleaned.length > cap ? cleaned.slice(0, cap) : cleaned
          lastOcrAt = now
          ocrCalls += 1
        }
      }
    }

    const canSummarize = useVisionDynamic && visionImageDataUrl && String(visionImageDataUrl).length < 280_000
    const canSpendVision = canSummarize && (maxVisionCalls === 0 ? false : visionCalls < maxVisionCalls)
    const shouldSummarize = urlChanged || !visionSummary || stall >= 1 || sameUrlPrev >= 1 || overlayLikelyByText
    if (canSpendVision && shouldSummarize && (urlChanged || !visionSummary || now - lastVisionAt > 60_000)) {
      const modelVision = createQwenChatModel(params.config, 'vision')
      if (modelVision) {
        const maxChars = Math.max(200, Math.min(2000, Math.floor(Number(params.config?.lobster?.visionSummaryMaxChars ?? 900))))
        const prompt = [
          '请根据截图输出一个 JSON（不要 Markdown、不要解释），用于网页自动化决策。',
          '字段：',
          '- pageType: "home"|"list"|"detail"|"login"|"captcha"|"unknown"',
          '- hasOverlay: boolean（是否有明显弹窗/遮罩）',
          '- hasPlayer: boolean（是否能看到视频播放器/视频区域）',
          '- primaryCtas: string[]（最多 6 个，界面上最关键的可点击入口/按钮文字）',
          '- searchQuery: string（如能识别当前搜索框内容则填写，否则空字符串）',
          '- summary: string（<= 400 字，概括界面）',
          '输出必须是严格 JSON。',
          `summary 限制：最多 ${Math.min(400, Math.floor(maxChars / 2))} 字符。`
        ].join('\n')
        emitThinking('vision', '正在理解界面…')
        const resp = await modelVision
          .invoke([
            {
              role: 'user',
              content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: visionImageDataUrl } }] as any
            } as any
          ])
          .catch(() => null as any)
        const raw = resp?.content ? String(resp.content) : ''
        const parsed = extractFirstJsonObject(raw)
        if (parsed && typeof parsed === 'object') {
          const normalized = normalizeVisionJson(parsed)
          if (normalized) {
            visionJson = normalized as any
            const sum = String((normalized as any).summary || '').replace(/\s+\n/g, '\n').trim()
            if (sum) visionSummary = sum.length > maxChars ? sum.slice(0, maxChars) : sum
            lastVisionAt = now
            visionCalls += 1
          } else {
            const cleaned = sanitize(raw).replace(/\s+\n/g, '\n').trim()
            if (cleaned) {
              visionSummary = cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
              visionJson = {}
              lastVisionAt = now
              visionCalls += 1
            }
          }
        } else {
          const cleaned = sanitize(raw).replace(/\s+\n/g, '\n').trim()
          if (cleaned) {
            visionSummary = cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
            visionJson = {}
            lastVisionAt = now
            visionCalls += 1
          }
        }
      }
    }
    const taskSpec = taskSpecNow
    const forbidden = new Set(
      (Array.isArray((taskSpec as any).forbiddenIntents) ? (taskSpec as any).forbiddenIntents : []).map((x: any) =>
        normalizeIntent(String(x || '').trim())
      ).filter(Boolean)
    )
    const allowed = new Set(
      (Array.isArray((taskSpec as any).allowedIntents) ? (taskSpec as any).allowedIntents : []).map((x: any) =>
        normalizeIntent(String(x || '').trim())
      ).filter(Boolean)
    )
    const goalsNow = (taskSpec as any)?.goals && typeof (taskSpec as any).goals === 'object' ? (taskSpec as any).goals : {}
    const wantsSearch = !!(goalsNow as any).mustSearch && !forbidden.has('search') && (!allowed.size || allowed.has('search'))
    const wantsPlay = ((!allowed.size || allowed.has('play')) && !forbidden.has('play')) || String((state as any).stage || '') === 'play'
    const wantsProcedure = !!(goalsNow as any).mustEnterDetail || !!(goalsNow as any).mustExtract || !!(state as any).waitForVideoEnd || Math.max(0, Math.floor(Number((goalsNow as any).watchSeconds || 0))) > 0
    const overlayLikely = (() => {
      const vj = visionJson && typeof visionJson === 'object' ? visionJson : {}
      if (!!(vj as any).hasOverlay) return true
      const hint = `${String(visionSummary || '')}\n${String(snap.title || '')}\n${String(snap.text || '')}`.slice(0, 1400)
      return /弹窗|对话框|遮罩|蒙层|同意|允许|继续|我知道了|知道了|cookie|隐私|协议|登录|验证|captcha|turnstile|cloudflare/i.test(hint)
    })()
    const candHas = (list: any[], re: RegExp) => {
      const textOf = (c: any) =>
        `${String(c?.label || '')} ${String(c?.ariaLabel || '')} ${String(c?.title || '')} ${String(c?.placeholder || '')}`
          .replace(/\s+/g, ' ')
          .trim()
      return (Array.isArray(list) ? list : []).some((c) => re.test(textOf(c)))
    }
    const candidateQuality = (list: any[]) => {
      const arr = Array.isArray(list) ? list.map((x) => x || {}) : []
      if (!arr.length) return { score: 0, total: 0 }
      let actionable = 0
      let withSelector = 0
      let withBbox = 0
      const labels: string[] = []
      for (const c of arr) {
        const sel = String(c?.selector || '').trim()
        const bbox = c?.bbox && typeof c.bbox === 'object' ? c.bbox : null
        const label = String(c?.label || '').replace(/\s+/g, ' ').trim()
        if (sel) withSelector += 1
        if (bbox && Number.isFinite(Number(bbox.x)) && Number.isFinite(Number(bbox.y))) withBbox += 1
        if (sel || bbox) actionable += 1
        if (label) labels.push(label.toLowerCase())
      }
      const uniq = new Set(labels)
      const uniqRatio = labels.length ? uniq.size / labels.length : 0
      const score =
        Math.min(1, actionable / arr.length) * 0.55 +
        Math.min(1, withSelector / arr.length) * 0.25 +
        Math.min(1, withBbox / arr.length) * 0.1 +
        Math.min(1, uniqRatio) * 0.1
      return { score, total: arr.length }
    }

    const baseQ = candidateQuality(baseCandidates)
    const needExpand =
      Math.max(0, Math.floor(Number((state as any).stallCount || 0))) >= 2 ||
      Math.max(0, Math.floor(Number(state.sameUrlCount || 0))) >= 2 ||
      (wantsSearch && !candHas(baseCandidates, /搜索|search|keyword|query/i)) ||
      (overlayLikely && !candHas(baseCandidates, /关闭|取消|同意|继续|accept|agree|close|dismiss/i)) ||
      (wantsPlay && !candHas(baseCandidates, /播放|play/i)) ||
      (baseQ.total >= 18 && baseQ.score < 0.42)
    const candidates = needExpand ? await collectCandidatesFromModule(session!.page, 80) : baseCandidates
    try {
      params.emit({ type: 'candidates', payload: candidates })
    } catch {}
    const lastUrl = String(state.lastUrl || '')
    const sameUrlCount = normalizeUrlForCompare(snap.url) === normalizeUrlForCompare(lastUrl) ? Number(state.sameUrlCount || 0) + 1 : 0
    const listUrlPrev = String((state as any).listUrl || '')
    const vjNow = visionJson && typeof visionJson === 'object' ? visionJson : {}
    const pageTypeNow = String((vjNow as any).pageType || '').toLowerCase()
    const onGenericList = pageTypeNow === 'list'
    const listUrl = onGenericList ? snap.url : listUrlPrev
    const next = {
      phase: 'perceiving',
      pageUrl: snap.url,
      pageTitle: snap.title,
      pageText: snap.text,
      screenshotDataUrl: snap.dataUrl,
      candidates,
      ocrText,
      lastOcrAt,
      ocrCalls,
      visionSummary,
      visionJson,
      lastVisionAt,
      visionCalls,
      listUrl,
      lastUrl: snap.url,
      sameUrlCount,
      lastScreenshotAt: urlChanged || now - lastShotAt >= 1200 ? now : lastShotAt,
      route: 'decision'
    }
    pushState({ ...state, ...next })
    return next
  }

  let warnedNoDecisionModel = false

  const nodeDecision: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()

    const taskSpec = normalizeTaskSpec((state as any).taskSpec, String(state.task || ''), (state as any).plan)
    const forbidden = new Set(
      (Array.isArray((taskSpec as any).forbiddenIntents) ? (taskSpec as any).forbiddenIntents : []).map((x: any) =>
        normalizeIntent(String(x || '').trim())
      ).filter(Boolean)
    )
    const allowed = new Set(
      (Array.isArray((taskSpec as any).allowedIntents) ? (taskSpec as any).allowedIntents : []).map((x: any) =>
        normalizeIntent(String(x || '').trim())
      ).filter(Boolean)
    )
    const humanAction = params.human?.tryPopAction?.()
    if (humanAction) {
      const ac = actionSchema.safeParse(humanAction)
      if (ac.success) {
        const action = ac.data as any as Action
        emitLog('info', `人工接管：${String((action as any)?.type || 'unknown')}`)
        emitThinking('human', JSON.stringify(action))
        const k = actionKey(action)
        const prev = Array.isArray((state as any).actionSeq) ? ((state as any).actionSeq as any[]).map(String) : []
        const actionSeq = [...prev, k].slice(-8)
        return { phase: 'deciding', action: action as any, route: 'act', lastActionKey: k, sameActionCount: 0, actionSeq }
      }
      emitLog('warn', '人工接管动作无效：schema_mismatch')
    }
    emitLog('info', '智能决策：推理下一步动作')
    emitThinking('decision', '正在分析页面并决定下一步…')
    const decisionCallsLimit = Math.max(1, Math.floor(Number(params.config?.lobster?.maxDecisionCalls ?? 18)))
    let decisionCalls = Math.max(0, Math.floor(Number((state as any).decisionCalls || 0)))
    const modelTextRaw = createQwenChatModel(params.config, 'decision')
    const modelText = modelTextRaw && decisionCalls < decisionCallsLimit ? modelTextRaw : null
    const useVision = !!params.config?.lobster?.useVision
    void useVision

    const adapterKey = pickAdapterKey(String(state.pageUrl || state.plan?.startUrl || state.startUrl || ''))
    const summaryAny = (taskSpec as any)?.summary && typeof (taskSpec as any).summary === 'object' ? (taskSpec as any).summary : {}
    const goalAny = (taskSpec as any)?.goals && typeof (taskSpec as any).goals === 'object' ? (taskSpec as any).goals : {}
    const stageFromState = normalizePageStage(String((state as any).stage || ''))
    const effectivePageStage = 'unknown' as PageStage
    const wantHistory = !!((summaryAny as any).targetEntity && /history|历史/.test(String((summaryAny as any).targetEntity).toLowerCase()))
    const wantSearch = !!(goalAny as any).mustSearch && !forbidden.has('search') && (!allowed.size || allowed.has('search'))
    const wantPlay = (!forbidden.has('play') && (!allowed.size || allowed.has('play'))) || String((state as any).stage || '') === 'play'

    const goalsRawEarly = (state as any).goals
    const goalsEarly = goalsRawEarly && typeof goalsRawEarly === 'object' ? goalsRawEarly : {}
    const mustSearchEarly = !!(goalsEarly as any).mustSearch
    const searchQueryEarly =
      String((goalsEarly as any).searchQuery || '').trim() || parseQueryFromTask(state.task) || ''

    const actionFallback: Action = (() => {
      if (!state.pageUrl) return { type: 'goto', url: String(state.plan?.startUrl || state.startUrl || normalizeStartUrl(state.task)) }
      const url = String(state.pageUrl || '')
      if (mustSearchEarly && isBilibiliGuestTask(state) && bilibiliNeedsDirectSearch(url)) {
        return {
          type: 'goto',
          url: bilibiliSearchUrl(searchQueryEarly || 'test'),
          reason: '无法落地：B站游客改直达搜索页'
        }
      }
      return { type: 'wait', ms: 700, reason: '无模型可用或无法落地，保守等待后重新感知' }
    })()

    const forcedExpireAtRaw = Math.max(0, Math.floor(Number((state as any).forcedIntentsExpireAt || 0)))
    const forcedUsedRaw = Math.max(0, Math.floor(Number((state as any).forcedIntentsUsed || 0)))
    const forcedSourceRaw = String((state as any).forcedIntentsSource || '')
    const clearForcedPatch = { forcedIntents: [], forcedIntentsExpireAt: 0, forcedIntentsUsed: 0, forcedIntentsSource: '' }
    const forcedDefaultExpireAt = Date.now() + 45_000
    const forcedExpireAt = forcedExpireAtRaw > 0 ? forcedExpireAtRaw : 0
    let forcedCarryPatch: Record<string, any> = {}

    const applyDecision = (action: Action, extra: Record<string, any> = {}, resetSameActionCount = false) => {
      const k = actionKey(action)
      const last = String(state.lastActionKey || '')
      const sameActionCount = resetSameActionCount ? 0 : k === last ? Number(state.sameActionCount || 0) + 1 : 0
      const prev = Array.isArray((state as any).actionSeq) ? ((state as any).actionSeq as any[]).map(String) : []
      const actionSeq = [...prev, k].slice(-8)
      return {
        phase: 'deciding',
        action: action as any,
        route: 'act',
        lastActionKey: k,
        sameActionCount,
        actionSeq,
        decisionCalls,
        ...forcedCarryPatch,
        ...extra
      }
    }

    if (forcedExpireAt > 0 && Date.now() > forcedExpireAt) {
      forcedCarryPatch = clearForcedPatch
    } else if (forcedUsedRaw >= 12) {
      forcedCarryPatch = clearForcedPatch
    }

    const goalsRaw = (state as any).goals
    const goals = goalsRaw && typeof goalsRaw === 'object' ? goalsRaw : {}
    const mustEnterDetail = !!(goals as any).mustEnterDetail
    const mustSearch = !!(goals as any).mustSearch
    const searchQuery = String((goals as any).searchQuery || '').trim() || parseQueryFromTask(state.task) || ''
    const mustReturnToListBeforeExtract = !!(goals as any).mustReturnToListBeforeExtract
    const stage = String((state as any).stage || '')
    const vj = (state as any).visionJson
    const visionPageType = vj && typeof vj === 'object' ? String((vj as any).pageType || '').toLowerCase() : ''
    const visionHasPlayer = vj && typeof vj === 'object' ? !!(vj as any).hasPlayer : false
    const urlNow = String(state.pageUrl || '')
    const alreadyDetail =
      visionHasPlayer ||
      visionPageType === 'detail' ||
      /\/video\/(BV[\w]+|av\d+)/i.test(urlNow) ||
      /\/(detail|item|product|post|article|news|read|story)\b/i.test(urlNow)

    if (mustSearch && isBilibiliGuestTask(state) && bilibiliNeedsDirectSearch(urlNow)) {
      emitLog('info', `B站游客搜索：直达 search.bilibili.com（query=${searchQuery || 'test'}）`)
      return applyDecision(
        {
          type: 'goto',
          url: bilibiliSearchUrl(searchQuery || 'test'),
          reason: 'B站游客：直达搜索页（跳过首页弹窗/无效搜索框）'
        },
        {},
        true
      )
    }

    if (mustEnterDetail && stage === 'enter_detail' && !alreadyDetail) {
      const likelyOnResultsForSearch = visionPageType === 'list' || /search|query|keyword=/i.test(urlNow)

      if (mustSearch) {
        if (!likelyOnResultsForSearch) {
          emitLog('info', '目标阶段：检测到需要搜索，跳过启发式直达详情，交给模型先执行搜索')
        }
      }

      const canHeuristicEnterDetail = !mustSearch || likelyOnResultsForSearch
      if (canHeuristicEnterDetail) {
        const baseUrl = String(state.pageUrl || state.plan?.startUrl || state.startUrl || normalizeStartUrl(state.task))
        const cands = inferDetailLinkCandidates(Array.isArray(state.candidates) ? (state.candidates as any[]) : [], baseUrl)
        const tried = Array.isArray((state as any).openTriedUrls) ? ((state as any).openTriedUrls as any[]).map(String).filter(Boolean) : []
        const triedSet = new Set(tried.map((u) => normalizeUrlForCompare(u)))
        const pick = cands.find((c) => !triedSet.has(normalizeUrlForCompare(c.url)))
        if (pick?.url) {
          const nextTried = [...tried, pick.url].slice(-12)
          return applyDecision(
            { type: 'goto', url: pick.url, reason: '目标阶段：进入详情（自动挑选链接）' },
            { openTriedUrls: nextTried },
            true
          )
        }
      }
    }

    if (mustReturnToListBeforeExtract && (stage === 'return_list' || stage === 'extract')) {
      const listUrl = String((state as any).listUrl || state.plan?.startUrl || state.startUrl || '').trim()
      const isListNow =
        visionPageType === 'list'
      const listOk = isListNow || (listUrl && normalizeUrlForCompare(urlNow) === normalizeUrlForCompare(listUrl))
      if (!listOk) {
        if (listUrl && /^https?:\/\//i.test(listUrl)) {
          return applyDecision({ type: 'goto', url: listUrl, reason: '目标阶段：返回列表页后再抽取' }, {}, true)
        }
        return applyDecision({ type: 'back', reason: '目标阶段：返回列表页后再抽取' }, {}, true)
      }
    }

    const runSkill = (skill: Skill): { action: Action; patch: Record<string, any> } => {
      const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
      const patch: Record<string, any> = {}
      if (skill.skill === 'navigate.by_label') {
        const label = String(skill.label || '').trim()
        const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        const idx = cand.findIndex((c) => re.test(String(c?.label || '')))
        if (idx >= 0) return { action: { type: 'click_candidate', index: idx, reason: skill.reason || `导航到「${label}」` }, patch }
        return { action: actionFallback, patch }
      }
      if (skill.skill === 'web.search') {
        const q = String(skill.query || '').trim()
        if (!q) return { action: actionFallback, patch }
        const pageUrl = String(state.pageUrl || '')
        if (/bilibili\.com/i.test(pageUrl) && (isBilibiliGuestTask(state) || bilibiliNeedsDirectSearch(pageUrl))) {
          return {
            action: { type: 'goto', url: bilibiliSearchUrl(q), reason: skill.reason || 'B站直达搜索页（绕过首页登录弹窗）' },
            patch
          }
        }
        // 百度：首页 type+Enter 常未真正进结果页；直达 /s?wd= 是结果态契约的根因修复
        if (baiduNeedsDirectSearch(pageUrl)) {
          return {
            action: { type: 'goto', url: baiduSearchUrl(q), reason: skill.reason || '百度直达搜索结果页' },
            patch
          }
        }
        const idx = cand.findIndex((c) => {
          const kind = String(c?.kind || '').toLowerCase()
          if (kind !== 'input') return false
          const ph = String(c?.placeholder || '')
          const label = String(c?.label || '')
          return /搜索|search|keyword|query/i.test(ph) || /搜索|search/i.test(label)
        })
        if (idx >= 0) return { action: { type: 'type_candidate', index: idx, text: `${q}\n`, reason: skill.reason || '搜索' }, patch }
        if (/bilibili\.com/i.test(pageUrl)) {
          return {
            action: { type: 'goto', url: bilibiliSearchUrl(q), reason: skill.reason || 'B站直达搜索页（绕过首页登录弹窗）' },
            patch
          }
        }
        return { action: { type: 'type', text: `${q}\n`, reason: skill.reason || '搜索（键盘输入）' }, patch }
      }
      if (skill.skill === 'extract.items') {
        const limit = Number(skill.limit || 0)
        return {
          action: {
            type: 'extract',
            fields: ['items'],
            ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(20, Math.floor(limit)) } : {}),
            reason: skill.reason || '抽取列表项'
          },
          patch
        }
      }
      if (skill.skill === 'interact.click_by_intent') {
        const intent = normalizeIntent(String((skill as any).intent || '').trim())
        if (!intent) return { action: actionFallback, patch }
        const idx = pickCandidateIndexByIntent(cand, intent)
        if (idx >= 0) return { action: { type: 'click_candidate', index: idx, reason: skill.reason || `intent:${intent}` }, patch }
        return { action: actionFallback, patch }
      }
      if (skill.skill === 'paginate.next') {
        const idx = cand.findIndex((c) => /下一页|下页|next|more|更多/i.test(String(c?.label || '')))
        if (idx >= 0) return { action: { type: 'click_candidate', index: idx, reason: skill.reason || '下一页' }, patch }
        return { action: { type: 'scroll', dy: 900, reason: skill.reason || '未找到下一页按钮，先下滚' }, patch }
      }
      return { action: actionFallback, patch }
    }

    const runIntent = async (ic: IntentCall): Promise<{ action: Action; patch: Record<string, any> }> => {
      const patch: Record<string, any> = {}
      const intent = normalizeIntent(String((ic as any)?.intent || '').trim())
      if (!intent) return { action: actionFallback, patch }
      const isAllowed = (it: string) => !allowed.size || allowed.has(it)
      const deny = (it: string) => {
        const map: Record<string, string> = {
          play: '播放/观看',
          like: '点赞',
          coin: '投币',
          follow: '关注',
          favorite: '收藏',
          perform: '多步操作',
          click_candidate: '点击候选',
          type_into: '输入/填写',
          extract_items: '抽取/提取',
          search: '搜索',
          paginate_next: '翻页',
          need_crawl: '爬取'
        }
        const label = map[it] || it
        const goals = (taskSpec as any)?.goals && typeof (taskSpec as any).goals === 'object' ? (taskSpec as any).goals : deriveGoalsFromTask(String(state.task || ''))
        const watchSeconds = Math.max(0, Math.floor(Number((goals as any).watchSeconds || 0)))
        const wantsTimedWatch = watchSeconds > 0
        const seq: any[] = []
        if (!!(goals as any).mustSearch && !forbidden.has('search') && isAllowed('search')) {
          const q = String((goals as any).searchQuery || '').trim() || parseQueryFromTask(String(state.task || '')) || '' || 'LangGraph'
          if (q) seq.push({ intent: 'search', args: { query: q }, reason: '用户禁止当前动作：回到任务主线（先搜索）' })
        }
        if (!!(goals as any).mustEnterDetail && isAllowed('open_first_result')) {
          seq.push({ intent: 'open_first_result', reason: '用户禁止当前动作：回到任务主线（进入结果）' })
        }
        if (!forbidden.has('play') && isAllowed('play')) {
          if (/播放|观看|看视频|进入视频|打开视频|视频详情|\bplay\b|\bwatch\b|\bvideo\b/i.test(String(state.task || ''))) {
            seq.push({ intent: 'play', reason: '用户禁止当前动作：回到任务主线（播放）' })
          }
        }
        if (wantsTimedWatch && !forbidden.has('play') && isAllowed('wait')) {
          seq.push({ intent: 'wait', args: { ms: Math.min(120000, Math.max(200, watchSeconds * 1000)) }, reason: `用户禁止当前动作：继续观看${watchSeconds}秒` })
        }
        if (!!(goals as any).mustExtract && !forbidden.has('extract_items') && isAllowed('extract_items')) {
          const limit = Math.max(0, Math.floor(Number((goals as any).extractLimit || 0)))
          seq.push({ intent: 'extract_items', args: limit > 0 ? { limit } : {}, reason: '用户禁止当前动作：回到任务主线（抽取）' })
        }
        patch.forcedIntents = seq.filter(Boolean)
        patch.forcedIntentsExpireAt = patch.forcedIntents.length ? Date.now() + 45_000 : 0
        patch.forcedIntentsUsed = 0
        patch.forcedIntentsSource = 'deny'
        return { action: { type: 'wait', ms: 200, reason: `用户明确要求不执行：${label}，切换策略` } as any, patch }
      }
      if (!isAllowed(intent)) return deny(intent)
      if (intent === 'extract_items' && forbidden.has('extract_items')) return deny('extract_items')
      if (intent === 'paginate_next' && forbidden.has('paginate_next')) return deny('paginate_next')
      if (intent === 'need_crawl' && forbidden.has('need_crawl')) return deny('need_crawl')
      if (['play', 'like', 'coin', 'follow', 'favorite', 'search', 'perform', 'click_candidate', 'type_into'].includes(intent) && forbidden.has(intent))
        return deny(intent)

      const inferOverlayLikely = () => {
        if (isBilibiliGuestTask(state) && intent === 'search') return false
        const vj = (state as any).visionJson
        if (vj && typeof vj === 'object') {
          if (!!(vj as any).hasOverlay) return true
          const pt = String((vj as any).pageType || '').toLowerCase()
          if (pt === 'login' || pt === 'captcha') return false
        }
        const s = `${String((state as any).visionSummary || '')}\n${String(state.pageTitle || '')}\n${String(state.pageText || '')}`.slice(0, 1400)
        if (/弹窗|对话框|遮罩|蒙层|同意|允许|继续|我知道了|知道了|cookie|隐私|协议|青少年模式|未成年人|请登录|登录后|验证|captcha/i.test(s)) return true
        return false
      }
      const hasCloseCandidate = () => {
        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        return pickCandidateIndexByIntent(cand, 'close') >= 0
      }
      const shouldPreDismiss = () => {
        if (isBilibiliGuestTask(state) && intent === 'search') return false
        const forcedLen = Array.isArray((state as any).forcedIntents) ? ((state as any).forcedIntents as any[]).filter(Boolean).length : 0
        if (forcedLen > 0) return false
        const lastKey = String(state.lastActionKey || '')
        const sameAct = Math.max(0, Math.floor(Number(state.sameActionCount || 0)))
        if (lastKey === 'dismiss_overlays' && sameAct >= 1) return false
        const stall = Math.max(0, Math.floor(Number((state as any).stallCount || 0)))
        const sameUrl = Math.max(0, Math.floor(Number(state.sameUrlCount || 0)))
        if (stall >= 1 && hasCloseCandidate()) return true
        if (sameUrl >= 2 && hasCloseCandidate()) return true
        if (inferOverlayLikely() && hasCloseCandidate()) return true
        return false
      }
      if (intent !== 'dismiss_overlays' && shouldPreDismiss()) {
        return { action: { type: 'dismiss_overlays', reason: `intent:dismiss_overlays（预处理：${intent}）` }, patch }
      }

      const lastClickCandidateIndex = (() => {
        const k = String(state.lastActionKey || '')
        const m = k.match(/^click_candidate:(\d+)$/)
        if (!m?.[1]) return null
        const n = Number(m[1])
        if (!Number.isFinite(n) || n < 0) return null
        return Math.floor(n)
      })()
      const pickRankedCandidateIndex = (cand: any[], it: string) => {
        const ranked = rankedCandidateIndexesByIntent(cand, it)
        if (!ranked.length) return -1
        const sameAct = Math.max(0, Math.floor(Number(state.sameActionCount || 0)))
        const sameUrl = Math.max(0, Math.floor(Number(state.sameUrlCount || 0)))
        const avoidLast = (sameAct >= 1 || sameUrl >= 1) && lastClickCandidateIndex !== null
        if (avoidLast) {
          const alt = ranked.find((x) => x !== lastClickCandidateIndex)
          if (typeof alt === 'number') return alt
        }
        return ranked[0] ?? -1
      }
      const pickLooseCandidateIndex = (cand: any[], it: string, minScore: number) => {
        const list = Array.isArray(cand) ? cand.map((x) => x || {}) : []
        let best = { idx: -1, score: -999 }
        for (let i = 0; i < list.length; i++) {
          const sc = scoreCandidateForIntent(list[i], it)
          if (sc > best.score) best = { idx: i, score: sc }
        }
        if (best.idx < 0) return -1
        if (best.score < minScore) return -1
        if (lastClickCandidateIndex !== null && best.idx === lastClickCandidateIndex) {
          const ranked = list
            .map((c, idx) => ({ idx, score: scoreCandidateForIntent(c, it) }))
            .sort((a, b) => b.score - a.score)
            .filter((x) => x.score >= minScore)
            .map((x) => x.idx)
          const alt = ranked.find((x) => x !== lastClickCandidateIndex)
          return typeof alt === 'number' ? alt : best.idx
        }
        return best.idx
      }
      const clickByIntentFallbackText = (it: string) => {
        if (it === 'play') return '播放'
        if (it === 'like') return '点赞'
        if (it === 'coin') return '投币'
        if (it === 'follow') return '关注'
        if (it === 'favorite') return '收藏'
        if (it === 'next') return '下一页'
        if (it === 'close') return '关闭'
        if (it === 'login') return '登录'
        if (it === 'fullscreen') return '全屏'
        return ''
      }
      const groundClickIntent = (it: string, reason: string): { action: Action; patch: Record<string, any> } => {
        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const idx = pickRankedCandidateIndex(cand, it)
        if (idx >= 0) return { action: { type: 'click_candidate', index: idx, reason }, patch }
        const loose = pickLooseCandidateIndex(cand, it, 8)
        if (loose >= 0) return { action: { type: 'click_candidate', index: loose, reason }, patch }
        const t = clickByIntentFallbackText(it)
        if (t) return { action: { type: 'click_by_text', text: t, reason }, patch }
        return { action: actionFallback, patch }
      }

      if (intent === 'goto') {
        const url = String((ic as any)?.args?.url || '').trim()
        if (url) return { action: { type: 'goto', url, reason: ic.reason || 'intent:goto' }, patch }
        return { action: actionFallback, patch }
      }

      if (intent === 'scroll') {
        const dyRaw = Number((ic as any)?.args?.dy ?? 0)
        const dy = Number.isFinite(dyRaw) && dyRaw !== 0 ? Math.max(-1600, Math.min(1600, Math.floor(dyRaw))) : 900
        return { action: { type: 'scroll', dy, reason: ic.reason || 'intent:scroll' }, patch }
      }

      if (intent === 'wait') {
        const msRaw = Number((ic as any)?.args?.ms ?? 0)
        const ms = Number.isFinite(msRaw) && msRaw > 0 ? Math.max(200, Math.min(120000, Math.floor(msRaw))) : 1000
        return { action: { type: 'wait', ms, reason: ic.reason || 'intent:wait' }, patch }
      }

      if (intent === 'search') {
        const q = String((ic as any)?.args?.query || '').trim()
        if (!q) return { action: actionFallback, patch }
        return runSkill({ skill: 'web.search', query: q, reason: ic.reason || 'intent:search' })
      }

      if (intent === 'click_candidate') {
        const cid = String((ic as any)?.args?.cid || '').trim()
        if (!cid) return { action: actionFallback, patch }
        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const idx = cand.findIndex((c) => String((c as any)?.cid || '') === cid)
        if (idx >= 0) return { action: { type: 'click_candidate', index: idx, reason: ic.reason || 'intent:click_candidate' }, patch }
        return { action: actionFallback, patch }
      }

      if (intent === 'type_into') {
        const cid = String((ic as any)?.args?.cid || '').trim()
        const text = String((ic as any)?.args?.text || '')
        if (!cid || !text.trim()) return { action: actionFallback, patch }
        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const idx = cand.findIndex((c) => String((c as any)?.cid || '') === cid)
        if (idx >= 0) return { action: { type: 'type_candidate', index: idx, text, reason: ic.reason || 'intent:type_into' }, patch }
        return { action: actionFallback, patch }
      }

      if (intent === 'click_by_bbox') {
        const idx = Number((ic as any)?.args?.index ?? NaN)
        if (!Number.isFinite(idx) || idx < 0) return { action: actionFallback, patch }
        return { action: { type: 'click_by_bbox', index: Math.floor(idx), reason: ic.reason || 'intent:click_by_bbox' }, patch }
      }
      if (intent === 'click_by_text') {
        const text = String((ic as any)?.args?.text || '').trim()
        if (!text) return { action: actionFallback, patch }
        return { action: { type: 'click_by_text', text, reason: ic.reason || 'intent:click_by_text' }, patch }
      }
      if (intent === 'dismiss_overlays') return { action: { type: 'dismiss_overlays', reason: ic.reason || 'intent:dismiss_overlays' }, patch }
      if (intent === 'reload') return { action: { type: 'reload', reason: ic.reason || 'intent:reload' }, patch }
      if (intent === 'back') return { action: { type: 'back', reason: ic.reason || 'intent:back' }, patch }

      if (intent === 'paginate_next') return runSkill({ skill: 'paginate.next', reason: ic.reason || 'intent:paginate_next' })
      if (intent === 'extract_items') {
        const limit = Number((ic as any)?.args?.limit || 0)
        return runSkill({
          skill: 'extract.items',
          ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(20, Math.floor(limit)) } : {}),
          reason: ic.reason || 'intent:extract_items'
        })
      }

      if (intent === 'need_crawl') return { action: { type: 'need_crawl', reason: ic.reason || 'intent:need_crawl' }, patch }
      if (intent === 'done') return { action: { type: 'done', reason: ic.reason || 'intent:done' }, patch }

      if (intent === 'perform') {
        const goal = String((ic as any)?.args?.goal || '').trim() || String(state.task || '').trim()
        if (!goal) return { action: actionFallback, patch }

        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const qualityWanted = parseMediaQualityWanted(goal)
        const rateWanted = parseMediaRateWanted(goal)
        const commentText =
          (goal.match(/评论\s*[:：]\s*["“]?(.{1,140}?)["”]?(?:$|\s)/)?.[1] || '').trim() ||
          (goal.match(/发送评论\s*[:：]\s*["“]?(.{1,140}?)["”]?(?:$|\s)/)?.[1] || '').trim() ||
          ''
        const wantedPatch: Record<string, any> = {
          ...(commentText ? { lastCommentText: commentText } : {}),
          ...(qualityWanted ? { lastQualityWanted: qualityWanted } : {}),
          ...(rateWanted ? { lastRateWanted: rateWanted } : {})
        }
        const procPlan = planPerformByProcedures(goal, {
          adapterKey,
          pageUrl: String(state.pageUrl || ''),
          pageTitle: String(state.pageTitle || ''),
          pageText: String(state.pageText || ''),
          candidates: cand
        })
        if (procPlan?.intents?.length) {
          const [first, ...rest] = procPlan.intents
          const grounded = await runIntent(first as any)
          const expireAt = Date.now() + 60_000
          return {
            action: grounded.action,
            patch: {
              ...grounded.patch,
              ...wantedPatch,
              forcedIntents: rest,
              forcedIntentsExpireAt: rest.length ? expireAt : 0,
              forcedIntentsUsed: 0,
              forcedIntentsSource: `perform.proc:${procPlan.name}`
            }
          }
        }

        const model = createQwenChatModel(params.config, 'decision')
        if (!model) return { action: actionFallback, patch: { ...wantedPatch } }

        const obsCandLimit = Math.max(12, Math.min(48, Math.floor(Number(params.config?.lobster?.observationCandidateLimit ?? 24))))
        const obsTextChars = Math.max(260, Math.min(2200, Math.floor(Number(params.config?.lobster?.observationTextChars ?? 1200))))
        const observation = {
          goal,
          task: state.task,
          taskSummary: (taskSpec as any)?.summary || {},
          url: state.pageUrl,
          title: state.pageTitle,
          visibleText: clipForPrompt(String(state.pageText || ''), obsTextChars),
          visionSummary: clipForPrompt(String((state as any).visionSummary || ''), 900),
          adapterKey,
          candidates: cand.slice(0, obsCandLimit).map((c, i) => ({
            i,
            cid: String((c as any)?.cid || ''),
            kind: String(c?.kind || ''),
            label: String(c?.label || ''),
            role: String(c?.role || ''),
            placeholder: String(c?.placeholder || ''),
            ariaLabel: String((c as any)?.ariaLabel || ''),
            title: String((c as any)?.title || ''),
            href: String((c as any)?.href || ''),
            score: Number.isFinite(Number(c?.score)) ? Math.floor(Number(c.score)) : 0
          }))
        }

        const prompt = [
          '你是网页自动化“多步执行器”。目标是把 goal 拆成一串稳定的 Intent 步骤。',
          '你必须只输出一个 JSON 数组（不要 Markdown、不要解释）。数组元素必须是 Intent 对象。',
          '禁止输出 perform；每一步必须是可执行的基础 Intent。',
          '优先使用 click_candidate/type_into + candidates[].cid；其次 click_by_text；最后 click_by_bbox。',
          '最多输出 6 步；如果需要输入并提交，可在 text 里包含换行符 \\n 作为提交。',
          '允许的 Intent.intent：goto, search, open_first_result, click_candidate, type_into, scroll, wait, paginate_next, extract_items, play, like, coin, follow, favorite, click_by_bbox, click_by_text, dismiss_overlays, reload, back, need_crawl, done。',
          `Observation JSON：${JSON.stringify(observation)}`
        ].join('\n')

        const resp = await model.invoke(prompt).catch(() => ({ content: '' } as any))
        const parsed = extractFirstJsonValue(String((resp as any)?.content ?? ''))
        const rawArr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
        const seq = rawArr
          .map((x) => (intentSchema.safeParse(x).success ? (intentSchema.safeParse(x).data as any) : null))
          .filter(Boolean)
          .map((x: any) => x as IntentCall)
          .filter((x) => normalizeIntent(String((x as any)?.intent || '')) !== 'perform')
          .filter((x) => {
            const it = normalizeIntent(String((x as any)?.intent || ''))
            if (!it) return false
            if (allowed.size && !allowed.has(it)) return false
            if (forbidden.has(it)) return false
            return true
          })
          .slice(0, 6)

        if (!seq.length) return { action: actionFallback, patch: { ...wantedPatch } }
        const [first, ...rest] = seq
        const grounded = await runIntent(first as any)
        const expireAt = Date.now() + 60_000
        return {
          action: grounded.action,
          patch: {
            ...grounded.patch,
            ...wantedPatch,
            forcedIntents: rest,
            forcedIntentsExpireAt: rest.length ? expireAt : 0,
            forcedIntentsUsed: 0,
            forcedIntentsSource: 'perform'
          }
        }
      }

      if (intent === 'open_first_result') {
        if (alreadyDetail) {
          return { action: { type: 'wait', ms: 300, reason: '已在详情页，跳过重复 open_first_result' }, patch }
        }
        const urlNow = String(state.pageUrl || '')
        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const directUrl = await session!.page
          .evaluate((baseUrl) => {
            const doc: any = (globalThis as any).document
            const win: any = (globalThis as any).window
            const base = String(baseUrl || '')
            const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
            const isVisible = (el: any) => {
              try {
                const st = win?.getComputedStyle?.(el)
                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
                if (String(st.pointerEvents || '').toLowerCase() === 'none') return false
                const r = el?.getBoundingClientRect?.()
                if (!r) return false
                if (r.width <= 2 || r.height <= 2) return false
                const vw = Number(win?.innerWidth || 1280)
                const vh = Number(win?.innerHeight || 720)
                if (r.bottom < 0 || r.right < 0 || r.left > vw || r.top > vh) return false
                return true
              } catch {
                return false
              }
            }
            const isBadLabel = (s: string) => {
              const t = String(s || '').trim()
              if (/(登录|注册|sign in|log in|广告|sponsor|赞助|privacy|cookie|隐私|协议)/i.test(t)) return true
              // 仅过滤顶栏频道短标签，避免误杀标题里含「新闻」的真实结果
              if (/^(新闻|地图|贴吧|知道|图片|视频|网盘|文库|更多|设置)$/i.test(t)) return true
              return false
            }
            const isBadHref = (href: string) => {
              const h = String(href || '').trim()
              if (!h) return true
              if (/^javascript:/i.test(h)) return true
              if (/^#/.test(h)) return true
              if (/^mailto:|^tel:/i.test(h)) return true
              return false
            }
            /** 站内频道首页（非结果项），如 news.baidu.com/ */
            const isChannelHome = (href: string) => {
              try {
                const u = new URL(href)
                const host = String(u.hostname || '').toLowerCase()
                const path = String(u.pathname || '/')
                const shallow = path === '/' || path === ''
                if (/^(news|map|tieba|zhidao|image|v|pan|wenku|baike|hao123)\.baidu\.com$/i.test(host) && shallow) return true
                if (/^(www\.)?baidu\.com$/i.test(host) && shallow && !/[?&]wd=/i.test(href)) return true
              } catch {}
              return false
            }
            const pickRoots = () => {
              const roots: any[] = []
              // 百度等搜索结果容器优先，避免扫到顶栏「新闻」频道
              for (const sel of ['#content_left', '#search', '.result', '[id*="content_left"]', 'main', 'article']) {
                const el = doc?.querySelector?.(sel)
                if (el) roots.push(el)
              }
              const body = doc?.body
              if (body && !roots.length) roots.push(body)
              else if (body && roots.length) roots.push(body)
              return roots
            }
            const roots = pickRoots()
            const seen = new Set<string>()
            const candidates: { href: string; score: number }[] = []
            for (const root of roots) {
              const anchors = Array.from((root?.querySelectorAll?.('a[href]') as any) ?? []) as any[]
              for (const a of anchors) {
                if (!isVisible(a)) continue
                const hrefRaw = String(a?.href || '').trim()
                if (isBadHref(hrefRaw)) continue
                if (isChannelHome(hrefRaw)) continue
                if (base && hrefRaw === base) continue
                if (seen.has(hrefRaw)) continue
                seen.add(hrefRaw)
                const text = String(a?.getAttribute?.('title') || '').trim() || String(a?.getAttribute?.('aria-label') || '').trim() || toText(a)
                if (!text || text.length < 2) continue
                if (isBadLabel(text)) continue
                let score = 0
                try {
                  const r = a.getBoundingClientRect()
                  score += Math.max(0, 800 - Number(r.y || 0)) / 80
                  score += Math.min(10, Math.max(0, Number(r.width || 0) / 120))
                } catch {}
                if (/(详情|detail|read|more|查看)/i.test(text)) score += 4
                if (/\/video\/(BV[\w]+|av\d+)/i.test(hrefRaw)) score += 12
                // 百度跳转链 / 结果 path；不再给裸 /news/ 频道加权
                if (/baidu\.com\/link\?/i.test(hrefRaw)) score += 14
                if (/\/(detail|item|product|post|article|video)\b/i.test(hrefRaw)) score += 6
                if (/\/s\?|[\?&](wd|q|query|keyword)=/i.test(hrefRaw)) score -= 8
                candidates.push({ href: hrefRaw, score })
              }
              if (candidates.length >= 80) break
            }
            candidates.sort((a, b) => b.score - a.score)
            const best = candidates[0]
            return best?.href || ''
          }, urlNow)
          .catch(() => '')
        const direct = String(directUrl || '').trim()
        if (direct) return { action: { type: 'goto', url: direct, reason: ic.reason || 'intent:open_first_result（直达链接）' }, patch }
        const idx = cand.findIndex((c) => String(c?.kind || '').toLowerCase() === 'link')
        if (idx >= 0) return { action: { type: 'click_candidate', index: idx, reason: ic.reason || 'intent:open_first_result' }, patch }
        return { action: actionFallback, patch }
      }

      if (intent === 'play') {
        const urlNow = String(state.pageUrl || '')
        return groundClickIntent('play', ic.reason || 'intent:play')
      }
      if (['like', 'coin', 'follow', 'favorite'].includes(intent)) {
        return groundClickIntent(intent, ic.reason || `intent:${intent}`)
      }

      return { action: actionFallback, patch }
    }

    let forced = Array.isArray((state as any).forcedIntents) ? ((state as any).forcedIntents as any[]).filter(Boolean) : []
    if (Object.keys(forcedCarryPatch).length) forced = []
    if (forced.length) {
      const urlNow = String(state.pageUrl || '')
      const vj = (state as any).visionJson
      const visionHasOverlay = vj && typeof vj === 'object' ? !!(vj as any).hasOverlay : false
      const stageNow = String((state as any).stage || '')
const shouldDropForced = (ic: any) => {
        const it = normalizeIntent(String(ic?.intent || ''))
        if (!it) return true
        if (allowed.size && !allowed.has(it)) return true
        if (forbidden.has(it)) return true
        if ((stageNow === 'play' || stageNow === 'watch') && alreadyDetail) {
          if (it === 'open_first_result' || it === 'search' || it === 'paginate_next') return true
          if (it === 'goto' && !/^https?:\/\//i.test(String((ic as any)?.args?.url || ''))) return true
        }
if (!visionHasOverlay && it === 'dismiss_overlays') return true
        return false
      }
      const filtered: any[] = []
      for (const item of forced) {
        const parsed = intentSchema.safeParse(item)
        if (!parsed.success) continue
        if (shouldDropForced(parsed.data as any)) continue
        filtered.push(parsed.data as any)
      }
      forced = filtered
      if (!forced.length) forcedCarryPatch = clearForcedPatch
    }
    if (forced.length) {
      let picked = forced[0] as any
      const skipForcedArbiter = ['verify', 'recover', 'deny'].includes(forcedSourceRaw)
      if (modelText && !skipForcedArbiter) {
        const forcedCandidates = (Array.isArray(state.candidates) ? (state.candidates as any[]) : [])
          .slice(0, 14)
          .map((c: any, i: number) => ({
            i,
            cid: String(c?.cid || ''),
            kind: String(c?.kind || ''),
            label: String(c?.label || ''),
            role: String(c?.role || '')
          }))
        const forcedPrompt = [
          '你是网页 Agent 的强制步骤仲裁器。',
          '你会拿到 forcedIntents 列表与当前观察，请选择最符合用户目标的一步。',
          '只输出 JSON：{ "pick": number, "reason": string }（不要 Markdown、不要解释）。',
          '若所有 forcedIntents 都不合适，输出 pick=-1。',
          `用户任务：${state.task}`,
          `当前 URL：${state.pageUrl}`,
          `forcedIntents：${JSON.stringify(forced)}`,
          `可交互候选：${JSON.stringify(forcedCandidates)}`
        ].join('\n')
        const forcedResp = await modelText.invoke(forcedPrompt).catch(() => ({ content: '' } as any))
        const forcedPick = extractFirstJsonObject(String((forcedResp as any)?.content ?? ''))
        const pickIdx = Number((forcedPick as any)?.pick)
        if (Number.isFinite(pickIdx) && pickIdx >= 0 && pickIdx < forced.length) {
          picked = forced[Math.floor(pickIdx)] as any
        } else if (Number.isFinite(pickIdx) && pickIdx < 0) {
          picked = forced[0] as any
          emitLog('warn', '强制策略仲裁返回 pick=-1，回退执行 forcedIntents[0]')
        }
      }
      const grounded = await runIntent(picked as any)
      const finalAction = grounded.action
      const nextUsed = forcedUsedRaw + 1
      const nextExpireAt = forcedExpireAt > 0 ? forcedExpireAt : forcedDefaultExpireAt
      const pickedIdx = forced.findIndex((x) => x === picked)
      const rest = forced.filter((_, i) => i !== (pickedIdx >= 0 ? pickedIdx : 0))
      const patch = {
        forcedIntents: rest,
        forcedIntentsExpireAt: rest.length ? nextExpireAt : 0,
        forcedIntentsUsed: rest.length ? nextUsed : 0,
        forcedIntentsSource: forcedSourceRaw || 'forced',
        ...grounded.patch
      }
      emitLog('info', `强制策略（模型仲裁）：intent=${String((picked as any)?.intent || '')}`)
      emitThinking('decision', `强制策略动作输出：${JSON.stringify(finalAction)}`)
      return applyDecision(finalAction, patch, true)
    }

    // P3-L1：StepDecide 主路径（LLM+Zod）；失败/低置信 → recover，禁止静默回落用户原话 regex
    if (isClassicStepDecideEnabled() && modelText) {
      const candTop = (Array.isArray(state.candidates) ? (state.candidates as any[]) : [])
        .slice(0, 18)
        .map((c: any, i: number) => ({
          i,
          cid: String(c?.cid || ''),
          kind: String(c?.kind || ''),
          label: String(c?.label || '').slice(0, 40),
          placeholder: String(c?.placeholder || '').slice(0, 40),
          href: String(c?.href || '').slice(0, 90),
          score: Number.isFinite(Number(c?.score)) ? Math.floor(Number(c.score)) : 0,
        }))
      const recentFailuresSd = Array.isArray((state as any).recentFailures)
        ? ((state as any).recentFailures as any[]).map((x) => String(x || '').trim()).filter(Boolean).slice(-3)
        : []
      decisionCalls += 1
      const step = await classicStepDecide({
        task: String(state.task || ''),
        taskSpec: {
          goals: (taskSpec as any)?.goals || goals,
          allowedIntents: Array.isArray((taskSpec as any)?.allowedIntents) ? (taskSpec as any).allowedIntents : [],
          forbiddenIntents: Array.isArray((taskSpec as any)?.forbiddenIntents) ? (taskSpec as any).forbiddenIntents : [],
          intentsOrder: Array.isArray((taskSpec as any)?.intentsOrder) ? (taskSpec as any).intentsOrder : [],
          summary: (taskSpec as any)?.summary || {},
          successCriteria: (taskSpec as any)?.successCriteria || parseSuccessCriteria((taskSpec as any)?.summary?.successCriteria),
          completionCriteria: (taskSpec as any)?.completionCriteria || {},
          startUrl: String(
            (state as any).startUrl ||
              (state as any).plan?.startUrl ||
              params.startUrl ||
              '',
          ).trim() || undefined,
        },
        observation: {
          url: String(state.pageUrl || ''),
          title: String(state.pageTitle || ''),
          stageHint: String((state as any).stage || stageFromState || 'unknown'),
          candidatesTopK: candTop,
          lastAction: String(state.lastActionKey || ''),
          lastError: String((state as any).error || ''),
          pageTextSnippet: clipForPrompt(String(state.pageText || ''), 700),
          recentFailures: recentFailuresSd,
        },
        config: params.config,
        signal: params.signal,
      })
      if (step && step.confidence >= classicStepDecideMinConfidence()) {
        void appendLobsterNluMetric({
          ts: Date.now(),
          run_id: params.runId,
          source: 'step_decide',
          confidence: step.confidence,
          rationale: String(step.reason || '').slice(0, 200),
          engine_picked: 'classic',
        })
        emitLog('info', `StepDecide：intent=${step.intent} conf=${step.confidence.toFixed(2)}`)
        const ic = toIntentCall(step)
        const grounded = await runIntent(ic)
        emitThinking('decision', `StepDecide 动作：${JSON.stringify(grounded.action)}`)
        return applyDecision(grounded.action, {
          ...grounded.patch,
          // expect 由 task-level successCriteria 消费，不写入未入 schema 的 lastStepExpect
          decisionSource: 'step_decide',
          stepDecideWaitStreak: 0,
        }, true)
      }
      void appendLobsterNluMetric({
        ts: Date.now(),
        run_id: params.runId,
        source: 'step_decide_low_conf',
        confidence: step?.confidence ?? 0,
        rationale: 'step_decide null or low confidence → recover wait',
        engine_picked: 'classic',
      })
      emitLog('warn', 'StepDecide 低置信/失败，等待重感知（不回落 regex suggestedIntents）')
      // OpenClaw：已在详情仍决策失败 → 直接 done，禁止 wait 死循环后再触发 maxSteps / 回退 MCP 搜百度
      // 必须已离开 startUrl，禁止把站点首页当成详情
      const startUrlNow = String(
        (state as any).startUrl || (state as any).plan?.startUrl || params.startUrl || '',
      ).trim()
      if (
        hasLeftStartPage(String(state.pageUrl || ''), startUrlNow) &&
        isSearchOpenDestinationUrl(String(state.pageUrl || '')) &&
        (String(state.pageTitle || '').trim().length >= 2 || String(state.pageText || '').trim().length >= 40)
      ) {
        emitLog('info', `StepDecide 失败但已在详情页，done：${String(state.pageUrl || '').slice(0, 80)}`)
        return applyDecision(
          {
            type: 'done',
            reason: `step_decide_recover:已在详情「${String(state.pageTitle || '').slice(0, 40)}」`,
          },
          { decisionSource: 'step_decide_destination_done' },
          true,
        )
      }
      const waitStreak = Number((state as any).stepDecideWaitStreak || 0) + 1
      const mustEnterNow = !!(goals && (goals as any).mustEnterDetail)
      if (waitStreak >= 2) {
        if (
          mustEnterNow &&
          !hasLeftStartPage(String(state.pageUrl || ''), startUrlNow)
        ) {
          // open_first_result 是 Intent，不是 Action；必须经 runIntent 落地为 goto/click
          emitLog('warn', `StepDecide 连续等待且仍在起始页，强制 open_first_result`)
          const grounded = await runIntent({
            intent: 'open_first_result',
            reason: 'step_decide_wait_streak:force_enter_detail',
          })
          return applyDecision(grounded.action, {
            ...grounded.patch,
            decisionSource: 'step_decide_wait_enter',
            stepDecideWaitStreak: 0,
          }, true)
        }
        emitLog('warn', `StepDecide 连续 wait ${waitStreak} 次，强制 done/recover 跳出`)
        return applyDecision(
          { type: 'done', reason: 'step_decide_wait_streak:break_loop' },
          { decisionSource: 'step_decide_wait_break', stepDecideWaitStreak: 0 },
          true,
        )
      }
      return applyDecision(
        { type: 'wait', ms: 500, reason: 'step_decide:low_confidence，重感知' },
        { decisionSource: 'step_decide_recover', stepDecideWaitStreak: waitStreak },
        true,
      )
    }

    const hasDecisionModel = !!modelText
    if (!modelText) {
      if (!warnedNoDecisionModel) {
        warnedNoDecisionModel = true
        emitLog('warn', '未配置决策模型（检查 OPENAI_API_KEY / LOBSTER_DECISION_MODEL），将使用启发式策略，复杂任务可能无法稳定完成')
      }
      const navLabel = parseNavLabelFromTask(state.task)
      const pageHint = `${state.pageTitle}\n${state.pageText}`
      const alreadyThere = navLabel ? new RegExp(navLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(pageHint) : false
      const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
      const t = String(state.task || '')
      const intentList = [
        /点赞|\blike\b|(^|\b)赞(?!助)\b/i.test(t) ? 'like' : '',
        /投币|\bcoin\b/i.test(t) ? 'coin' : '',
        /关注|\bfollow\b|\bsubscribe\b|订阅/i.test(t) ? 'follow' : '',
        /收藏|\bfavorite\b|\bstar\b/i.test(t) ? 'favorite' : '',
        /播放|观看|看视频|进入视频|打开视频|\bplay\b|\bvideo\b/i.test(t) ? 'play' : '',
        /下一页|下页|next\b|more\b|更多/i.test(t) ? 'next' : ''
      ].filter(Boolean) as string[]
      for (const it of intentList) {
        const idx = pickCandidateIndexByIntent(cand, it)
        if (idx >= 0) {
          const action: Action = { type: 'click_candidate', index: idx, reason: `intent:${normalizeIntent(it)}` }
          return applyDecision(action)
        }
      }
      if (navLabel && !alreadyThere && cand.length) {
        const re = new RegExp(navLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        const idx = cand.findIndex((c) => re.test(String(c?.label || '')))
        if (idx >= 0) {
          const action: Action = { type: 'click_candidate', index: idx, reason: `启发式导航：尝试进入「${navLabel}」` }
          return applyDecision(action)
        }
      }
      return applyDecision(actionFallback)
    }

    const pageStage: PageStage = 'unknown'
    const ctaHints = Array.isArray((state as any)?.visionJson?.primaryCtas) ? ((state as any)?.visionJson?.primaryCtas as any[]).map(String).filter(Boolean).slice(0, 6) : []
    const stagePriority: Record<PageStage, number> = { captcha: 0, login: 1, search: 2, list: 3, detail: 4, play: 5, history: 3, home: 2, unknown: 2 }
    const stageLabel = `${stageFromState || 'unknown'}→${pageStage}`
    const candList = (() => {
      const list = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
      const max = Math.max(8, Math.min(28, Math.floor(Number(params.config?.lobster?.observationCandidateLimit ?? 18))))
      const lines = list.slice(0, max).map((c, i) => {
        const cid = String(c?.cid || '').trim()
        const kind = String(c?.kind || '').trim() || 'item'
        const label = String(c?.label || '').replace(/\s+/g, ' ').trim()
        const ph = String(c?.placeholder || '').replace(/\s+/g, ' ').trim()
        const role = String(c?.role || '').trim()
        const tag = String(c?.tag || '').trim()
        const aux =
          ph
            ? `placeholder="${ph}"`
            : String(c?.ariaLabel || '').trim()
              ? `aria="${String(c?.ariaLabel || '').trim()}"`
              : String(c?.title || '').trim()
                ? `title="${String(c?.title || '').trim()}"`
                : ''
        const head = `[${i}] ${kind}${cid ? ` cid=${cid}` : ''}`
        const name = label ? `"${label}"` : ''
        const meta = [role || '', tag || '', aux || ''].filter(Boolean).join(' ')
        return [head, name, meta].filter(Boolean).join(' ').trim()
      })
      return lines.length ? lines.join('\n') : '(none)'
    })()

    const suggestedSkills = (() => {
      const out: Skill[] = []
      const n = parseTopNFromTask(state.task)
      const nav = parseNavLabelFromTask(state.task)
      const t = String(state.task || '')
      if (nav) out.push({ skill: 'navigate.by_label', label: nav, reason: '任务包含导航意图' })
      if (/下一页|下页|next\b|more\b|更多/i.test(String(state.task || ''))) out.push({ skill: 'paginate.next', reason: '任务包含翻页意图' })
      if (/抽取|提取|获取|列表|结果|items/i.test(String(state.task || ''))) out.push({ skill: 'extract.items', limit: n || undefined, reason: '任务包含抽取意图' })
      if (/播放|观看|看视频|进入视频|打开视频|\bplay\b|\bvideo\b/i.test(t)) out.push({ skill: 'interact.click_by_intent', intent: 'play', reason: '任务包含播放/进入视频意图' })
      if (/点赞|\blike\b|(^|\b)赞(?!助)\b/i.test(t)) out.push({ skill: 'interact.click_by_intent', intent: 'like', reason: '任务包含点赞意图' })
      if (/投币|\bcoin\b/i.test(t)) out.push({ skill: 'interact.click_by_intent', intent: 'coin', reason: '任务包含投币意图' })
      if (/关注|\bfollow\b|\bsubscribe\b|订阅/i.test(t)) out.push({ skill: 'interact.click_by_intent', intent: 'follow', reason: '任务包含关注/订阅意图' })
      if (/收藏|\bfavorite\b|\bstar\b/i.test(t)) out.push({ skill: 'interact.click_by_intent', intent: 'favorite', reason: '任务包含收藏意图' })
      if (wantSearch) {
        const q = parseQueryFromTask(state.task) || ''
        out.push({ skill: 'web.search', query: q || 'LangGraph', reason: '站内搜索' })
      }
      const isAllowed = (it: string) => !allowed.size || allowed.has(it)
      const allow = (s: Skill) => {
        if (s.skill === 'navigate.by_label' && !isAllowed('goto')) return false
        if (s.skill === 'paginate.next' && (!isAllowed('paginate_next') || forbidden.has('paginate_next'))) return false
        if (s.skill === 'extract.items' && (!isAllowed('extract_items') || forbidden.has('extract_items'))) return false
        if (s.skill === 'web.search' && (!isAllowed('search') || forbidden.has('search'))) return false
        if (s.skill === 'interact.click_by_intent') {
          const it = normalizeIntent(String((s as any).intent || ''))
          if (!it) return false
          if (!isAllowed(it)) return false
          if (forbidden.has(it)) return false
        }
        return true
      }
      return out.filter(allow).slice(0, 5)
    })()
    emitThinking('skills', suggestedSkills.length ? JSON.stringify(suggestedSkills) : '(none)')

    const suggestedIntents = (() => {
      const out: IntentCall[] = []
      const n = parseTopNFromTask(state.task)
      const t = String(state.task || '')
      const needPlayControls = /清晰度|音质|无损|画质|分辨率|倍速|评论|发评|发送评论|弹幕|弹\s*幕|全屏/i.test(t)
      const visionPageTypeHint =
        vj && typeof vj === 'object' ? String((vj as any).pageType || '').toLowerCase() : ''
      const needDetail =
        visionPageTypeHint === 'search' ||
        visionPageTypeHint === 'list' ||
        stageFromState === 'search' ||
        stageFromState === 'list' ||
        /视频详情|进入视频|打开视频|第[一1]个|first result/i.test(t)
      const nav = parseNavLabelFromTask(state.task)
      if (nav) out.push({ intent: 'goto', args: { url: state.pageUrl || String(state.plan?.startUrl || state.startUrl || normalizeStartUrl(state.task)) }, reason: '任务包含导航意图（如需先打开页面）' })
      if (/下一页|下页|next\b|more\b|更多/i.test(t)) out.push({ intent: 'paginate_next', reason: '任务包含翻页意图' })
      if (/抽取|提取|获取|列表|结果|items/i.test(t)) out.push({ intent: 'extract_items', args: n ? { limit: n } : {}, reason: '任务包含抽取意图' })
      if (/播放|观看|看视频|进入视频|打开视频|\bplay\b|\bvideo\b/i.test(t)) out.push({ intent: 'play', reason: '任务包含播放/进入视频意图' })
      if (/点赞|\blike\b|(^|\b)赞(?!助)\b/i.test(t)) out.push({ intent: 'like', reason: '任务包含点赞意图' })
      if (/投币|\bcoin\b/i.test(t)) out.push({ intent: 'coin', reason: '任务包含投币意图' })
      if (/关注|\bfollow\b|\bsubscribe\b|订阅/i.test(t)) out.push({ intent: 'follow', reason: '任务包含关注/订阅意图' })
      if (/收藏|\bfavorite\b|\bstar\b/i.test(t)) out.push({ intent: 'favorite', reason: '任务包含收藏意图' })
      if (/清晰度|音质|画质|分辨率|倍速|评论|发评|发送评论|弹幕|弹\s*幕/i.test(t)) {
        out.push({ intent: 'perform', args: { goal: t.slice(0, 200) }, reason: '任务包含复杂界面操作，进入多步执行模式' })
      }
      const stall = Math.max(0, Math.floor(Number((state as any).stallCount || 0)))
      const sameUrl = Math.max(0, Math.floor(Number(state.sameUrlCount || 0)))
      const sameAct = Math.max(0, Math.floor(Number(state.sameActionCount || 0)))
      if (stall >= 2 || sameUrl >= 2 || sameAct >= 2) {
        const cand = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const hint = `${String((state as any).visionSummary || '')}\n${String(state.pageTitle || '')}\n${String(state.pageText || '')}`.slice(0, 1400)
        const overlayLikely = /弹窗|对话框|遮罩|蒙层|同意|允许|继续|我知道了|知道了|cookie|隐私|协议|登录/i.test(hint)
        const closeIdx = pickCandidateIndexByIntent(cand, 'close')
        const playIdx = pickCandidateIndexByIntent(cand, 'play')
        const preferIdx = closeIdx >= 0 ? closeIdx : playIdx >= 0 ? playIdx : 0
        out.unshift({ intent: 'dismiss_overlays', reason: '卡住时优先尝试关闭遮罩/弹窗' })
        if (overlayLikely || closeIdx >= 0) out.push({ intent: 'click_by_text', args: { text: '关闭' }, reason: '卡住时尝试按文字关闭弹窗/遮罩' })
        const ocr = String((state as any).ocrText || '').trim()
        if (ocr) out.push({ intent: 'click_by_text', args: { text: ocr.split(/\s+/).slice(0, 8).join(' ').slice(0, 24) }, reason: '卡住时尝试按 OCR 文本点击' })
        out.push({ intent: 'click_by_bbox', args: { index: preferIdx }, reason: `卡住时尝试使用候选 bbox 坐标点击（index=${preferIdx}）` })
        out.push({ intent: 'reload', reason: '卡住时尝试刷新页面' })
        out.push({ intent: 'back', reason: '卡住时尝试回退到上一步' })
      }
      const allow = (ic: IntentCall) => {
        const it = normalizeIntent(String((ic as any).intent || ''))
        if (!it) return false
        if (allowed.size && !allowed.has(it)) return false
        if (it === 'extract_items' && forbidden.has('extract_items')) return false
        if (it === 'paginate_next' && forbidden.has('paginate_next')) return false
        if (it === 'need_crawl' && forbidden.has('need_crawl')) return false
        if (it === 'search' && forbidden.has('search')) return false
        if (['play', 'like', 'coin', 'follow', 'favorite', 'perform', 'type_into', 'click_candidate'].includes(it) && forbidden.has(it)) return false
        return true
      }
      const ranked = out
        .map((ic) => ({
          ic,
          score:
            (stagePrefersIntent(pageStage, String((ic as any).intent || '')) ? 100 : 0) +
            0
        }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.ic)
      return ranked.filter(allow).slice(0, 6)
    })()

    const candArrForObs = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
    const obsCandLimit = Math.max(8, Math.min(28, Math.floor(Number(params.config?.lobster?.observationCandidateLimit ?? 18))))
    const obsTextChars = Math.max(240, Math.min(2400, Math.floor(Number(params.config?.lobster?.observationTextChars ?? 1200))))
    const stall = Math.max(0, Math.floor(Number((state as any).stallCount || 0)))
    const vjObs = (state as any).visionJson
    const visionHasOverlay = vjObs && typeof vjObs === 'object' ? !!(vjObs as any).hasOverlay : false
    const includeOcr = visionHasOverlay || stall >= 2
    const vt = String((state as any).visionSummary || '')
    const obsTextLimit = vt ? Math.min(obsTextChars, 700) : obsTextChars
    const ocrLimit = includeOcr ? 600 : 0
    const safeStr = (s: any, n: number) => {
      const x = String(s || '').replace(/\s+/g, ' ').trim()
      return x.length > n ? x.slice(0, n) : x
    }
    const recentFailures = Array.isArray((state as any).recentFailures)
      ? ((state as any).recentFailures as any[]).map((x) => String(x || '').trim()).filter(Boolean).slice(-3)
      : []
    const observation = {
      task: state.task,
      taskSpec: {
        goals: (taskSpec as any)?.goals || {},
        allowedIntents: Array.isArray((taskSpec as any)?.allowedIntents) ? (taskSpec as any).allowedIntents : [],
        forbiddenIntents: Array.isArray((taskSpec as any)?.forbiddenIntents) ? (taskSpec as any).forbiddenIntents : [],
        intentsOrder: Array.isArray((taskSpec as any)?.intentsOrder) ? (taskSpec as any).intentsOrder : [],
        priority: (taskSpec as any)?.priority && typeof (taskSpec as any).priority === 'object' ? (taskSpec as any).priority : {}
      },
      url: state.pageUrl,
      title: state.pageTitle,
      visibleText: clipForPrompt(state.pageText, obsTextLimit),
      ocrText: ocrLimit ? clipForPrompt(String((state as any).ocrText || ''), ocrLimit) : '',
      visionSummary: clipForPrompt(String((state as any).visionSummary || ''), Math.min(900, obsTextChars)),
      candidates: candArrForObs.slice(0, obsCandLimit).map((c, i) => ({
        i,
        cid: safeStr((c as any)?.cid, 20),
        kind: safeStr(c?.kind, 12),
        label: safeStr(c?.label, 40),
        placeholder: safeStr(c?.placeholder, 40),
        role: safeStr(c?.role, 16),
        tag: safeStr(c?.tag, 12),
        ariaLabel: safeStr((c as any)?.ariaLabel, 40),
        title: safeStr((c as any)?.title, 40),
        href: safeStr((c as any)?.href, 90),
        score: Number.isFinite(Number(c?.score)) ? Math.floor(Number(c.score)) : 0
      })),
      adapterKey,
      stepCount: Number(state.stepCount || 0),
      maxSteps: Number(state.maxSteps || 0),
      sameUrlCount: Number(state.sameUrlCount || 0),
      sameActionCount: Number(state.sameActionCount || 0),
      stallCount: stall,
      lastActionKey: String(state.lastActionKey || ''),
      suggested_intents: suggestedIntents,
      recentFailures
    }

    const waitEndRule = (() => {
      const waitEnd = !!(state as any).waitForVideoEnd
      const stageHint = ''
      const playRule = waitEnd
        ? '- 如果任务要求“观看/听到结束”，在媒体未结束前不要输出 done，应优先输出 play 或 wait。'
        : ''
      const playerRule = ''
      return [stageHint, playRule, playerRule].filter(Boolean).join('\n')
    })()
    const instruction = [
      '你是“龙虾 Agent”的 decision_node（决策推理）。',
      '你会得到用户任务、当前页面信息（URL/标题/可见文本）以及界面语义摘要（visionSummary）。',
      '你必须只输出一个 JSON 对象（不要 Markdown、不要解释）。',
      '只允许输出 Intent（不允许输出 Action/Skill；也不要输出 selector 或 click_candidate/type_candidate 的 index）。',
      '例外：Intent=click_by_bbox 时允许输出 args.index（用于坐标点击兜底）。Intent=click_candidate/type_into 必须使用 candidates 里的 cid（不允许用数字 index）。',
      'Intent 格式：{ "intent": "...", "args"?: {...}, "reason"?: "..." }。',
      '允许的 Intent.intent：goto, search, open_first_result, click_candidate, type_into, scroll, wait, paginate_next, extract_items, perform, play, like, coin, follow, favorite, click_by_bbox, click_by_text, dismiss_overlays, reload, back, need_crawl, done。',
      '约束：',
      '- 如果 suggested_intents 不为空，把它当作参考而非硬约束；如与用户目标冲突，以用户目标为准。',
      '- recentFailures 是最近失败记忆。优先避开这些失败模式，不要重复相同失败动作。',
      '- candidates[].i 与视觉编号截图上的 #编号 一一对应。',
      '- 如果要点击/输入，优先使用 click_candidate/type_into + cid（更稳定）；其次才用 click_by_text；最后才用 click_by_bbox。',
      '- 如果页面是列表且详情数量大，请输出 need_crawl，并简述原因。',
      '- 如果已经得到用户想要的数据，请输出 done。',
      '- 若用户写明「结束任务/任务完成」或已完成其要求的全部步骤（例如已说明标题或 BV、已按秒数等待），必须输出 intent done；done 会终止运行，不要无意义地继续感知循环。',
      waitEndRule,
      '',
      `Observation JSON：${JSON.stringify(observation)}`
    ].join('\n')
    emitThinking('candidates', candList)

    const invokeDecision = async (prompt: string) => {
      if (!modelText) return { content: '' } as any
      if (decisionCalls >= decisionCallsLimit) {
        return { content: '{"intent":"scroll","args":{"dy":900},"reason":"决策预算已用尽，使用低成本策略"}' } as any
      }
      decisionCalls += 1
      return await modelText.invoke(prompt)
    }

    const resp = await invokeDecision(instruction)

    const parseIntent = (obj: any): IntentCall | null => {
      if (!obj || typeof obj !== 'object') return null
      const it = intentSchema.safeParse(obj)
      if (it.success) return it.data as any
      return null
    }

    let parsed = extractFirstJsonObject(String(resp.content ?? ''))
    let decidedIntent = parseIntent(parsed)
    if (!decidedIntent && modelText && decisionCalls < decisionCallsLimit) {
      const issues = (() => {
        if (!parsed || typeof parsed !== 'object') return 'not_object'
        const it = intentSchema.safeParse(parsed)
        if (it.success) return ''
        const sk = skillSchema.safeParse(parsed)
        if (sk.success) return 'skill_not_allowed'
        const ac = actionSchema.safeParse(parsed)
        if (ac.success) return 'action_not_allowed'
        return 'schema_mismatch'
      })()
      const repair = [
        '请只输出一个 JSON 对象（不要 Markdown、不要解释）。',
        '必须是 Intent：',
        '- { "intent": "goto|search|open_first_result|click_candidate|type_into|scroll|wait|paginate_next|extract_items|perform|play|like|coin|follow|favorite|click_by_bbox|click_by_text|dismiss_overlays|reload|back|need_crawl|done", "args"?: {...}, "reason"?: "..." }',
        '不允许输出 Action/Skill；不允许输出 selector 或 click_candidate/type_candidate 的 index。',
        '例外：Intent=click_by_bbox 时允许输出 args.index（用于坐标点击兜底）。Intent=click_candidate/type_into 必须使用 candidates 里的 cid（不允许用数字 index）。',
        `上次输出问题：${issues || 'invalid'}`,
        `用户任务：${state.task}`,
        `当前 URL：${state.pageUrl}`,
        `suggested_intents：${suggestedIntents.length ? JSON.stringify(suggestedIntents) : '[]'}`,
        `候选可交互元素：\n${candList}`
      ].join('\n')
      const resp2 = await invokeDecision(repair)
      parsed = extractFirstJsonObject(String(resp2.content ?? ''))
      decidedIntent = parseIntent(parsed)
    }

    if (decidedIntent && modelText && decisionCalls < decisionCallsLimit) {
      const criticPrompt = [
        '你是网页自动化动作审查器（critic）。',
        '请判断这个 Intent 在当前页面是否高置信可执行。',
        '只输出 JSON：{"ok":boolean,"score":number,"reason":string}（不要 Markdown、不要解释）。',
        'score 取值 0~1；当 score < 0.45 时视为低置信。',
        `Intent：${JSON.stringify(decidedIntent)}`,
        `recentFailures：${JSON.stringify(recentFailures)}`,
        `Observation：${JSON.stringify(observation)}`
      ].join('\n')
      const cr = await invokeDecision(criticPrompt)
      const crObj = extractFirstJsonObject(String((cr as any)?.content ?? '')) || {}
      const score = Math.max(0, Math.min(1, Number((crObj as any).score ?? (crObj as any).confidence ?? 0)))
      const ok = typeof (crObj as any).ok === 'boolean' ? !!(crObj as any).ok : score >= 0.45
      if (!ok || score < 0.45) {
        const order = Array.isArray((taskSpec as any)?.intentsOrder) ? ((taskSpec as any).intentsOrder as any[]).map(String) : []
        const orderedAlt = suggestedIntents.find((x: any) => order.includes(String((x as any)?.intent || '')))
        const alt = orderedAlt || suggestedIntents[0]
        decidedIntent = alt && parseIntent(alt) ? (alt as any) : ({ intent: 'wait', args: { ms: 500 }, reason: 'critic:low_confidence，等待并重感知' } as any)
      }
    }

    const grounded = decidedIntent ? await runIntent(decidedIntent) : { action: actionFallback, patch: {} as Record<string, any> }
    const action = grounded.action
    const patchFromDecision = grounded.patch

    const currentUrl = normalizeUrlForCompare(String(state.pageUrl || ''))
    const plannedUrl = normalizeUrlForCompare(String(state.plan?.startUrl || state.startUrl || ''))
    let finalAction = action
    let stopAfterExtract = false
    const candArr = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
    if (finalAction.type === 'click_candidate' || finalAction.type === 'type_candidate') {
      const idx = Number((finalAction as any).index)
      const c = Number.isFinite(idx) ? candArr[Math.max(0, Math.floor(idx))] : null
      const ok =
        !!c &&
        (!!String((c as any).selector || '').trim() ||
          !!String((c as any).label || '').trim() ||
          !!String((c as any).placeholder || '').trim() ||
          !!String((c as any).ariaLabel || '').trim() ||
          !!String((c as any).title || '').trim())
      if (!ok) {
        finalAction = actionFallback
      } else if (finalAction.type === 'click_candidate') {
        finalAction = { ...finalAction, index: Math.max(0, Math.floor(idx)) }
      } else {
        finalAction = { ...finalAction, index: Math.max(0, Math.floor(idx)), text: String((finalAction as any).text || '') }
      }
    }
    if (finalAction.type === 'goto') {
      const target = normalizeUrlForCompare(String((finalAction as any).url || ''))
      if (!target || target === currentUrl || (target === plannedUrl && Number(state.sameUrlCount || 0) >= 1)) {
        const replan = async (why: string) => {
          const last = String(state.lastActionKey || '')
          const sameUrlCount = Number(state.sameUrlCount || 0)
          const sameActionCount = Number(state.sameActionCount || 0)
          const prompt = [
            '你是“龙虾 Agent”的决策器。上一次动作没有产生进展，需要换策略。',
            '请只输出一个 JSON 对象（不要 Markdown、不要解释）。',
            '约束：不要重复上一次动作（lastActionKey），需要明显改变策略。',
            '只允许输出 Intent（不允许输出 Action/Skill）。',
            '允许的 Intent.intent：goto, search, open_first_result, scroll, wait, paginate_next, extract_items, play, like, coin, follow, favorite, click_by_bbox, click_by_text, dismiss_overlays, reload, back, need_crawl, done。',
            `原因：${why}`,
            `lastActionKey：${last}`,
            `sameUrlCount：${sameUrlCount}`,
            `sameActionCount：${sameActionCount}`,
            `Observation：${JSON.stringify(observation)}`
          ].join('\n')
          const resp = await invokeDecision(prompt)
          const parsed = extractFirstJsonObject(String(resp.content ?? ''))
          const ic = parseIntent(parsed)
          const grounded = ic
            ? await runIntent(ic)
            : { action: { type: 'scroll', dy: 900, reason: '循环保护：replan 无效，改为滚动换策略' } as Action, patch: {} }
          return grounded.action
        }

        if (modelText && decisionCalls < decisionCallsLimit) {
          const repl = await replan('循环保护：检测到重复 goto')
          const replKey = actionKey(repl)
          const last = String(state.lastActionKey || '')
          finalAction = replKey && replKey !== last ? repl : { type: 'scroll', dy: 900, reason: '循环保护：重复 goto，改为滚动换策略' }
        } else {
          finalAction = { type: 'scroll', dy: 900, reason: '循环保护：重复 goto，改为滚动换策略' }
        }
        stopAfterExtract = false
      }
    }

    const k = actionKey(finalAction)
    const last = String(state.lastActionKey || '')
    const sameActionCount = k === last ? Number(state.sameActionCount || 0) + 1 : 0
    const modelCalls = Number(state.modelCalls || 0) + 1
    const sameUrlCount = Number(state.sameUrlCount || 0)
    if (!stopAfterExtract && sameUrlCount >= 3 && sameActionCount >= 2) {
      const replan = async (why: string) => {
        const last = String(state.lastActionKey || '')
        const prompt = [
          '你是“龙虾 Agent”的决策器。系统检测到页面与动作重复，需要换策略避免卡死。',
          '请只输出一个 JSON 对象（不要 Markdown、不要解释）。',
          '约束：不要重复上一次动作（lastActionKey），不要再做同类动作（比如连续 click_candidate 同一个 index）。',
          '建议：尝试 scroll / 搜索 / 换入口 / 关闭遮罩 / 改用另一个候选。',
          '只允许输出 Intent（不允许输出 Action/Skill）。',
          '允许的 Intent.intent：goto, search, open_first_result, scroll, wait, paginate_next, extract_items, play, like, coin, follow, favorite, click_by_bbox, click_by_text, dismiss_overlays, reload, back, need_crawl, done。',
          `原因：${why}`,
          `lastActionKey：${last}`,
          `sameUrlCount：${sameUrlCount}`,
          `sameActionCount：${sameActionCount}`,
          `Observation：${JSON.stringify(observation)}`
        ].join('\n')
        const resp = await invokeDecision(prompt)
        const parsed = extractFirstJsonObject(String(resp.content ?? ''))
        const ic = parseIntent(parsed)
        const grounded = ic
          ? await runIntent(ic)
          : { action: { type: 'scroll', dy: 900, reason: '循环保护：replan 无效，改为滚动换策略' } as Action, patch: {} }
        return grounded.action
      }

      if (modelText && decisionCalls < decisionCallsLimit) {
        const repl = await replan('循环保护：页面与动作重复')
        const replKey = actionKey(repl)
        finalAction = replKey && replKey !== last ? repl : { type: 'scroll', dy: 900, reason: '循环保护：页面与动作重复，改为滚动换策略' }
      } else {
        finalAction = { type: 'scroll', dy: 900, reason: '循环保护：页面与动作重复，改为滚动换策略' }
      }
      stopAfterExtract = false
    }

    const goalsNow = (state as any).goals && typeof (state as any).goals === 'object' ? (state as any).goals : {}
    const noExtract = forbidden.has('extract_items') || !Boolean((goalsNow as any).mustExtract)
    if (noExtract && finalAction.type === 'extract') {
      const urlNow = String(state.pageUrl || '')
      if (Boolean((state as any).waitForVideoEnd) && visionHasPlayer) {
        finalAction = { type: 'wait', ms: 1200, reason: '用户要求不要提前结束/不要抽取：等待媒体播放结束' }
      } else {
        finalAction = { type: 'scroll', dy: 900, reason: '用户要求不要抽取：继续滚动/寻找可操作入口' }
      }
      stopAfterExtract = false
    }
    const wantsExtract = Boolean((goalsNow as any).mustExtract)
    if (!wantsExtract && finalAction.type === 'extract') {
      finalAction = { type: 'wait', ms: 600, reason: '目标守卫：用户未要求抽取，禁止提前结束，返回重新决策' }
      stopAfterExtract = false
    }

    const stageGuard = (() => {
      const stageNow = String((state as any).stage || '')
      const urlNow = String(state.pageUrl || '')
      const watchUntilAt = Math.max(0, Math.floor(Number((state as any).watchUntilAt || 0)))
      const watchSeconds = Math.max(0, Math.floor(Number((state as any).watchSeconds || 0)))
      const wantsTimedWatch = watchSeconds > 0
      const waitEnd = !!(state as any).waitForVideoEnd
const isNav =
        finalAction.type === 'goto' ||
        finalAction.type === 'back' ||
        finalAction.type === 'reload' ||
        finalAction.type === 'need_crawl' ||
        finalAction.type === 'extract'
      const isAllowedDuringPlayWatch =
        finalAction.type === 'ensure_play' || finalAction.type === 'wait' || finalAction.type === 'dismiss_overlays' || finalAction.type === 'click_by_text'
      if ((stageNow === 'play' || stageNow === 'watch') && finalAction.type === 'done') {
        if (stageNow === 'watch' && wantsTimedWatch && watchUntilAt > 0) {
          const remaining = Math.max(200, Math.min(120000, watchUntilAt - Date.now()))
          return { type: 'wait', ms: remaining, reason: '目标守卫：观看计时中，禁止提前结束，等待到点' } as Action
        }
        if (waitEnd) {
          return { type: 'wait', ms: 1000, reason: '目标守卫：任务要求看完再关，禁止提前结束，等待播放结束' } as Action
        }
      }
      if ((stageNow === 'play' || stageNow === 'watch') && !isAllowedDuringPlayWatch && isNav) {
        if (stageNow === 'watch' && wantsTimedWatch && watchUntilAt > 0) {
          const remaining = Math.max(200, Math.min(120000, watchUntilAt - Date.now()))
          return { type: 'wait', ms: remaining, reason: '目标守卫：观看计时中，禁止跳转/抽取，等待到点' } as Action
        }
return { type: 'wait', ms: 900, reason: '目标守卫：播放/观看阶段，禁止跳转/抽取，先等待稳定' } as Action
      }
      return null
    })()
    if (stageGuard) {
      finalAction = stageGuard
      stopAfterExtract = false
    }

    emitThinking('decision', `动作输出：${JSON.stringify(finalAction)}`)
    return {
      phase: 'deciding',
      action: finalAction as any,
      route: 'act',
      lastActionKey: actionKey(finalAction),
      sameActionCount: stopAfterExtract ? 0 : sameActionCount,
      modelCalls,
      ...patchFromDecision,
      ...(stopAfterExtract ? { stopAfterExtract: true } : {})
    }
  }

  async function extractStructured(fields: string[] | undefined, pageText: string) {
    const model = createQwenChatModel(params.config, 'decision')
    const wanted = Array.isArray(fields) && fields.length ? fields : []
    if (!model) {
      return {
        url: String(session!.page.url() ?? ''),
        title: String((await session!.page.title().catch(() => '')) ?? ''),
        text: String(pageText || '').slice(0, 1200)
      }
    }
    const maxChars = Number(params.config?.lobster?.promptChars ?? 1800)
    const prompt = [
      '你是“龙虾 Agent”的数据抽取器。',
      '根据用户任务与页面可见文本，提取结构化 JSON（不要 Markdown）。',
      wanted.length ? `需要字段：${wanted.join(', ')}` : '如果用户未指定字段，请尽量抽取：title, url, summary, items(如有列表)。',
      '',
      `用户任务：${params.task}`,
      `页面 URL：${String(session!.page.url() ?? '')}`,
      `可见文本：${clipForPrompt(String(pageText || ''), maxChars)}`
    ].join('\n')
    const resp = await model.invoke(prompt)
    const parsed = extractFirstJsonObject(String(resp.content ?? ''))
    if (parsed && typeof parsed === 'object') return parsed
    return { text: String(resp.content ?? '') }
  }

  const nodeAction: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()
    const originalAction = state.action as any as Action
    const compliance = await applyCompliance({
      state: state as any,
      action: originalAction as any,
      page: session!.page,
      detectVideoPlaybackStateDeep
    })
    const action = compliance.action as any as Action
    const gate = compliance.gate ? (compliance.gate as any) : null
    const stepCount = Number(state.stepCount || 0) + 1
    emitLog('info', `动作执行：${action?.type || 'unknown'}`)
    emitThinking('action', `${action?.type || 'unknown'} ${action?.reason ? `- ${String(action.reason).slice(0, 160)}` : ''}`.trim())
    if (gate && gate.ok === false) {
      emitLog('warn', `Gate 拦截：reason=${String(gate.reason || '')} rewrite=${String(gate.rewrittenAction?.type || action?.type || '')}`)
      emitThinking('gate', JSON.stringify(gate).slice(0, 1200))
    }
    pushState({ ...state, stepCount, phase: 'acting', gate: gate || {} })
    const extractedCountBefore = Math.max(0, Math.floor(Number((state as any).extractedCount || 0)))

    const pageUrlBefore = String(state.pageUrl || '')
    const pageTitleBefore = String(state.pageTitle || '')
    const pageTextBefore = String(state.pageText || '')
    const pageTextHashBefore = textDigest(pageTextBefore)
    const stepT0 = Date.now()
    const decorateEndMeta = (meta: any) => ({
      ...meta,
      traceId,
      step: stepCount,
      durationMs: Date.now() - stepT0,
      pageUrlBefore,
      pageTitleBefore,
      pageTextHashBefore,
      pageTextLenBefore: pageTextBefore.length
    })

    try {
      const beforeSig = await collectPageSignals(session!.page)
      let confirmCountNext = Math.max(0, Math.floor(Number((state as any).confirmCount || 0)))
      let lastConfirmedActionKey = String((state as any).lastConfirmedActionKey || '')
      let lastConfirmAt = Math.max(0, Math.floor(Number((state as any).lastConfirmAt || 0)))
      const adapterKeyNow = pickAdapterKey(String(pageUrlBefore || state.plan?.startUrl || state.startUrl || ''))
      const policyRule = resolveRiskPolicyRule(riskPolicy, adapterKeyNow, pageUrlBefore || String(state.plan?.startUrl || state.startUrl || ''))
      const verifyOpts = () => ({
        pageUrl: pageUrlBefore,
        lastCommentText: String((state as any).lastCommentText || ''),
        lastQualityWanted: String((state as any).lastQualityWanted || ''),
        lastRateWanted: String((state as any).lastRateWanted || ''),
        lastDanmakuWanted: String((state as any).lastDanmakuWanted || '')
      })
      const applyActionPolicy = async (input: { actionType: string; intent?: string; label?: string; selector?: string; href?: string }) => {
        const risk = assessActionRisk({ ...input, pageUrl: pageUrlBefore })
        const decision = decideRiskAction(risk, policyRule, confirmCountNext)
        const target = String(input.label || input.selector || input.intent || input.actionType || '').trim().slice(0, 160)
        const confirmKey = `${String(input.actionType || '')}:${String(input.intent || '')}:${target}`.slice(0, 220)
        const meta = {
          decision,
          level: risk.level,
          actions: risk.actions,
          reasons: risk.reasons,
          target
        }
        if (decision === 'deny') {
          throw new Error(`policy denied: ${risk.reasons.join('、') || '高风险动作'} -> ${target || input.actionType}`)
        }
        if (decision === 'confirm') {
          const confirmTtlMs = 45_000
          const recentlyConfirmed = confirmKey && confirmKey === lastConfirmedActionKey && Date.now() - lastConfirmAt <= confirmTtlMs
          if (!recentlyConfirmed) {
            await requestConfirm(
              '确认高风险操作',
              [`动作：${input.actionType}`, target ? `目标：${target}` : '', `风险：${risk.reasons.join('、') || risk.actions.join('、')}`, `URL=${pageUrlBefore}`]
                .filter(Boolean)
                .join('\n')
            )
            confirmCountNext += 1
            lastConfirmedActionKey = confirmKey
            lastConfirmAt = Date.now()
          }
        }
        return meta
      }
      const getConfirmState = () => ({
        confirmCountNext,
        lastConfirmedActionKey,
        lastConfirmAt
      })
      const uniqueLocator = async (loc: any) => {
        if (!loc) return null
        const count = await loc.count().catch(() => 0)
        if (count !== 1) return null
        return loc
      }
      const elementAtCandidatePointLooksRight = async (candidate: any) => {
        const b = candidate?.bbox && typeof candidate.bbox === 'object' ? candidate.bbox : null
        if (!b) return false
        const x = Number(b.x)
        const y = Number(b.y)
        const w = Number(b.width)
        const h = Number(b.height)
        if (![x, y, w, h].every((n) => Number.isFinite(n))) return false
        const vp = session!.page.viewportSize?.() as any
        const maxX = Number(vp?.width || 1280) - 2
        const maxY = Number(vp?.height || 720) - 2
        const cx = Math.max(2, Math.min(maxX, Math.floor(x + Math.max(0, w) / 2)))
        const cy = Math.max(2, Math.min(maxY, Math.floor(y + Math.max(0, h) / 2)))
        const expected = `${String(candidate?.label || '')} ${String(candidate?.ariaLabel || '')} ${String(candidate?.title || '')} ${String(candidate?.contextText || '')}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        const hit = await session!.page
          .evaluate(
            ({ px, py, expectedText, expectedHref }: any) => {
              const doc: any = (globalThis as any).document
              const el = doc?.elementFromPoint?.(px, py)
              if (!el) return false
              const toText = (n: any) => String(n?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
              const txt = `${String(el?.getAttribute?.('aria-label') || '')} ${String(el?.getAttribute?.('title') || '')} ${toText(el)} ${toText(el?.closest?.('a,button,[role="button"],[role="link"]'))}`.trim()
              const href = String(el?.closest?.('a')?.href || el?.getAttribute?.('href') || '').trim()
              if (expectedHref && href && href === expectedHref) return true
              if (expectedText && txt && (txt.includes(expectedText.slice(0, 40)) || expectedText.includes(txt.slice(0, 40)))) return true
              return false
            },
            { px: cx, py: cy, expectedText: expected.slice(0, 80), expectedHref: String(candidate?.href || '').trim() }
          )
          .catch(() => false)
        return !!hit
      }
      const beginMeta = {
        traceId,
        step: stepCount,
        type: action?.type || 'unknown',
        ...(gate ? { gate } : {}),
        selector: (action as any)?.selector,
        index: (action as any)?.index,
        textLen: (action as any)?.text ? String((action as any).text).length : 0,
        pageUrl: pageUrlBefore,
        pageTitle: pageTitleBefore,
        pageTextHash: pageTextHashBefore,
        scrollYBefore: beforeSig.scrollY,
        firstLinkHrefBefore: beforeSig.firstLinkHref,
        h1TextBefore: beforeSig.h1Text,
        hasVideoBefore: beforeSig.hasVideo,
        searchValueBefore: beforeSig.searchValue,
        linkCountBefore: beforeSig.linkCount
      }
      emitLog('info', `step_begin ${JSON.stringify(beginMeta)}`)
      emitStepBegin(beginMeta)
      const buildEndMeta = async (meta: any) => {
        const afterSig = await collectPageSignals(session!.page)
        const decorated = decorateEndMeta({
          ...meta,
          pageTextAfter: typeof meta?.pageTextAfter === 'string' ? String(meta.pageTextAfter).slice(0, 1200) : undefined,
          scrollYBefore: beforeSig.scrollY,
          firstLinkHrefBefore: beforeSig.firstLinkHref,
          h1TextBefore: beforeSig.h1Text,
          hasVideoBefore: beforeSig.hasVideo,
          searchValueBefore: beforeSig.searchValue,
          linkCountBefore: beforeSig.linkCount,
          scrollYAfter: afterSig.scrollY,
          firstLinkHrefAfter: afterSig.firstLinkHref,
          h1TextAfter: afterSig.h1Text,
          hasVideoAfter: afterSig.hasVideo,
          searchValueAfter: afterSig.searchValue,
          linkCountAfter: afterSig.linkCount
        })
        const extractedDelta = Math.max(0, Math.floor(Number((decorated as any).extractedDelta ?? 0)))
        const progress = computeProgress({ meta: decorated as any, normalizeUrlForCompare, extractedDelta })
        return { ...decorated, progress }
      }
      const escapeRegExp = (s: string) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      let runtimeCandidates = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
      const setRuntimeCandidates = (arr: any[]) => {
        runtimeCandidates = Array.isArray(arr) ? arr.map((x) => x || {}) : []
      }
      const resolveCandidate = (index: number) => {
        const arr = runtimeCandidates
        const idx = Number(index)
        if (!Number.isFinite(idx)) return null
        const c = arr[Math.max(0, Math.floor(idx))]
        return c || null
      }
      const replayEntry: any = { ts: Date.now(), step: stepCount, pageUrlBefore, action }
      if (action?.type === 'click_candidate' || action?.type === 'type_candidate') {
        const idx = Number((action as any).index)
        const c: any = resolveCandidate(idx)
        if (c) {
          replayEntry.candidate = {
            source: c.source,
            kind: c.kind,
            label: c.label,
            selector: c.selector,
            role: c.role,
            tag: c.tag,
            placeholder: c.placeholder,
            ariaLabel: c.ariaLabel,
            title: c.title,
            bbox: c.bbox,
            frameIndex: c.frameIndex,
            frameUrl: c.frameUrl,
            frameName: c.frameName
          }
        }
      }
      replay.push(replayEntry)
      const candidateLocator = (index: number, kind: 'click' | 'type') => {
        const c: any = resolveCandidate(index)
        if (!c) return null
        const pickScope = () => {
          const frames = session!.page.frames()
          const frameIndex = Number(c.frameIndex)
          if (Number.isFinite(frameIndex) && frameIndex >= 0 && frameIndex < frames.length) return frames[Math.floor(frameIndex)] as any
          const frameName = String(c.frameName || '').trim()
          if (frameName) {
            const hit = frames.find((f) => String(f.name() || '') === frameName)
            if (hit) return hit as any
          }
          const frameUrl = String(c.frameUrl || '').trim()
          if (frameUrl) {
            const hit = frames.find((f) => String(f.url() || '') === frameUrl)
            if (hit) return hit as any
          }
          return session!.page as any
        }
        const scope: any = pickScope()
        const label = String(c.label || '').trim()
        const exactText = String(c.exactText || label).trim()
        const contextText = String(c.contextText || '').trim()
        const placeholder = String(c.placeholder || '').trim()
        const selector = String(c.selector || '').trim()
        const role = String(c.role || '').trim().toLowerCase()
        const candKind = String(c.kind || '').trim().toLowerCase()
        const tag = String(c.tag || '').trim().toUpperCase()
        const exactRe = exactText ? buildStableTextRegex(exactText) : null
        const looseRe = label ? buildLooseTextRegex(label) : null
        if (kind === 'click') {
          if (exactRe && (candKind === 'button' || role === 'button' || tag === 'BUTTON')) return scope.getByRole('button', { name: exactRe })
          if (exactRe && (candKind === 'link' || role === 'link' || tag === 'A')) return scope.getByRole('link', { name: exactRe })
          if (selector) return scope.locator(selector)
          if (exactRe) return scope.getByText(exactRe)
          if (looseRe && contextText) return scope.getByText(looseRe)
          return null
        }
        if (placeholder) return scope.getByPlaceholder(buildStableTextRegex(placeholder) || new RegExp(escapeRegExp(placeholder), 'i'))
        if (exactRe && (candKind === 'input' || tag === 'INPUT' || tag === 'TEXTAREA')) return scope.getByLabel(exactRe)
        if (selector) return scope.locator(selector)
        if (exactRe) return scope.getByText(exactRe)
        return null
      }
      if (action?.type === 'goto') {
        const url = String(action.url || '').trim() || String(state.plan?.startUrl || state.startUrl || normalizeStartUrl(state.task))
        const current = normalizeUrlForCompare(String(state.pageUrl || ''))
        const target = normalizeUrlForCompare(url)
        if (target && current && target === current) {
          emitLog('warn', `动作跳过：goto 目标与当前 URL 相同 (${url})`)
        } else {
        await session!.page.goto(url, { waitUntil: 'domcontentloaded' })
        await session!.page.waitForTimeout(300)
        }
        const snap = await pageSnapshot(session!.page)
        const now = Date.now()
        const lastShotAt = Number(state.lastScreenshotAt || 0)
        if (now - lastShotAt >= 1200) {
          params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: now } })
        }
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'goto',
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextAfter: snap.text,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length
        })
        emitStepEnd(endMeta)
        return {
          stepCount,
          phase: 'acting',
          pageUrl: snap.url,
          pageTitle: snap.title,
          pageText: snap.text,
          screenshotDataUrl: snap.dataUrl,
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: '',
          extractedCountBefore
        }
      }
      if (action?.type === 'click_candidate') {
        return await executeClickCandidate({
          action,
          state,
          session,
          params,
          stepCount,
          pageUrlBefore,
          extractedCountBefore,
          confirmCountNext,
          resolveCandidate,
          setRuntimeCandidates,
          getRuntimeCandidates: () => runtimeCandidates,
          candidateLocator,
          uniqueLocator,
          elementAtCandidatePointLooksRight,
          intentFromReason,
          verifyIntentSatisfied,
          verifyOpts,
          tryDismissOverlays,
          applyActionPolicy,
          buildStableTextRegex,
          escapeRegExp,
          adoptPopup,
          normalizeUrlForCompare,
          collectToastText,
          pageSnapshot,
          pushState,
          buildEndMeta,
          textDigest,
          emitStepEnd,
          getConfirmState
        })
      }
      if (action?.type === 'ensure_play') {
        const intent = intentFromReason((action as any).reason) || 'play'
        const intentSatisfiedBefore = intent ? await detectIntentSatisfied(session!.page, intent).catch(() => false) : false
        const videoStateBefore = await session!.page
          .evaluate(() => {
            const doc: any = (globalThis as any).document
            const win: any = (globalThis as any).window
            const isVisible = (el: any) => {
              try {
                const st = win?.getComputedStyle?.(el)
                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
                const r = el?.getBoundingClientRect?.()
                if (!r) return false
                if (r.width <= 2 || r.height <= 2) return false
                if (r.bottom < 0 || r.right < 0) return false
                return true
              } catch {
                return false
              }
            }
            const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
            let best: any = null
            for (const v of vids) {
              if (!v || !isVisible(v)) continue
              const w = Number(v?.videoWidth || 0)
              const h = Number(v?.videoHeight || 0)
              if (!best) best = v
              if (w >= 240 && h >= 140) {
                best = v
                break
              }
            }
            const v: any = best || vids[0] || null
            if (!v) return { hasVideo: false, paused: true, ended: false, readyState: 0, currentTime: 0 }
            return {
              hasVideo: true,
              paused: !!v.paused,
              ended: !!v.ended,
              readyState: Number(v.readyState || 0),
              currentTime: Number(v.currentTime || 0)
            }
          })
          .catch(() => ({ hasVideo: false, paused: true, ended: false, readyState: 0, currentTime: 0 }))
const playAttemptCountBefore = Math.max(0, Math.floor(Number((state as any).playAttemptCount || 0)))
        let playError = ''
        if (!intentSatisfiedBefore) {
          const playRes = await session!.page
            .evaluate(async () => {
              const doc: any = (globalThis as any).document
              const win: any = (globalThis as any).window
              const isVisible = (el: any) => {
                try {
                  const st = win?.getComputedStyle?.(el)
                  if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
                  const r = el?.getBoundingClientRect?.()
                  if (!r) return false
                  if (r.width <= 2 || r.height <= 2) return false
                  if (r.bottom < 0 || r.right < 0) return false
                  return true
                } catch {
                  return false
                }
              }
              const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
              for (const v of vids) {
                if (!v || !isVisible(v)) continue
                try {
                  if (v.paused) {
                    const p = v.play?.()
                    if (p && typeof p.then === 'function') await p
                  }
                  return { ok: true, error: '' }
                } catch (e: any) {
                  const msg = e?.message ? String(e.message) : String(e)
                  return { ok: false, error: msg }
                }
              }
              return { ok: false, error: 'no visible video element' }
            })
            .catch((e: any) => ({ ok: false, error: e?.message ? String(e.message) : String(e) }))
          if (playRes && typeof playRes === 'object') playError = String((playRes as any).error || '').slice(0, 220)
          await session!.page.waitForTimeout(350).catch(() => {})
        }
        let intentSatisfiedAfter = intent ? await detectIntentSatisfied(session!.page, intent).catch(() => false) : false
        if (!intentSatisfiedAfter) {
          const clicked = await tryClick(session!.page, [
            '.m-playbar .ply',
            '.playbar .ply',
            'button:has-text("播放")',
            '[role="button"]:has-text("播放")',
            'video'
          ])
          if (clicked.ok) await session!.page.waitForTimeout(350).catch(() => {})
          intentSatisfiedAfter = intent ? await detectIntentSatisfied(session!.page, intent).catch(() => false) : false
        }
        if (!intentSatisfiedAfter && videoStateBefore?.hasVideo) {
          await session!.page.waitForTimeout(850).catch(() => {})
          const videoStateAfter = await session!.page
            .evaluate(() => {
              const doc: any = (globalThis as any).document
              const win: any = (globalThis as any).window
              const isVisible = (el: any) => {
                try {
                  const st = win?.getComputedStyle?.(el)
                  if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
                  const r = el?.getBoundingClientRect?.()
                  if (!r) return false
                  if (r.width <= 2 || r.height <= 2) return false
                  if (r.bottom < 0 || r.right < 0) return false
                  return true
                } catch {
                  return false
                }
              }
              const vids = Array.from(doc?.querySelectorAll?.('video') ?? []) as any[]
              let best: any = null
              for (const v of vids) {
                if (!v || !isVisible(v)) continue
                const w = Number(v?.videoWidth || 0)
                const h = Number(v?.videoHeight || 0)
                if (!best) best = v
                if (w >= 240 && h >= 140) {
                  best = v
                  break
                }
              }
              const v: any = best || vids[0] || null
              if (!v) return { hasVideo: false, paused: true, ended: false, readyState: 0, currentTime: 0 }
              return {
                hasVideo: true,
                paused: !!v.paused,
                ended: !!v.ended,
                readyState: Number(v.readyState || 0),
                currentTime: Number(v.currentTime || 0)
              }
            })
            .catch(() => ({ hasVideo: false, paused: true, ended: false, readyState: 0, currentTime: 0 }))
          const t0 = Number(videoStateBefore?.currentTime || 0)
          const t1 = Number(videoStateAfter?.currentTime || 0)
          const advanced = Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 + 0.25
          const stablePlaying =
            !!videoStateAfter?.hasVideo && !videoStateAfter?.paused && !videoStateAfter?.ended && Number(videoStateAfter?.readyState || 0) >= 2
          intentSatisfiedAfter = advanced || stablePlaying
        }
        const toastAfter = intent ? await collectToastText(session!.page).catch(() => '') : ''
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'ensure_play',
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextAfter: snap.text,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length,
          ...(intent ? { intent, intentSatisfiedBefore, intentSatisfiedAfter, toastAfter } : {})
        })
        emitStepEnd(endMeta)
        const playAttemptCount = intentSatisfiedAfter ? 0 : playAttemptCountBefore + 1
        const lastPlayAttemptAt = Date.now()
        const lastPlayError = (() => {
          if (intentSatisfiedAfter) return ''
          const raw = String(playError || toastAfter || '').trim()
          const vj = (state as any).visionJson
          const visionHasOverlay = vj && typeof vj === 'object' ? !!(vj as any).hasOverlay : false
          const hint = `${raw}\n${String((state as any).visionSummary || '')}`.slice(0, 600)
          const code = (() => {
            if (/no visible video element/i.test(raw)) return 'no_visible_video'
            if (/NotAllowedError|denied|user gesture|play\(\) failed/i.test(raw)) return 'play_rejected'
            if (visionHasOverlay || /弹窗|对话框|遮罩|蒙层|同意|允许|继续|cookie|隐私|协议|登录|验证|captcha/i.test(hint)) return 'overlay_likely'
            return 'unknown'
          })()
          const detail = raw ? raw.replace(/\s+/g, ' ').trim().slice(0, 180) : 'no_signal'
          return `${code}:${detail}`.slice(0, 220)
        })()
        return {
          stepCount,
          phase: 'acting',
          pageUrl: snap.url,
          pageTitle: snap.title,
          pageText: snap.text,
          screenshotDataUrl: snap.dataUrl,
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: '',
          extractedCountBefore,
          playAttemptCount,
          lastPlayAttemptAt,
          lastPlayError
        }
      }
      if (action?.type === 'click') {
        const sel = String(action.selector || '').trim()
        if (!sel) throw new Error('click 缺少 selector')
        const intent = intentFromReason((action as any).reason)
        const intentSatisfiedBefore = intent ? await verifyIntentSatisfied(session!.page, intent, { ...verifyOpts(), attempts: 1 }).catch(() => false) : false
const riskMeta = await applyActionPolicy({ actionType: 'click', intent, selector: sel })
        const popupPromise = session!.page.waitForEvent('popup', { timeout: 2500 }).catch(() => null)
        const selectorList = splitSelectorList(sel)
        const clicked = await tryClick(session!.page, selectorList)
        if (!clicked.ok) {
          const isMaybeSearchInput = /keyword|search|搜索/i.test(sel)
          if (isMaybeSearchInput) {
            const focusRes = await tryFocus(session!.page, [
              'input.nav-search-input',
              'input[placeholder*="搜索"]',
              'input[name="keyword"]',
              ...selectorList
            ])
            if (!focusRes.ok) throw new Error(`page.click: Timeout; selector=${sel}`)
          } else {
            throw new Error(`page.click: Timeout; selector=${sel}`)
          }
        }
        const popup = await popupPromise
        await adoptPopup(session!, popup)
        await session!.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {})
        await session!.page.waitForTimeout(250)
        const toastAfter = intent ? await collectToastText(session!.page).catch(() => '') : ''
        const intentSatisfiedAfter = intent ? await verifyIntentSatisfied(session!.page, intent, { ...verifyOpts(), attempts: 2, waitMs: 500 }).catch(() => false) : false
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'click',
          selector: sel,
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length,
          ...(intent ? { intent, intentSatisfiedBefore, intentSatisfiedAfter, toastAfter } : {}),
          risk: riskMeta
        })
        emitStepEnd(endMeta)
        return {
          stepCount,
          phase: 'acting',
          pageUrl: snap.url,
          pageTitle: snap.title,
          pageText: snap.text,
          screenshotDataUrl: snap.dataUrl,
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: '',
          extractedCountBefore,
          confirmCount: confirmCountNext,
          lastConfirmedActionKey,
          lastConfirmAt
        }
      }
      if (action?.type === 'type_candidate') {
        return await executeTypeCandidate({
          action,
          state,
          session,
          params,
          stepCount,
          pageUrlBefore,
          extractedCountBefore,
          confirmCountNext,
          resolveCandidate,
          candidateLocator,
          uniqueLocator,
          applyActionPolicy,
          intentFromReason,
          adoptPopup,
          pageSnapshot,
          pushState,
          buildEndMeta,
          textDigest,
          emitStepEnd,
          getConfirmState
        })
      }
      if (action?.type === 'type') {
        const rawText = String(action.text || '')
        const wantsEnter = /\n$/.test(rawText) || /\{enter\}$/i.test(rawText.trim())
        const text = rawText.replace(/\{enter\}$/i, '').replace(/\n+$/g, '')
        if (action.selector) {
          const sel = String(action.selector).trim()
          const selectorList = splitSelectorList(sel)
          const filled = await tryFill(session!.page, selectorList, text)
          if (!filled.ok) {
            throw new Error(`page.fill: Timeout; selector=${sel}`)
          }
        } else {
          await session!.page.keyboard.type(text)
        }
        const riskMeta = wantsEnter ? await applyActionPolicy({ actionType: 'type_submit', intent: intentFromReason((action as any).reason), selector: String(action.selector || '') }) : null
        if (wantsEnter) {
          const popupPromise = session!.page.waitForEvent('popup', { timeout: 2500 }).catch(() => null)
          await session!.page.keyboard.press('Enter').catch(() => {})
          const popup = await popupPromise
          await adoptPopup(session!, popup)
        }
        await session!.page.waitForTimeout(250)
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'type',
          selector: action.selector ? String(action.selector) : '(keyboard)',
          textLen: text.length,
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length,
          ...(riskMeta ? { risk: riskMeta } : {})
        })
        emitStepEnd(endMeta)
        const isCommentInput = /评论|comment/i.test(String(action.selector || ''))
        return {
          stepCount,
          phase: 'acting',
          pageUrl: snap.url,
          pageTitle: snap.title,
          pageText: snap.text,
          screenshotDataUrl: snap.dataUrl,
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: '',
          extractedCountBefore,
          confirmCount: confirmCountNext,
          lastConfirmedActionKey,
          lastConfirmAt,
          ...(isCommentInput && text ? { lastCommentText: text } : {})
        }
      }
      if (action?.type === 'click_by_bbox') {
        const resolveCandidate = (arrRaw: any, index: number) => {
          const arr = Array.isArray(arrRaw) ? (arrRaw as any[]).map((x) => x || {}) : []
          const idx = Number(index)
          if (!Number.isFinite(idx)) return null
          const c = arr[Math.max(0, Math.floor(idx))]
          return c || null
        }
        const idx = Math.max(0, Math.floor(Number((action as any).index ?? 0)))
        const fromState = Array.isArray(state.candidates) ? (state.candidates as any[]).map((x) => x || {}) : []
        const refreshed = await collectCandidatesFromModule(session!.page, Math.max(40, idx + 12)).catch(() => [] as any[])
        const c: any = resolveCandidate(refreshed, idx) || resolveCandidate(fromState, idx)
        if (!c?.bbox) throw new Error(`click_by_bbox 缺少 bbox：index=${idx}`)
        if (Array.isArray(refreshed) && refreshed.length) {
          emitLog('info', `click_by_bbox: 使用最新候选坐标 index=${idx} total=${refreshed.length}`)
        }
        const intent = intentFromReason((action as any).reason)
        const label = String(c?.label || '').trim()
        const intentSatisfiedBefore = intent ? await verifyIntentSatisfied(session!.page, intent, { ...verifyOpts(), attempts: 1 }).catch(() => false) : false
        const riskMeta = await applyActionPolicy({ actionType: 'click_by_bbox', intent, label, selector: String(c?.selector || ''), href: String(c?.href || '') })
        const b = c.bbox
        const x = Number(b.x)
        const y = Number(b.y)
        const w = Number(b.width)
        const h = Number(b.height)
        if (![x, y, w, h].every((n) => Number.isFinite(n))) throw new Error(`click_by_bbox bbox 非法：index=${idx}`)
        const hitOk = await elementAtCandidatePointLooksRight(c)
        if (!hitOk) throw new Error(`click_by_bbox 命中校验失败：index=${idx}`)
        const vp = session!.page.viewportSize?.() as any
        const maxX = Number(vp?.width || 1280) - 2
        const maxY = Number(vp?.height || 720) - 2
        const cx = Math.max(2, Math.min(maxX, Math.floor(x + Math.max(0, w) / 2)))
        const cy = Math.max(2, Math.min(maxY, Math.floor(y + Math.max(0, h) / 2)))
        const popupPromise = session!.page.waitForEvent('popup', { timeout: 2500 }).catch(() => null)
        await session!.page.mouse.move(cx, cy).catch(() => {})
        await session!.page.mouse.click(cx, cy).catch(() => {})
        const popup = await popupPromise
        await adoptPopup(session!, popup)
        await session!.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {})
        await session!.page.waitForTimeout(250).catch(() => {})
        const toastAfter = intent ? await collectToastText(session!.page).catch(() => '') : ''
        const intentSatisfiedAfter = intent ? await verifyIntentSatisfied(session!.page, intent, { ...verifyOpts(), attempts: 2, waitMs: 500 }).catch(() => false) : false
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url, lastClickCandidateIndex: idx })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'click_by_bbox',
          index: idx,
          label,
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length,
          ...(intent ? { intent, intentSatisfiedBefore, intentSatisfiedAfter, toastAfter } : {}),
          risk: riskMeta
        })
        emitStepEnd(endMeta)
        return {
          stepCount,
          phase: 'acting',
          pageUrl: snap.url,
          pageTitle: snap.title,
          pageText: snap.text,
          screenshotDataUrl: snap.dataUrl,
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: '',
          extractedCountBefore,
          lastClickCandidateIndex: idx,
          confirmCount: confirmCountNext,
          lastConfirmedActionKey,
          lastConfirmAt
        }
      }
      if (action?.type === 'click_by_text') {
        const raw = String((action as any).text || '').trim()
        if (!raw) throw new Error('click_by_text 缺少 text')
        const text = raw.length > 40 ? raw.slice(0, 40) : raw
        const inferredIntent = (() => {
          const s = String(text || '')
          if (/点赞|已赞|赞\b/i.test(s)) return 'like'
          if (/投币|硬币/i.test(s)) return 'coin'
          if (/关注|已关注|订阅|已订阅/i.test(s)) return 'follow'
          if (/收藏|已收藏/i.test(s)) return 'favorite'
          if (/播放|继续播放|开始播放/i.test(s)) return 'play'
          if (/发送|发布|发表评论|发\s*表|提交|投递/i.test(s)) return 'comment'
          return ''
        })()
        const intent = intentFromReason((action as any).reason) || inferredIntent
        const intentSatisfiedBefore = intent ? await verifyIntentSatisfied(session!.page, intent, { ...verifyOpts(), attempts: 1 }).catch(() => false) : false
        const riskMeta = await applyActionPolicy({ actionType: 'click_by_text', intent, label: text })
        const popupPromise = session!.page.waitForEvent('popup', { timeout: 2500 }).catch(() => null)

        const tryClick = async () => {
          const t = text
          const escapeRegExp = (s: string) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const exactRe = buildStableTextRegex(t) || new RegExp(`^${escapeRegExp(t)}$`, 'i')
          const loc = await uniqueLocator(session!.page.getByText(exactRe))
          if (loc) {
            await loc.scrollIntoViewIfNeeded().catch(() => {})
            await loc.click({ timeout: 2500 }).catch(() => {})
            return true
          }
          const clicked = await session!.page
            .evaluate((needle) => {
              const doc: any = (globalThis as any).document
              const win: any = (globalThis as any).window
              const toText = (el: any) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
              const isVisible = (el: any) => {
                try {
                  const st = win?.getComputedStyle?.(el)
                  if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') <= 0.01)) return false
                  if (String(st.pointerEvents || '').toLowerCase() === 'none') return false
                  const r = el?.getBoundingClientRect?.()
                  if (!r) return false
                  if (r.width <= 2 || r.height <= 2) return false
                  if (r.bottom < 0 || r.right < 0) return false
                  return true
                } catch {
                  return false
                }
              }
              const n = String(needle || '').trim().toLowerCase()
              if (!n) return false
              const nodes = Array.from(
                doc?.querySelectorAll?.('button, [role="button"], a, [role="link"], [role="tab"], [role="menuitem"], [aria-label], [title]') ?? []
              ) as any[]
              const matches: any[] = []
              for (const el of nodes) {
                if (!isVisible(el)) continue
                const label =
                  String(el?.getAttribute?.('aria-label') || '').trim() ||
                  String(el?.getAttribute?.('title') || '').trim() ||
                  toText(el)
                if (!label) continue
                const s = label.toLowerCase()
                if (s !== n && !s.includes(n)) continue
                matches.push({ el, label: s, exact: s === n ? 1 : 0 })
              }
              matches.sort((a, b) => b.exact - a.exact || a.label.length - b.label.length)
              const best = matches[0]
              if (!best) return false
              if (matches.length > 1 && matches[0].exact === matches[1].exact && matches[0].label === matches[1].label) return false
              try {
                best.el.scrollIntoView?.({ block: 'center', inline: 'center' })
              } catch {}
              try {
                best.el.click?.()
                return true
              } catch {}
              return false
            }, text)
            .catch(() => false)
          return !!clicked
        }

        const ok = await tryClick().catch(() => false)
        if (!ok) throw new Error(`click_by_text 未找到可点击目标：${text}`)
        const popup = await popupPromise
        await adoptPopup(session!, popup)
        await session!.page.waitForTimeout(350).catch(() => {})
        const toastAfter = intent ? await collectToastText(session!.page).catch(() => '') : ''
        const intentSatisfiedAfter = intent ? await verifyIntentSatisfied(session!.page, intent, { ...verifyOpts(), attempts: 2, waitMs: 500 }).catch(() => false) : false
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'click_by_text',
          text,
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length,
          ...(intent ? { intent, intentSatisfiedBefore, intentSatisfiedAfter, toastAfter } : {}),
          risk: riskMeta
        })
        emitStepEnd(endMeta)
        return {
          stepCount,
          phase: 'acting',
          pageUrl: snap.url,
          pageTitle: snap.title,
          pageText: snap.text,
          screenshotDataUrl: snap.dataUrl,
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: '',
          extractedCountBefore,
          confirmCount: confirmCountNext,
          lastConfirmedActionKey,
          lastConfirmAt
        }
      }
      if (action?.type === 'dismiss_overlays') {
        return await executeDismissOverlays({
          state,
          session,
          params,
          stepCount,
          pageUrlBefore,
          extractedCountBefore,
          tryDismissOverlays,
          pageSnapshot,
          pushState,
          buildEndMeta,
          textDigest,
          emitStepEnd
        })
      }
      if (action?.type === 'reload') {
        await session!.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        await session!.page.waitForTimeout(250).catch(() => {})
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'reload',
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length
        })
        emitStepEnd(endMeta)
        return { stepCount, phase: 'acting', pageUrl: snap.url, pageTitle: snap.title, pageText: snap.text, screenshotDataUrl: snap.dataUrl, route: 'verify', lastStepMeta: endMeta, failureType: '', extractedCountBefore }
      }
      if (action?.type === 'back') {
        const backOk = await session!.page.goBack({ waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false)
        if (!backOk) {
          await session!.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        }
        await session!.page.waitForTimeout(250).catch(() => {})
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'back',
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length
        })
        emitStepEnd(endMeta)
        return { stepCount, phase: 'acting', pageUrl: snap.url, pageTitle: snap.title, pageText: snap.text, screenshotDataUrl: snap.dataUrl, route: 'verify', lastStepMeta: endMeta, failureType: '', extractedCountBefore }
      }
      if (action?.type === 'scroll') {
        const dy = Number(action.dy || 800)
        await session!.page.mouse.wheel(0, Number.isFinite(dy) ? dy : 800)
        await session!.page.waitForTimeout(250)
        const snap = await pageSnapshot(session!.page)
        params.emit({ type: 'screenshot', payload: { dataUrl: snap.dataUrl, ts: Date.now() } })
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: snap.url })
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'scroll',
          dy,
          pageUrlBefore,
          pageUrlAfter: snap.url,
          pageTitleAfter: snap.title,
          pageTextHashAfter: textDigest(snap.text),
          pageTextLenAfter: snap.text.length
        })
        emitStepEnd(endMeta)
        return { stepCount, phase: 'acting', pageUrl: snap.url, pageTitle: snap.title, pageText: snap.text, screenshotDataUrl: snap.dataUrl, route: 'verify', lastStepMeta: endMeta, failureType: '', extractedCountBefore }
      }
      if (action?.type === 'wait') {
        const ms = Math.max(200, Math.min(120000, Math.floor(Number((action as any).ms || 1000))))
        const stageNow = String((state as any).stage || '')
        const shouldProbeVideo =
          stageNow === 'watch' || stageNow === 'play' || !!(state as any).waitForVideoEnd || Math.max(0, Math.floor(Number((state as any).watchUntilAt || 0))) > 0
        const videoBefore = shouldProbeVideo ? await detectVideoPlaybackStateDeep(session!.page).catch(() => null as any) : null
        await session!.page.waitForTimeout(ms).catch(() => {})
        const videoAfter = shouldProbeVideo ? await detectVideoPlaybackStateDeep(session!.page).catch(() => null as any) : null
        const urlAfter = String(session!.page.url() ?? '')
        const titleAfter = String((await session!.page.title().catch(() => '')) ?? '')
        pushState({ ...state, phase: 'acting', stepCount, pageUrl: urlAfter, pageTitle: titleAfter })
        const video = (() => {
          const b = videoBefore && typeof videoBefore === 'object' ? videoBefore : null
          const a = videoAfter && typeof videoAfter === 'object' ? videoAfter : null
          const hasVideo = !!(a?.hasVideo || b?.hasVideo)
          if (!hasVideo) return null
          const t0 = Number(b?.currentTime ?? 0)
          const t1 = Number(a?.currentTime ?? t0)
          const duration = Number(a?.duration ?? b?.duration ?? 0)
          const endedRaw = !!(a?.ended || b?.ended)
          const ended =
            endedRaw ||
            (Number.isFinite(duration) && duration > 0 && Number.isFinite(t1) && t1 >= duration - 0.4)
          const advanced = Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 + 0.25
          return { hasVideo, currentTimeBefore: t0, currentTimeAfter: t1, duration, ended, advanced }
        })()
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'wait',
          ms,
          ...(video ? { video } : {}),
          pageUrlBefore,
          pageUrlAfter: urlAfter,
          pageTitleAfter: titleAfter,
          pageTextHashAfter: textDigest(String(state.pageText || '')),
          pageTextLenAfter: String(state.pageText || '').length
        })
        emitStepEnd(endMeta)
        return {
          stepCount,
          phase: 'acting',
          pageUrl: urlAfter,
          pageTitle: titleAfter,
          pageText: String(state.pageText || ''),
          screenshotDataUrl: String(state.screenshotDataUrl || ''),
          route: 'verify',
          lastStepMeta: endMeta,
          failureType: ''
        }
      }
      if (action?.type === 'need_crawl') {
        const urls = await session!.page
          .evaluate(() => {
            const doc: any = (globalThis as any).document
            const anchors = Array.from((doc?.querySelectorAll?.('a[href]') as any) ?? [])
            const hrefs = anchors.map((a: any) => (a?.href ? String(a.href) : '')).filter(Boolean)
            const uniq: string[] = []
            const seen = new Set<string>()
            for (const h of hrefs) {
              if (seen.has(h)) continue
              seen.add(h)
              uniq.push(h)
              if (uniq.length >= 80) break
            }
            return uniq
          })
          .catch(() => [] as string[])
        const clipped = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 60)
        emitLog('info', `已收集待爬取 URL：${clipped.length}`)
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'need_crawl',
          count: clipped.length,
          pageUrlBefore,
          pageUrlAfter: String(state.pageUrl || ''),
          pageTitleAfter: String(state.pageTitle || ''),
          pageTextHashAfter: textDigest(String(state.pageText || '')),
          pageTextLenAfter: String(state.pageText || '').length
        })
        emitStepEnd(endMeta)
        return { stepCount, phase: 'acting', crawlUrls: clipped, route: 'crawler', lastStepMeta: endMeta, failureType: '', extractedCountBefore }
      }
      if (action?.type === 'extract') {
        return await executeExtract({
          action,
          state,
          session,
          stepCount,
          pageUrlBefore,
          extractedCountBefore,
          parseTopNFromTask,
          extractGenericListItems,
          extractStructured,
          buildEndMeta,
          textDigest,
          emitStepEnd
        })
      }
      if (action?.type === 'done') {
        const endMeta = await buildEndMeta({
          ok: true,
          type: 'done',
          pageUrlBefore,
          pageUrlAfter: String(state.pageUrl || ''),
          pageTitleAfter: String(state.pageTitle || ''),
          pageTextHashAfter: textDigest(String(state.pageText || '')),
          pageTextLenAfter: String(state.pageText || '').length
        })
        emitStepEnd(endMeta)
        return { stepCount, phase: 'acting', route: 'verify', lastStepMeta: endMeta, failureType: '', extractedCountBefore }
      }
      const endMeta = await buildEndMeta({
        ok: true,
        type: 'unknown',
        pageUrlBefore,
        pageUrlAfter: String(state.pageUrl || ''),
        pageTitleAfter: String(state.pageTitle || ''),
        pageTextHashAfter: textDigest(String(state.pageText || '')),
        pageTextLenAfter: String(state.pageText || '').length
      })
      emitStepEnd(endMeta)
      return { stepCount, phase: 'acting', route: 'verify', lastStepMeta: endMeta, failureType: '', extractedCountBefore }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e)
      emitLog('error', `动作失败：${msg}`)
      let failMeta: any = null
      try {
        failMeta = decorateEndMeta({
          ok: false,
          type: action?.type || 'unknown',
          error: msg,
          pageUrl: String(state.pageUrl || ''),
          pageUrlAfter: String(state.pageUrl || ''),
          pageTitleAfter: String(state.pageTitle || ''),
          pageTextHashAfter: textDigest(String(state.pageText || '')),
          pageTextLenAfter: String(state.pageText || '').length
        })
        emitStepEnd(failMeta)
      } catch {}
      const failureType = classifyFailureType(msg, String(state.pageUrl || ''))
      return {
        stepCount,
        phase: 'acting',
        error: msg,
        failureType,
        lastStepMeta: failMeta || { ok: false, type: action?.type || 'unknown', error: msg },
        route: 'recover',
        extractedCountBefore
      }
    }
  }

  const nodeCrawler: GraphNode<typeof LobsterState> = async (state) => {
    ensureNotAborted()
    await waitWhilePaused()
    const rawUrls = Array.isArray(state.crawlUrls) ? state.crawlUrls.map(String).filter(Boolean) : []
    if (!rawUrls.length) {
      emitLog('warn', '智能爬取：未获得 URL 列表，回退为页面抽取')
      const item = await extractStructured(undefined, state.pageText)
      return { phase: 'crawling', data: [...state.data, { ts: Date.now(), item, via: 'crawler_fallback' }], route: 'verify' }
    }

    const baseUrl =
      String(state.pageUrl || '').trim() ||
      String(state.plan?.startUrl || '').trim() ||
      String(params.startUrl || '').trim() ||
      String(initialStartUrl || '').trim()
    const base = (() => {
      try {
        return new URL(baseUrl)
      } catch {
        return null
      }
    })()
    if (!base?.hostname) {
      emitLog('warn', '智能爬取：baseUrl 无效，回退为页面抽取')
      const item = await extractStructured(undefined, state.pageText)
      return { phase: 'crawling', data: [...state.data, { ts: Date.now(), item, via: 'crawler_fallback' }], route: 'verify' }
    }

    const sameOriginOnly = params.config?.lobster?.crawlerSameOriginOnly !== false
    const maxUrls = Math.max(1, Math.floor(Number(params.config?.lobster?.crawlerMaxUrls ?? 40)))
    const concurrency = Math.max(1, Math.floor(Number(params.config?.lobster?.crawlerConcurrency ?? 4)))
    const timeoutMs = Math.max(800, Math.floor(Number(params.config?.lobster?.crawlerTimeoutMs ?? 12000)))
    const maxBytes = Math.max(50_000, Math.floor(Number(params.config?.lobster?.crawlerMaxBytes ?? 512_000)))
    const minIntervalMs = Math.max(0, Math.floor(Number(params.config?.lobster?.crawlerMinIntervalMs ?? 120)))

    const baseHost = normalizeHost(base.hostname)
    const basePort = effectivePort(base)
    const defaultSuffix = registrableDomainHeuristic(baseHost)
    const extraSuffixes = Array.isArray(params.config?.lobster?.crawlerAllowHostSuffixes)
      ? params.config?.lobster?.crawlerAllowHostSuffixes.map(String).filter(Boolean)
      : []
    const allowHostSuffixes = sameOriginOnly
      ? Array.from(new Set([baseHost, defaultSuffix, ...extraSuffixes].map(normalizeHost).filter(Boolean)))
      : Array.from(new Set(extraSuffixes.map(normalizeHost).filter(Boolean)))

    const uniq: string[] = []
    const seen = new Set<string>()
    for (const u of rawUrls) {
      const s = String(u || '').trim()
      if (!s) continue
      if (!/^https?:\/\//i.test(s)) continue
      if (seen.has(s)) continue
      seen.add(s)
      uniq.push(s)
      if (uniq.length >= Math.max(10, maxUrls * 2)) break
    }

    const filtered: string[] = []
    for (const u of uniq) {
      try {
        const x = new URL(u)
        const host = normalizeHost(x.hostname)
        if (x.protocol !== 'http:' && x.protocol !== 'https:') continue
        if (x.username || x.password) continue
        if (isBlockedHostname(host)) continue
        if (!isAllowedPortForCrawl(effectivePort(x), basePort)) continue
        if (allowHostSuffixes.length && !allowHostSuffixes.some((s) => isHostSuffixMatch(host, s))) continue
        filtered.push(x.toString())
        if (filtered.length >= maxUrls) break
      } catch {
        continue
      }
    }

    if (!filtered.length) {
      emitLog('warn', '智能爬取：URL 全部被安全策略拦截，回退为页面抽取')
      const item = await extractStructured(undefined, state.pageText)
      return { phase: 'crawling', data: [...state.data, { ts: Date.now(), item, via: 'crawler_fallback' }], route: 'verify' }
    }

    emitLog('info', `智能爬取：并发=${concurrency} urls=${filtered.length} baseHost=${baseHost}`)

    let nextAllowedAt = 0
    let gate: Promise<void> = Promise.resolve()
    const rateLimit = async () => {
      if (minIntervalMs <= 0) return
      let release = () => {}
      const p = new Promise<void>((resolve) => {
        release = () => resolve()
      })
      const prev = gate
      gate = gate.then(() => p)
      await prev
      const now = Date.now()
      const wait = Math.max(0, nextAllowedAt - now)
      nextAllowedAt = Math.max(nextAllowedAt, now) + minIntervalMs
      release()
      if (wait > 0) await sleepMs(wait)
    }

    const fetchOne = async (url: string) => {
      ensureNotAborted()
      await rateLimit()
      const res = await safeFetchText(url, {
        signal: params.signal,
        timeoutMs,
        maxBytes,
        allowHostSuffixes,
        basePort,
        minIntervalMs: 0
      })
      const raw = String(res.text || '')
      const title = (() => {
        const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
        const t = m ? String(m[1] || '') : ''
        return t.replace(/\s+/g, ' ').trim().slice(0, 180)
      })()
      const excerpt = (() => {
        const s = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        const t = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        return t.slice(0, 260)
      })()
      return { url, finalUrl: res.finalUrl, status: res.status, title, excerpt }
    }

    const items = await mapWithConcurrency(filtered, concurrency, async (u) => {
      try {
        return await fetchOne(u)
      } catch (e: any) {
        return { url: u, error: e?.message ? String(e.message) : String(e) }
      }
    })
    return {
      phase: 'crawling',
      data: [...state.data, { ts: Date.now(), items, via: 'crawler_http' }],
      crawlUrls: [],
      route: 'verify'
    }
  }

  const nodeVerify = createNodeVerify({
    ensureNotAborted,
    waitWhilePaused,
    session: session as any,
    emitLog,
    allowRiskyRecoveryClicks: !!params.config?.lobster?.allowRiskyRecoveryClicks,
    collectPageSignals,
    detectVideoPlaybackStateDeep,
    normalizeUrlForCompare,
    pickAdapterKey,
    parseQueryFromTask,
    pickGenericFirstResultCandidateIndex,
    pickCandidateIndexByIntent,
    looksLikeLoginUrl,
    getForcedIntents,
    maxForcedIntentsTotal: Number(params.config?.lobster?.maxForcedIntentsTotal ?? 10),
    maxForcedIntentsPerFailure: Number(params.config?.lobster?.maxForcedIntentsPerFailure ?? 2)
  })

  const nodeRecover = createNodeRecover({
    ensureNotAborted,
    waitWhilePaused,
    headless,
    session: session as any,
    emitLog,
    allowRiskyRecoveryClicks: !!params.config?.lobster?.allowRiskyRecoveryClicks,
    tryDismissOverlays,
    parseQueryFromTask,
    pickCandidateIndexByIntent,
    pickGenericFirstResultCandidateIndex,
    getForcedIntents,
    maxRecoverCount: Number(params.config?.lobster?.maxRecoverCount ?? 6),
    maxForcedIntentsTotal: Number(params.config?.lobster?.maxForcedIntentsTotal ?? 10),
    maxForcedIntentsPerFailure: Number(params.config?.lobster?.maxForcedIntentsPerFailure ?? 2)
  })

  const router = (state: any) => {
    const r = String(state.route || '').trim()
    if (r === 'login') return 'login'
    if (r === 'captcha') return 'captcha'
    if (r === 'perception') return 'perception'
    if (r === 'decision') return 'decision'
    if (r === 'act') return 'act'
    if (r === 'verify') return 'verify'
    if (r === 'crawler') return 'crawler'
    if (r === 'recover') return 'recover'
    if (r === 'end') return END
    return END
  }

  const graph = new StateGraph(LobsterState)
    .addNode('planner', nodePlanner)
    .addNode('login', nodeLogin)
    .addNode('captcha', nodeCaptcha)
    .addNode('perception', nodePerception)
    .addNode('decision', nodeDecision)
    .addNode('act', nodeAction)
    .addNode('verify', nodeVerify)
    .addNode('crawler', nodeCrawler)
    .addNode('recover', nodeRecover)
    .addEdge(START, 'planner')
    .addConditionalEdges('planner', router)
    .addConditionalEdges('login', router)
    .addConditionalEdges('captcha', router)
    .addConditionalEdges('perception', router)
    .addConditionalEdges('decision', router)
    .addConditionalEdges('act', router)
    .addConditionalEdges('crawler', router)
    .addConditionalEdges('verify', router)
    .addConditionalEdges('recover', router)
    .compile()

  emitLog('info', '任务开始')
  params.emit({ type: 'state', payload: { phase: 'planning', stepCount: 0, pageUrl: '' } })

  try {
    const waitVideoEnd = wantsWaitForVideoEnd(params.task)
    const maxStepsCfg = Number(params.config?.lobster?.maxSteps ?? 20)
    const baseMaxSteps = Number.isFinite(maxStepsCfg) && maxStepsCfg > 0 ? Math.floor(maxStepsCfg) : 20
    const recursionLimit = waitVideoEnd ? Math.max(4000, baseMaxSteps * 30) : Math.max(50, baseMaxSteps * 3)
    const finalState = await graph.invoke(
      {
        task: params.task,
        startUrl: params.startUrl
      },
      { signal: params.signal as any, recursionLimit }
    )

    const output = wrapLobsterOutput(
      {
        traceId,
        traceZipPath: tracingStarted && traceZipPath ? traceZipPath : undefined,
        task: params.task,
        plan: finalState.plan,
        finalUrl: finalState.pageUrl,
        pageTitle: String((finalState as any).pageTitle || '').trim() || undefined,
        stats: {
          stepCount: Number((finalState as any).stepCount || 0),
          modelCalls: Number((finalState as any).modelCalls || 0),
          decisionCalls: Number((finalState as any).decisionCalls || 0),
          visionCalls: Number((finalState as any).visionCalls || 0),
          ocrCalls: Number((finalState as any).ocrCalls || 0),
          recoverCount: Number((finalState as any).recoverCount || 0),
          forcedInjectTotal: Number((finalState as any).forcedInjectTotal || 0),
          lastPlayError: String((finalState as any).lastPlayError || '')
        },
        data: finalState.data,
        replay,
        failureType: String((finalState as any).failureType || '').trim() || undefined
      },
      'classic',
      {
        confirmCount: Number((finalState as any).confirmCount || 0),
        answer: (() => {
          const title = String((finalState as any).pageTitle || '').trim()
          const url = String(finalState.pageUrl || '').trim()
          const start = String(
            (finalState as any).startUrl ||
              (finalState as any).plan?.startUrl ||
              params.startUrl ||
              '',
          ).trim()
          // 禁止用起始页标题冒充「已打开详情」答案（总管会误判成功或对不齐）
          if (
            title &&
            url &&
            hasLeftStartPage(url, start) &&
            isSearchOpenDestinationUrl(url)
          ) {
            return `标题：${title}\n链接：${url}`
          }
          return undefined
        })(),
        failureType: (() => {
          const existing = String((finalState as any).failureType || '').trim()
          if (existing) return existing
          const g =
            (finalState as any).goals ||
            (finalState as any).taskSpec?.goals ||
            (finalState as any).plan?.goals
          const mustEnter = !!(g && (g as any).mustEnterDetail)
          const url = String(finalState.pageUrl || '').trim()
          const start = String(
            (finalState as any).startUrl ||
              (finalState as any).plan?.startUrl ||
              params.startUrl ||
              '',
          ).trim()
          if (mustEnter && start && !hasLeftStartPage(url, start)) {
            return 'navigation_unverified'
          }
          return undefined
        })(),
      }
    )
    params.emit({ type: 'result', payload: output })
    return output
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e)
    params.emit({ type: 'error', payload: { message: sanitize(msg), ts: Date.now() } })
    throw e
  } finally {
    if (session && tracingStarted) {
      try {
        if (traceZipPath) await session.context.tracing.stop({ path: traceZipPath })
        else await session.context.tracing.stop()
      } catch {}
    }
    await closeSession(session)
  }
}
