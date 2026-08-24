/** Lobster GUI run verify（Manager / Lobster / smoke 共用，无运行时依赖） */

import { extractAllHttpUrls, sanitizeExtractedHttpUrl } from './extractHttpUrl'

export type LobsterRunVerifyInput = {
  task: string
  status: string
  result?: unknown
  error?: string | null
}

export type LobsterRunVerifyOutcome = {
  ok: boolean
  reason: string
  failureType?: string
  hints?: string[]
}

export type LobsterSemanticBlock = {
  blocked: true
  reason: 'task_blocked'
  failureType: string
}

const INFRA_FAILURE_RE =
  /Chromium distribution|playwright install|install-browser|Browser .* is not installed|executable doesn't exist|async initializeServer|Connection closed|playwright_mcp_browser_unavailable|浏览器启动失败|浏览器环境缺少|无法执行任务.*(?:未安装|Chrome|Chromium|WebKit)/i

/** 网络/DNS 失败（工具原文或 LLM 改写后的中文失败文案）——不得当成功 answer */
const NETWORK_FAILURE_RE =
  /net::ERR_[A-Z0-9_]+|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|DNS_PROBE|域名解析(?:失败)?|无法访问目标页面|无法解析(?:主机|域名)|name\s*not\s*resolved|getaddrinfo\s+ENOTFOUND|network\s*(?:error|unreachable|failure)|chrome-error|chromewebdata|This site can'?t be reached|无法访问此网站|网页无法打开|站点无法访问/i

/** Chromium/浏览器错误页 URL（非真实站点） */
export function isUnreachableBrowseUrl(url: string): boolean {
  const s = String(url || '').trim()
  if (!s) return false
  const lower = s.toLowerCase()
  if (lower.startsWith('chrome-error:') || lower.includes('chromewebdata')) return true
  if (/^(chrome|edge|about):/i.test(s)) return true
  return false
}

/** 可作为浏览证据的 finalUrl：须为 http(s) 且非错误页 */
export function isHttpBrowseUrl(url: string): boolean {
  const s = String(url || '').trim()
  if (!s || isUnreachableBrowseUrl(s)) return false
  return /^https?:\/\//i.test(s)
}

const SEMANTIC_FAILURE_TYPES = new Set([
  'captcha',
  'need_login',
  'need_human',
  'denied',
  'rate_limited',
  'blocked',
  'blocked_by_overlay',
])

const SEMANTIC_BLOCK_TEXT_RE =
  /无法自动(?:通过|完成)|不能自动(?:通过|完成)|需(?:要)?人工(?:介入|处理|验证)?|人机验证|图形验证码|安全验证|反爬|验证码(?:页面|拦截)?|captcha|recaptcha|turnstile|hcaptcha|wappass\.|login[\s_-]?wall|登录墙|请先登录|需要登录|访问过于频繁|rate[\s_-]?limit/i

const CAPTCHA_SIGNAL_RE = /验证码|captcha|recaptcha|turnstile|wappass|人机|安全校验|图形验证/i
const CAPTCHA_URL_RE = /wappass\.|\/captcha|recaptcha|turnstile|challenge/i

const INCOMPLETE_ANSWER_RE =
  /已达最大步数|max(?:imum)?\s*steps?|步数上限|未完成|尚未执行|仍停留在|没有(?:出现|找到).*(?:结果|列表)|请缩小任务范围|改用\s*classic/i

const DESKTOP_TASK_RE =
  /(记事本|Notepad|桌面|Windows\s*应用|原生应用|Excel|Word|PowerPoint|保存到桌面|资源管理器|Explorer|系统设置)/i

const SEARCH_RESULT_URL_RE = /[?&](?:wd|q|query|keyword|search)=|\/s\?|search\.|\/search/i

function resultPayload(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
}

function collectResultText(result: unknown): string {
  const row = resultPayload(result)
  const parts = [String(row.answer || row.summary || '').trim()]
  const data = Array.isArray(row.data) ? row.data : []
  for (const chunk of data) {
    if (!chunk || typeof chunk !== 'object') continue
    const c = chunk as Record<string, unknown>
    parts.push(String(c.text || '').trim())
    const items = Array.isArray(c.items) ? c.items : []
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      parts.push(String((it as Record<string, unknown>).text || '').trim())
    }
  }
  return parts.filter(Boolean).join('\n')
}

function collectResultItems(result: unknown): unknown[] {
  const row = resultPayload(result)
  const data = Array.isArray(row.data) ? row.data : []
  return data.flatMap((chunk) => {
    if (!chunk || typeof chunk !== 'object') return []
    const items = (chunk as Record<string, unknown>).items
    return Array.isArray(items) ? items : []
  })
}

function isIncompleteRunAnswer(text: string): boolean {
  const s = String(text || '').trim()
  if (!s) return false
  return INCOMPLETE_ANSWER_RE.test(s)
}

function collectNetworkFailureBlob(input: {
  error?: string | null
  text?: string
  result?: unknown
}): string {
  const row = resultPayload(input.result)
  const ft = String(row.failureType || row.error_code || '').trim()
  const finalUrl = String(row.finalUrl || row.url || '').trim()
  return [input.error, input.text, collectResultText(input.result), ft, finalUrl].filter(Boolean).join('\n')
}

/**
 * 网络/DNS 失败文案检测（字符串或 result 对象）。
 * 供 Manager wrap/evaluator 与 Lobster verify 共用。
 */
export function looksLikeNetworkFailure(blob: unknown): boolean {
  if (blob && typeof blob === 'object') {
    const row = blob as Record<string, unknown>
    const ft = String(row.failureType || row.error_code || '').trim().toLowerCase()
    if (ft === 'network' || ft === 'network_unreachable') return true
    const finalUrl = String(row.finalUrl || row.url || '').trim()
    if (isUnreachableBrowseUrl(finalUrl)) return true
    return NETWORK_FAILURE_RE.test(collectNetworkFailureBlob({ result: blob }))
  }
  const s = String(blob || '')
  if (isUnreachableBrowseUrl(s)) return true
  return NETWORK_FAILURE_RE.test(s)
}

/** 结果是否为网络/DNS 失败（含 failureType=network） */
export function isLobsterNetworkFailure(input: {
  error?: string | null
  text?: string
  result?: unknown
}): boolean {
  const row = resultPayload(input.result)
  const ft = String(row.failureType || row.error_code || '').trim().toLowerCase()
  if (ft === 'network' || ft === 'network_unreachable') return true
  const finalUrl = String(row.finalUrl || row.url || '').trim()
  if (isUnreachableBrowseUrl(finalUrl)) return true
  return looksLikeNetworkFailure(collectNetworkFailureBlob(input))
}

function isSearchResultsPage(finalUrl: string): boolean {
  const url = String(finalUrl || '').trim()
  if (!url || CAPTCHA_URL_RE.test(url)) return false
  return SEARCH_RESULT_URL_RE.test(url)
}

function isLikelySearchNotStarted(task: string, finalUrl: string): boolean {
  if (isSearchResultsPage(finalUrl)) return false
  if (isLikelyStartPageOnly(task, finalUrl)) return true
  const url = String(finalUrl || '').trim().toLowerCase()
  const blob = `${task} ${url}`
  if (/baidu\.com/i.test(url) && /(百度|baidu)/i.test(blob)) {
    try {
      const u = new URL(finalUrl)
      return !u.searchParams.get('wd') && !u.searchParams.get('word')
    } catch {
      return true
    }
  }
  if (/google\.com/i.test(url) && /(google|谷歌)/i.test(blob)) {
    try {
      const u = new URL(finalUrl)
      return !u.searchParams.get('q')
    } catch {
      return true
    }
  }
  return false
}

function isLikelyStartPageOnly(task: string, finalUrl: string, startUrlHint?: string): boolean {
  const url = String(finalUrl || '').trim()
  if (!url || CAPTCHA_URL_RE.test(url)) return false
  const taskUrls = extractAllHttpUrls(String(task || ''))
  const hint = sanitizeExtractedHttpUrl(String(startUrlHint || '').trim()) || ''
  const candidates = [hint, ...taskUrls].filter(Boolean)
  if (!candidates.length) return false
  try {
    const current = new URL(url)
    return candidates.some((raw) => {
      try {
        const start = new URL(raw)
        return start.hostname === current.hostname && start.pathname.replace(/\/+$/, '') === current.pathname.replace(/\/+$/, '')
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function isDesktopAppTask(task: string, result?: unknown): boolean {
  const row = resultPayload(result)
  const engine = String(row.executionEngine || row.engine || '').trim().toLowerCase()
  if (engine === 'desktop') return true
  return DESKTOP_TASK_RE.test(String(task || '').trim())
}

function verifyDesktopAppOutput(task: string, result: unknown): LobsterRunVerifyOutcome | null {
  if (!isDesktopAppTask(task, result)) return null
  const answer = collectResultText(result)
  const blob = `${task}\n${answer}`
  if (isIncompleteRunAnswer(answer)) {
    return { ok: false, reason: 'incomplete_max_steps', hints: [answer.slice(0, 240) || '桌面任务未完成'] }
  }
  if (/(记事本|Notepad)/i.test(task) && /(Hello|hello)/i.test(blob)) {
    const saved = /(保存|saved|save|桌面|Desktop|\.txt|已写入)/i.test(answer)
    if (!saved) {
      return {
        ok: false,
        reason: 'desktop_save_unverified',
        hints: [answer.slice(0, 240) || '未确认 Hello World 已保存到桌面'],
      }
    }
    return { ok: true, reason: 'ok' }
  }
  if (answer.length < 12) {
    return { ok: false, reason: 'incomplete_task_output', hints: [answer.slice(0, 240) || '桌面任务输出过短'] }
  }
  if (/(打开|输入|保存|点击|完成|已|成功)/i.test(answer)) return { ok: true, reason: 'ok' }
  return { ok: false, reason: 'incomplete_task_output', hints: [answer.slice(0, 240) || '桌面任务目标未达成'] }
}

function isOpenOnlyBrowseTask(task: string): boolean {
  const t = String(task || '')
  if (!/(打开|导航|访问|browse|navigate)/i.test(t)) return false
  // 含点击/搜索/抽取等后续动作时，停在起始页不算完成
  return !/(点击|进入|first|第一条|搜索|search|查找|抽取|提取|列表|items)/i.test(t)
}

/** 填表任务：同页完成，禁止用「打开/First name」误判成须离页导航 */
export function isFormFillBrowseTask(task: string, result?: unknown): boolean {
  const row = resultPayload(result)
  const kind = String(row.task_kind || row.taskKind || '').trim().toLowerCase()
  if (kind === 'form_fill' || kind === 'login') return true
  const enginePath = String(
    (row.stats && typeof row.stats === 'object'
      ? (row.stats as Record<string, unknown>).enginePath
      : '') || '',
  )
  if (enginePath === 'playwright_form') return true
  const t = String(task || '')
  if (/(填|填写|form\s*fill|输入框|First\s*name|Last\s*name|custname|Customer\s*name)/i.test(t)) {
    // 明确点进详情/搜索的复合句不算纯填表
    if (/(点击第一个|进入详情|搜索|search)/i.test(t) && !/(填|填写)/i.test(t)) return false
    return true
  }
  return false
}

export function collectFormFilledEvidence(result: unknown): Array<{ key: string; value: string }> {
  const row = resultPayload(result)
  const out: Array<{ key: string; value: string }> = []
  const push = (k: unknown, v: unknown) => {
    const key = String(k || '').trim()
    const value = String(v || '').trim()
    if (key && value && !out.some((x) => x.key === key)) out.push({ key, value })
  }
  if (Array.isArray(row.filled)) {
    for (const it of row.filled) {
      if (it && typeof it === 'object') {
        push((it as any).key, (it as any).value)
      }
    }
  }
  const data = Array.isArray(row.data) ? row.data : []
  for (const chunk of data) {
    if (!chunk || typeof chunk !== 'object') continue
    const filled = (chunk as Record<string, unknown>).filled
    if (Array.isArray(filled)) {
      for (const it of filled) {
        if (it && typeof it === 'object') push((it as any).key, (it as any).value)
      }
    }
  }
  const answer = String(row.answer || '').trim()
  const m = answer.matchAll(/([a-zA-Z0-9_\u4e00-\u9fff]+)=([^\s；;，,]+)/g)
  for (const hit of m) {
    if (hit[1] && hit[2] && /已填/.test(answer)) push(hit[1], hit[2])
  }
  return out
}

function hasMeaningfulTaskOutput(task: string, result: unknown): boolean {
  const row = resultPayload(result)
  const items = collectResultItems(result)
  const finalUrl = String(row.finalUrl || row.url || '').trim()
  const answer = String(row.answer || row.summary || '').trim()
  const failureType = String(row.failureType || '').trim().toLowerCase()
  if (failureType === 'network' || failureType === 'network_unreachable') return false
  if (failureType.startsWith('incomplete')) return false
  if (isLobsterNetworkFailure({ result, text: answer })) return false
  if (isIncompleteRunAnswer(answer) || isIncompleteRunAnswer(collectResultText(result))) return false

  if (isDesktopAppTask(task, result)) {
    const desktop = verifyDesktopAppOutput(task, result)
    return desktop?.ok === true
  }

  // form_fill：必须看 filled 证据，禁止首页标题/空 items 冒充成功
  if (isFormFillBrowseTask(task, result)) {
    const filled = collectFormFilledEvidence(result)
    if (filled.length > 0) return true
    if (/已填\s+\S+=/.test(answer)) return true
    return false
  }

  if (items.length > 0 && !CAPTCHA_URL_RE.test(finalUrl)) return true

  if (/(搜索|search|查找|query)/i.test(task)) {
    // P3-L5-4：抽取类禁止仅靠 finalUrl 过 verify，必须有 answer 或 items
    const wantsExtract = /(抽取|提取|获取|输出|列表|结果|items|前\s*\d+\s*条|top\s*\d+)/i.test(task)
    if (wantsExtract) {
      if (items.length > 0) return true
      if (
        answer.length > 24 &&
        !SEMANTIC_BLOCK_TEXT_RE.test(answer) &&
        !INCOMPLETE_ANSWER_RE.test(answer) &&
        !looksLikeNetworkFailure(answer)
      ) {
        return true
      }
      return false
    }
    if (SEARCH_RESULT_URL_RE.test(finalUrl) && !CAPTCHA_URL_RE.test(finalUrl)) return true
    if (items.length > 0) return true
    if (
      answer.length > 24 &&
      !SEMANTIC_BLOCK_TEXT_RE.test(answer) &&
      !INCOMPLETE_ANSWER_RE.test(answer) &&
      !looksLikeNetworkFailure(answer)
    ) {
      return true
    }
    return false
  }

  if (/(打开|点击|进入|first|第一条|导航)/i.test(task)) {
    // 纯打开：停在任务 URL 即成功（勿用 isLikelyStartPageOnly 误杀）
    if (isOpenOnlyBrowseTask(task) && isHttpBrowseUrl(finalUrl) && !CAPTCHA_URL_RE.test(finalUrl)) return true
    if (isHttpBrowseUrl(finalUrl) && !CAPTCHA_URL_RE.test(finalUrl) && !isLikelyStartPageOnly(task, finalUrl)) {
      return true
    }
    if (items.length > 0) return true
    // 仍在起始页：禁止仅靠 answer（首页标题冒充详情）过 verify
    if (isLikelyStartPageOnly(task, finalUrl)) return false
    if (
      answer.length > 24 &&
      isHttpBrowseUrl(finalUrl) &&
      !CAPTCHA_URL_RE.test(finalUrl) &&
      !looksLikeNetworkFailure(answer)
    ) {
      return true
    }
    return false
  }

  if (isHttpBrowseUrl(finalUrl) && !CAPTCHA_URL_RE.test(finalUrl)) return true
  return false
}

/** 任务语义层阻塞（验证码/登录墙/需人工），与浏览器 infra 失败区分 */
export function detectLobsterSemanticBlock(input: {
  task?: string
  result?: unknown
  text?: string
}): LobsterSemanticBlock | null {
  const row = resultPayload(input.result)
  const failureType = String(row.failureType || '').trim().toLowerCase()
  if (failureType && SEMANTIC_FAILURE_TYPES.has(failureType)) {
    return { blocked: true, reason: 'task_blocked', failureType }
  }

  const finalUrl = String(row.finalUrl || row.url || '').trim()
  const blob = [input.text, collectResultText(input.result), finalUrl].filter(Boolean).join('\n')

  // 先判拦截信号：禁止「有 http finalUrl 就算有产出」掩盖登录墙/验证码
  if (CAPTCHA_URL_RE.test(finalUrl) || /wappass\./i.test(blob)) {
    return { blocked: true, reason: 'task_blocked', failureType: 'captcha' }
  }
  if (SEMANTIC_BLOCK_TEXT_RE.test(blob)) {
    if (CAPTCHA_SIGNAL_RE.test(blob)) {
      return { blocked: true, reason: 'task_blocked', failureType: 'captcha' }
    }
    if (/登录|login|sign[\s_-]?in|授权/i.test(blob)) {
      return { blocked: true, reason: 'task_blocked', failureType: 'need_login' }
    }
    return { blocked: true, reason: 'task_blocked', failureType: 'need_human' }
  }
  // URL 路径像登录墙且无列表/抽取证据
  if (/\/login\b|\/signin\b|\/sso\b/i.test(finalUrl) && collectResultItems(input.result).length === 0) {
    const answer = String(row.answer || row.summary || '').trim()
    if (!answer || /登录|login|sign[\s_-]?in|请先|未授权|unauthorized/i.test(answer)) {
      return { blocked: true, reason: 'task_blocked', failureType: 'need_login' }
    }
  }

  const task = String(input.task || '').trim()
  if (hasMeaningfulTaskOutput(task, input.result)) return null
  return null
}

/** 结果是否已含可用浏览证据（finalUrl / 实质 answer / items） */
export function hasLobsterBrowseEvidence(result?: unknown): boolean {
  if (isLobsterNetworkFailure({ result })) return false
  const row = resultPayload(result)
  const finalUrl = String(row.finalUrl || row.url || '').trim()
  if (finalUrl && !isHttpBrowseUrl(finalUrl)) return false
  if (isHttpBrowseUrl(finalUrl) && !CAPTCHA_URL_RE.test(finalUrl)) return true
  if (collectResultItems(result).length > 0) return true
  const answer = String(row.answer || row.summary || '').trim()
  if (looksLikeNetworkFailure(answer)) return false
  return answer.length > 12 && !INCOMPLETE_ANSWER_RE.test(answer)
}

/** 仅 infra/连接类失败应触发引擎回退；语义阻塞与 canceled 不应重试 */
export function isLobsterRetryableFailure(input: {
  status?: string
  error?: string | null
  result?: unknown
  text?: string
  verify?: Pick<LobsterRunVerifyOutcome, 'reason'>
}): boolean {
  const status = String(input.status || '').trim().toLowerCase()
  if (status === 'canceled') return false
  const verifyReason = String(input.verify?.reason || '').trim()
  if (verifyReason === 'canceled' || verifyReason === 'task_blocked') return false
  if (isLobsterInfrastructureFailure(input)) return true
  if (verifyReason === 'network_unreachable' || isLobsterNetworkFailure(input)) return true
  // 未离开起始页：即使已有 homepage finalUrl，仍应允许引擎回退
  if (verifyReason === 'navigation_unverified') return true
  // 已有可用浏览证据时，不再因 empty 等触发引擎整段回退
  if (hasLobsterBrowseEvidence(input.result)) return false
  return (
    verifyReason === 'browser_infra_unavailable' ||
    verifyReason === 'network_unreachable' ||
    /^incomplete_/.test(verifyReason) ||
    verifyReason === 'empty_result' ||
    verifyReason === 'search_no_results' ||
    verifyReason === 'search_extract_empty' ||
    verifyReason === 'error'
  )
}

/**
 * 真基建/连接失败才算 infrastructure。
 * 禁止把任意 status=error/canceled 一律当成基建（否则 MCP poll 已出截图仍强制 classic 双跑）。
 * 网络/DNS 走 isLobsterNetworkFailure，不并入本函数（避免与 verify 早退顺序冲突）。
 */
export function isLobsterInfrastructureFailure(input: {
  status?: string
  error?: string | null
  result?: unknown
  text?: string
}): boolean {
  const status = String(input.status || '').trim().toLowerCase()
  if (status === 'canceled') return false
  const blob = [input.error, input.text, collectResultText(input.result)].filter(Boolean).join('\n')
  return INFRA_FAILURE_RE.test(blob)
}

export function verifyLobsterRunResult(input: LobsterRunVerifyInput): LobsterRunVerifyOutcome {
  const task = String(input.task || '').trim()
  const status = String(input.status || '').trim().toLowerCase()

  if (
    isLobsterNetworkFailure({
      error: input.error,
      result: input.result,
      text: input.error || undefined,
    })
  ) {
    return {
      ok: false,
      reason: 'network_unreachable',
      failureType: 'network',
      hints: [
        collectResultText(input.result).slice(0, 240) || String(input.error || '').slice(0, 240) || '网络/DNS 不可达',
      ],
    }
  }

  if (isLobsterInfrastructureFailure({ status, error: input.error, result: input.result, text: input.error || undefined })) {
    return {
      ok: false,
      reason: 'browser_infra_unavailable',
      hints: [collectResultText(input.result).slice(0, 240) || String(input.error || '').slice(0, 240)],
    }
  }

  if (status === 'canceled') {
    return {
      ok: false,
      reason: 'canceled',
      hints: input.error ? [String(input.error).slice(0, 200)] : undefined,
    }
  }

  // error 但已 salvage 出可用浏览证据：按 done 语义继续校验（打开/导航类可 pass）
  if (status === 'error') {
    if (hasMeaningfulTaskOutput(task, input.result)) {
      // fall through as if done
    } else {
      const rowEarly = resultPayload(input.result)
      const finalUrlEarly = String(rowEarly.finalUrl || rowEarly.url || '').trim()
      const itemsEarly = collectResultItems(input.result)
      if (
        !isFormFillBrowseTask(task, input.result) &&
        /(打开|点击|进入|first|第一条)/i.test(task) &&
        !isOpenOnlyBrowseTask(task) &&
        isLikelyStartPageOnly(task, finalUrlEarly) &&
        itemsEarly.length === 0
      ) {
        return {
          ok: false,
          reason: 'navigation_unverified',
          hints: [finalUrlEarly ? `仍停留在起始页：${finalUrlEarly}` : '导航未完成'],
        }
      }
      return {
        ok: false,
        reason: 'error',
        hints: input.error ? [String(input.error).slice(0, 200)] : undefined,
      }
    }
  } else if (status !== 'done') {
    return { ok: false, reason: `incomplete_${status || 'unknown'}` }
  }

  const semanticBlock = detectLobsterSemanticBlock({
    task,
    result: input.result,
    text: input.error || undefined,
  })
  if (semanticBlock) {
    return {
      ok: false,
      reason: semanticBlock.reason,
      failureType: semanticBlock.failureType,
      hints: [collectResultText(input.result).slice(0, 240) || String(input.error || '').slice(0, 240)],
    }
  }

  const row = resultPayload(input.result)
  const answer = String(row.answer || row.summary || '').trim()
  const data = Array.isArray(row.data) ? row.data : []
  const items = data.flatMap((chunk) => {
    if (!chunk || typeof chunk !== 'object') return []
    const items = (chunk as Record<string, unknown>).items
    return Array.isArray(items) ? items : []
  })
  const finalUrl = String(row.finalUrl || row.url || '').trim()
  const failureType = String(row.failureType || '').trim().toLowerCase()
  const blob = [answer, collectResultText(input.result), finalUrl].filter(Boolean).join('\n')

  // 龙虾显式标记与总管对齐：未离开起始页 / 未验证导航
  // form_fill 同页完成：即使上游误标 navigation_unverified，有 filled 证据则放行；无证据则改 success_criteria_unmet
  if (failureType === 'navigation_unverified') {
    if (isFormFillBrowseTask(task, input.result)) {
      const filled = collectFormFilledEvidence(input.result)
      if (filled.length > 0) {
        // fall through — 填表成功证据优先
      } else {
        return {
          ok: false,
          reason: 'success_criteria_unmet',
          failureType: 'success_criteria_unmet',
          hints: [finalUrl ? `填表未完成（仍在表单页）：${finalUrl}` : '填表字段未校验成功'],
        }
      }
    } else {
      return {
        ok: false,
        reason: 'navigation_unverified',
        failureType: 'navigation_unverified',
        hints: [finalUrl ? `仍停留在起始页：${finalUrl}` : '导航未完成'],
      }
    }
  }

  if (failureType.startsWith('incomplete') || isIncompleteRunAnswer(blob)) {
    // 要求点击/进入但仍停在起始页：优先 navigation_unverified（比笼统 incomplete 可操作）
    if (
      !isFormFillBrowseTask(task, input.result) &&
      /(打开|点击|进入|first|第一条)/i.test(task) &&
      !isOpenOnlyBrowseTask(task) &&
      isLikelyStartPageOnly(task, finalUrl) &&
      items.length === 0
    ) {
      return {
        ok: false,
        reason: 'navigation_unverified',
        hints: [finalUrl ? `仍停留在起始页：${finalUrl}` : '导航未完成'],
      }
    }
    if (isFormFillBrowseTask(task, input.result) && collectFormFilledEvidence(input.result).length === 0) {
      return {
        ok: false,
        reason: 'success_criteria_unmet',
        failureType: 'success_criteria_unmet',
        hints: [answer.slice(0, 240) || '填表未完成'],
      }
    }
    return {
      ok: false,
      reason: failureType.startsWith('incomplete') ? failureType : 'incomplete_max_steps',
      hints: [answer.slice(0, 240) || blob.slice(0, 240)],
    }
  }

  const hasContent = Boolean(answer.length > 6 || items.length > 0 || finalUrl)

  if (!hasContent) {
    return { ok: false, reason: 'empty_result', hints: ['run done 但无 answer/data/finalUrl'] }
  }

  if (/(搜索|search|查找|\bquery\b)/i.test(task)) {
    const onResults = isSearchResultsPage(finalUrl)
    const wantsExtract = /(抽取|提取|获取|输出|列表|结果|items|前\s*\d+\s*条|top\s*\d+)/i.test(task)
    if (!onResults && items.length === 0 && isLikelySearchNotStarted(task, finalUrl)) {
      return {
        ok: false,
        reason: 'search_no_results',
        hints: [finalUrl ? `仍停留在起始页：${finalUrl}` : '未进入搜索结果页'],
      }
    }
    // 已打开第一条详情（非 SERP）：勿再按「结果页抽取空」失败
    const openedDetail =
      /(打开|点击|进入|first|第一条|告诉我标题|链接)/i.test(task) &&
      Boolean(finalUrl) &&
      !onResults &&
      !isLikelyStartPageOnly(task, finalUrl) &&
      !CAPTCHA_URL_RE.test(finalUrl)
    if (wantsExtract && items.length === 0 && answer.length < 12 && !openedDetail) {
      return {
        ok: false,
        reason: 'search_extract_empty',
        hints: [finalUrl ? `搜索结果页缺少可合成内容：${finalUrl}` : '搜索抽取无 answer/items'],
      }
    }
    if (openedDetail && answer.length < 12) {
      // 详情已开但 answer 空：交由 ensureLobsterGuiFinalPayload 补全后应再验；此处先放行 title/url 形态
      return { ok: true, reason: 'ok' }
    }
    if (!onResults && items.length === 0 && !answer && !openedDetail) {
      return { ok: false, reason: 'search_no_results' }
    }
  }
  if (/(打开|点击|进入|first|第一条)/i.test(task)) {
    // form_fill：「First name」含 first，不得误判须离页
    if (isFormFillBrowseTask(task, input.result)) {
      const filled = collectFormFilledEvidence(input.result)
      if (filled.length === 0 && !/已填\s+\S+=/.test(answer)) {
        return {
          ok: false,
          reason: 'success_criteria_unmet',
          failureType: 'success_criteria_unmet',
          hints: [finalUrl ? `填表未完成：${finalUrl}` : '未校验到已填字段'],
        }
      }
    } else if (!isOpenOnlyBrowseTask(task) && isLikelyStartPageOnly(task, finalUrl) && items.length === 0) {
      return {
        ok: false,
        reason: 'navigation_unverified',
        hints: [finalUrl ? `仍停留在起始页：${finalUrl}` : '导航未完成'],
      }
    }
    if (!isFormFillBrowseTask(task, input.result) && !finalUrl && items.length === 0 && !answer) {
      return { ok: false, reason: 'navigation_unverified' }
    }
  }

  const desktopVerify = verifyDesktopAppOutput(task, input.result)
  if (desktopVerify) return desktopVerify

  if (!hasMeaningfulTaskOutput(task, input.result)) {
    return {
      ok: false,
      reason: 'incomplete_task_output',
      hints: [answer.slice(0, 240) || finalUrl || '任务目标未达成'],
    }
  }

  return { ok: true, reason: 'ok' }
}
