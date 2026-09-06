/**
 * Playwright 确定性桥：Stagehand 负责浏览器生命周期，点击/抽标题走 Playwright。
 * 比 Stagehand act（依赖模型 JSON）更稳——开源 browser-use / Playwright 短环同思路。
 */
import type { LobsterPlanStep } from './lobsterTaskUnderstandSchema'

function getPage(stagehand: any): any | null {
  try {
    const page = stagehand?.page || stagehand?.context?.pages?.()?.[0] || null
    if (!page) return null
    // Stagehand 包装页可能无 getByRole，但有 locator / $
    if (typeof page.locator === 'function' || typeof page.getByRole === 'function' || typeof page.goto === 'function') {
      return page
    }
    return null
  } catch {
    return null
  }
}

/** 供 router / gui-plus 同会话急救复用 */
export function getStagehandPage(stagehand: any): any | null {
  return getPage(stagehand)
}

async function linkLooksVisible(link: any): Promise<boolean> {
  try {
    if (typeof link.isVisible === 'function') return Boolean(await link.isVisible())
  } catch {
    /* ignore */
  }
  return true
}

/** header/nav 噪音降权（DOM 结构，非用户意图 regex） */
async function linkInChromeNav(link: any): Promise<boolean> {
  try {
    return Boolean(
      await link.evaluate((el: Element) => {
        return Boolean(el.closest('nav, header, [role="navigation"], .navbar, #nav, .top-nav, .menu-bar'))
      }),
    )
  } catch {
    return false
  }
}

/**
 * 关键帧截图（JPEG）供总管进度条 / HITL；体积远小于 PNG，避免撑爆 WS。
 */
export async function captureStagehandScreenshot(
  stagehand: any,
): Promise<{ dataUrl: string; pageUrl: string } | null> {
  const page = getPage(stagehand)
  if (!page || typeof page.screenshot !== 'function') return null
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })
    if (!buf || !Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null
    const b64 = Buffer.from(buf).toString('base64')
    if (!b64) return null
    let pageUrl = ''
    try {
      pageUrl = String(page.url?.() || '').trim()
    } catch {
      pageUrl = ''
    }
    return { dataUrl: `data:image/jpeg;base64,${b64}`, pageUrl }
  } catch {
    return null
  }
}

function linkLocator(page: any) {
  if (typeof page.getByRole === 'function') return page.getByRole('link')
  return page.locator('a[href]')
}

const NAV_SKIP_RE =
  /首页|登录|注册|下载|关于我们|会员|VIP|购物车|客服|App|客户端|微信|微博|工具箱|菜鸟工具|笔记|手册(?!教程)/i

function hrefLooksNavigable(href: string, startUrl: string): boolean {
  const h = String(href || '').trim()
  if (!h || h === '#' || /^javascript:/i.test(h) || /^mailto:/i.test(h)) return false
  try {
    const base = startUrl || 'https://example.com/'
    const abs = new URL(h, base)
    if (!/^https?:$/i.test(abs.protocol)) return false
    return true
  } catch {
    return false
  }
}

/** 从 plan target / 任务中提取可用于文本匹配的短语（非站点关键词表） */
function hintTokens(hint: string): string[] {
  const raw = String(hint || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[，。；：！？、,.!?;:()[\]{}「」『』【】]/g, ' ')
  const parts = raw
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && p.length <= 24)
  // 中文连续 2～6 字片断（从较长短语再切）
  const cjkChunks: string[] = []
  for (const p of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(p) && p.length >= 4) {
      for (let i = 0; i <= p.length - 2 && i < 8; i++) {
        cjkChunks.push(p.slice(i, Math.min(i + 4, p.length)))
      }
    }
  }
  const out = [...parts, ...cjkChunks]
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const t of out) {
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(t)
    if (uniq.length >= 24) break
  }
  return uniq
}

function scoreLinkAgainstHints(text: string, href: string, tokens: string[]): number {
  if (!tokens.length) return 0
  const blob = `${text} ${href}`.toLowerCase()
  let bonus = 0
  for (const t of tokens) {
    if (blob.includes(t.toLowerCase())) bonus += Math.min(6, 2 + Math.floor(t.length / 2))
  }
  return bonus
}

export type PlaywrightClickOpts = {
  task?: string
  target?: string
  startUrl?: string
  /** 扩大扫描上限（重试时） */
  scanLimit?: number
}

/** 按计划目标/任务，点第一个像「内容入口」的链接（优先可见 + 非 nav chrome） */
export async function playwrightClickContentLink(
  stagehand: any,
  input: PlaywrightClickOpts,
): Promise<{ ok: boolean; url?: string; text?: string; reason?: string }> {
  const page = getPage(stagehand)
  if (!page) return { ok: false, reason: 'no_page' }

  const startUrl = String(input.startUrl || (typeof page.url === 'function' ? page.url() : page.url) || '')
  const hint = `${input.target || ''} ${input.task || ''}`.slice(0, 280)
  const tokens = hintTokens(hint)
  const preferTutorial = /教程|学习|入门|第一个|第一条|链接|文档|手册/.test(hint)
  const scanLimit = Math.min(Math.max(Number(input.scanLimit) || 72, 24), 160)

  const links = linkLocator(page)
  const n = Math.min(Math.max(0, await links.count()), scanLimit)
  if (n === 0) return { ok: false, reason: 'no_links' }

  type Cand = { i: number; text: string; href: string; score: number }
  const cands: Cand[] = []
  for (let i = 0; i < n; i++) {
    const link = links.nth(i)
    let text = ''
    let href = ''
    try {
      href = String((await link.getAttribute('href')) || '').trim()
      text = String(
        (await link.innerText().catch(() => '')) ||
          (await link.textContent().catch(() => '')) ||
          (await link.getAttribute('aria-label').catch(() => '')) ||
          '',
      )
        .replace(/\s+/g, ' ')
        .trim()
    } catch {
      continue
    }
    if (!hrefLooksNavigable(href, startUrl)) continue
    if (text && NAV_SKIP_RE.test(text)) continue
    if (text.length > 120) continue

    const visible = await linkLooksVisible(link)
    if (!visible) continue
    const inNav = await linkInChromeNav(link)

    let score = 1
    if (!text) score -= 1
    if (inNav) score -= 6
    else score += 3
    score += scoreLinkAgainstHints(text, href, tokens)
    // 轻量内容启发（DOM 打分，非意图路由）
    if (preferTutorial && /学习|教程|入门|Python|Java|HTML|CSS|JS|前端|后端/.test(text)) score += 3
    if (/【学习/.test(text)) score += 2
    try {
      const abs = new URL(href, startUrl || 'https://example.com/')
      const startPath = (() => {
        try {
          return new URL(startUrl).pathname.replace(/\/$/, '') || '/'
        } catch {
          return '/'
        }
      })()
      const p = abs.pathname.replace(/\/$/, '') || '/'
      if (p !== startPath && p.length >= 2) score += 3
      if (/\.(htm|html)(\?|$)/i.test(p)) score += 2
    } catch {
      /* ignore */
    }
    if (score < 1) continue
    cands.push({ i, text: text || href, href, score })
  }

  // 若评分全被滤掉：退化为第一个可见、离开首页的链接
  if (!cands.length) {
    for (let i = 0; i < n; i++) {
      const link = links.nth(i)
      let href = ''
      try {
        href = String((await link.getAttribute('href')) || '').trim()
      } catch {
        continue
      }
      if (!hrefLooksNavigable(href, startUrl)) continue
      if (!(await linkLooksVisible(link))) continue
      if (await linkInChromeNav(link)) continue
      try {
        const abs = new URL(href, startUrl || 'https://example.com/')
        const start = new URL(startUrl || abs.href)
        const sameHome =
          abs.hostname.replace(/^www\./, '') === start.hostname.replace(/^www\./, '') &&
          (abs.pathname.replace(/\/$/, '') || '/') === (start.pathname.replace(/\/$/, '') || '/')
        if (sameHome) continue
        cands.push({ i, text: href, href, score: 1 })
        break
      } catch {
        continue
      }
    }
  }

  cands.sort((a, b) => b.score - a.score)
  const top = cands[0]
  if (!top) return { ok: false, reason: 'no_content_link' }

  try {
    const target = links.nth(top.i)
    await target.scrollIntoViewIfNeeded?.().catch(() => {})
    await target.click({ timeout: 10000 })
    try {
      await page.waitForLoadState?.('domcontentloaded', { timeout: 15000 })
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 400))
    const url =
      typeof page.url === 'function' ? String(page.url() || '') : String(page.url || '')
    return { ok: true, url, text: top.text }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 160) }
  }
}

export async function playwrightFillAndSubmit(
  stagehand: any,
  step: LobsterPlanStep,
): Promise<{ ok: boolean; reason?: string }> {
  const page = getPage(stagehand)
  if (!page) return { ok: false, reason: 'no_page' }
  const target = String(step.target || '').trim()
  if (step.op === 'type' && target) {
    // 禁止把「按任务填写…」类说明当 fill 文本盲填首个 input
    if (isInstructionalFillTarget(target)) {
      return { ok: false, reason: 'instructional_target' }
    }
    try {
      const box = page.locator('input:visible, textarea:visible').first()
      await box.fill(target.slice(0, 200), { timeout: 8000 })
      return { ok: true }
    } catch (e: any) {
      return { ok: false, reason: String(e?.message || e).slice(0, 120) }
    }
  }
  if (step.op === 'submit') {
    try {
      await page.locator('button[type=submit], input[type=submit], button:visible').first().click({ timeout: 8000 })
      return { ok: true }
    } catch (e: any) {
      return { ok: false, reason: String(e?.message || e).slice(0, 120) }
    }
  }
  return { ok: false, reason: 'unsupported_op' }
}

/** plan target 是操作说明而非字段字面值时，不得 Playwright 盲填 */
export function isInstructionalFillTarget(target: string): boolean {
  const t = String(target || '').trim()
  if (!t) return true
  if (t.length > 64) return true
  if (
    /按任务|填写表单|表单字段|可见输入|输入框|搜索框|填入用户|根据任务|完成填写|用户任务|步骤说明|禁止把|关键词并搜索/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * 搜索框输入并提交（role=searchbox / 常见 name=wd|q|query）。
 * 供 task_kind=search；禁止把「在搜索框输入…」说明当字面值盲填。
 */
export async function playwrightPerformSearch(
  stagehand: any,
  input: { query: string },
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  const page = getPage(stagehand)
  if (!page) return { ok: false, reason: 'no_page' }
  const q = String(input.query || '').trim()
  if (!q) return { ok: false, reason: 'empty_query' }

  const startUrl =
    typeof page.url === 'function' ? String(page.url() || '') : String(page.url || '')

  const tryFill = async (loc: any): Promise<boolean> => {
    try {
      await loc.click({ timeout: 4000 }).catch(() => {})
      await loc.fill(q, { timeout: 8000 })
      const got = String((await loc.inputValue?.().catch(() => '')) || '').trim()
      return !got || got.includes(q.slice(0, Math.min(8, q.length)))
    } catch {
      return false
    }
  }

  let filled = false
  if (typeof page.getByRole === 'function') {
    filled = await tryFill(page.getByRole('searchbox').first())
    if (!filled) filled = await tryFill(page.getByRole('textbox', { name: /搜索|search/i }).first())
  }
  if (!filled) {
    const sels = [
      'input[name="wd"]',
      'input#kw',
      'input[name="q"]',
      'input[name="query"]',
      'input[type="search"]',
      'textarea[name="wd"]',
    ]
    for (const sel of sels) {
      filled = await tryFill(page.locator(sel).first())
      if (filled) break
    }
  }
  if (!filled) return { ok: false, reason: 'searchbox_not_found' }

  try {
    await page.keyboard.press('Enter')
  } catch {
    try {
      await page.locator('button[type=submit], input[type=submit], #su, button:has-text("搜索")').first().click({
        timeout: 5000,
      })
    } catch (e: any) {
      return { ok: false, reason: String(e?.message || e).slice(0, 120) }
    }
  }
  try {
    await page.waitForLoadState?.('domcontentloaded', { timeout: 15000 })
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 500))
  const url = typeof page.url === 'function' ? String(page.url() || '') : String(page.url || '')
  const leftHome = startUrl && url && !sameHomeUrl(url, startUrl)
  const looksResults = /[?&](wd|q|query|keyword)=/i.test(url) || /\/s(\?|$)/i.test(url)
  if (!leftHome && !looksResults) return { ok: false, reason: 'search_no_navigation', url }
  return { ok: true, url }
}

async function readLocatorValue(loc: any): Promise<string> {
  try {
    if (typeof loc.inputValue === 'function') {
      return String((await loc.inputValue()) || '').trim()
    }
  } catch {
    /* fall through */
  }
  try {
    return String((await loc.getAttribute?.('value')) || '').trim()
  } catch {
    return ''
  }
}

async function tryFillLocator(
  loc: any,
  value: string,
  opts?: { password?: boolean },
): Promise<'ok' | 'value_mismatch' | 'fail'> {
  try {
    await loc.fill(value.slice(0, 200), { timeout: 8000 })
    // 部分站点 password 控件 inputValue 为空或不可读；fill 未抛错即视为写入成功
    if (opts?.password) {
      try {
        const got = await readLocatorValue(loc)
        if (!got || got === value.slice(0, 200)) return 'ok'
        return 'value_mismatch'
      } catch {
        return 'ok'
      }
    }
    const got = await readLocatorValue(loc)
    if (got === value.slice(0, 200)) return 'ok'
    return 'value_mismatch'
  } catch {
    return 'fail'
  }
}

function isPasswordFieldKey(key: string): boolean {
  return /pass(word)?|pwd|passwd|密码/i.test(String(key || ''))
}

function labelCandidatesForField(field: {
  key: string
  recipe?: { key: string; aliases?: string[] }
}): string[] {
  const key = String(field.key || '').trim()
  const names = new Set<string>()
  if (key) names.add(key)
  const recipeKey = String(field.recipe?.key || '').trim()
  if (recipeKey) names.add(recipeKey)
  for (const a of field.recipe?.aliases || []) {
    const s = String(a || '').trim()
    if (s) names.add(s)
  }
  // 常见英文字段展示名
  if (/first_?name|fname/i.test(key)) {
    names.add('First name')
    names.add('名')
  }
  if (/last_?name|lname/i.test(key)) {
    names.add('Last name')
    names.add('姓')
  }
  if (/customer_?name|custname/i.test(key)) {
    names.add('Customer name')
    names.add('客户名')
  }
  if (/user(name)?|login|account|账号|用户名/i.test(key)) {
    names.add('Username')
    names.add('User name')
    names.add('用户名')
    names.add('账号')
  }
  if (/e-?mail|邮箱/i.test(key)) {
    names.add('Email')
    names.add('E-mail')
    names.add('邮箱')
  }
  if (isPasswordFieldKey(key)) {
    names.add('Password')
    names.add('密码')
  }
  return [...names]
}

/** 按站点 recipe + 抽取字段值确定性填写（不依赖 Stagehand act JSON schema） */
export async function playwrightFillFormFields(
  stagehand: any,
  input: {
    fields: Array<{ key: string; value: string }>
    recipeFields: Array<{ key: string; selectors: string[]; aliases?: string[] }>
  },
): Promise<{ ok: boolean; filled: Array<{ key: string; value: string }>; reason?: string }> {
  const page = getPage(stagehand)
  if (!page) return { ok: false, filled: [], reason: 'no_page' }
  const filled: Array<{ key: string; value: string }> = []
  if (!input.fields.length) return { ok: false, filled, reason: 'no_fields' }

  for (const field of input.fields) {
    const key = String(field.key || '').trim().toLowerCase()
    const value = String(field.value || '').trim()
    if (!key || !value) continue
    const recipe =
      input.recipeFields.find((r) => r.key.toLowerCase() === key) ||
      input.recipeFields.find((r) =>
        (r.aliases || []).some((a) => String(a).toLowerCase() === key),
      )
    const outKey = recipe?.key || field.key
    const asPassword = isPasswordFieldKey(key) || isPasswordFieldKey(outKey)
    const fillOpts = asPassword ? { password: true } : undefined
    const selectors = [
      ...(recipe?.selectors || []),
      `input[name="${key}"]`,
      `input#${key}`,
      `textarea[name="${key}"]`,
      `input[name="${outKey}"]`,
      `input#${outKey}`,
      ...(asPassword
        ? ['input[type="password"]', 'input[autocomplete="current-password"]', 'input[autocomplete="new-password"]']
        : []),
      ...(/user(name)?|login|account/i.test(key)
        ? [
            'input[autocomplete="username"]',
            'input[name="username"]',
            'input#username',
            'input[name="user"]',
            'input[type="text"]',
          ]
        : []),
      ...(/e-?mail/i.test(key)
        ? ['input[type="email"]', 'input[autocomplete="email"]', 'input[name="email"]']
        : []),
    ].filter(Boolean)

    let wrote = false
    let lastMismatch = false

    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first()
        const status = await tryFillLocator(loc, value, fillOpts)
        if (status === 'ok') {
          filled.push({ key: outKey, value })
          wrote = true
          break
        }
        if (status === 'value_mismatch') lastMismatch = true
      } catch {
        /* try next */
      }
    }

    if (!wrote) {
      const labels = labelCandidatesForField({ key: field.key, recipe })
      for (const label of labels) {
        if (typeof page.getByLabel === 'function') {
          const status = await tryFillLocator(
            page.getByLabel(label, { exact: false }).first(),
            value,
            fillOpts,
          )
          if (status === 'ok') {
            filled.push({ key: outKey, value })
            wrote = true
            break
          }
          if (status === 'value_mismatch') lastMismatch = true
        }
        if (typeof page.getByRole === 'function') {
          if (asPassword) {
            // Playwright 无 password role；优先 textbox + name，再退回 type=password 已在 selectors
            const status = await tryFillLocator(
              page.getByRole('textbox', { name: label }).first(),
              value,
              fillOpts,
            )
            if (status === 'ok') {
              filled.push({ key: outKey, value })
              wrote = true
              break
            }
            if (status === 'value_mismatch') lastMismatch = true
          } else {
            const status = await tryFillLocator(
              page.getByRole('textbox', { name: label }).first(),
              value,
              fillOpts,
            )
            if (status === 'ok') {
              filled.push({ key: outKey, value })
              wrote = true
              break
            }
            if (status === 'value_mismatch') lastMismatch = true
          }
        }
        if (typeof page.getByPlaceholder === 'function') {
          const status = await tryFillLocator(
            page.getByPlaceholder(label, { exact: false }).first(),
            value,
            fillOpts,
          )
          if (status === 'ok') {
            filled.push({ key: outKey, value })
            wrote = true
            break
          }
          if (status === 'value_mismatch') lastMismatch = true
        }
      }
    }

    if (!wrote && typeof page.getByPlaceholder === 'function') {
      for (const ph of [key, outKey, field.key]) {
        const p = String(ph || '').trim()
        if (!p) continue
        const status = await tryFillLocator(
          page.getByPlaceholder(p, { exact: false }).first(),
          value,
          fillOpts,
        )
        if (status === 'ok') {
          filled.push({ key: outKey, value })
          wrote = true
          break
        }
        if (status === 'value_mismatch') lastMismatch = true
      }
    }

    if (!wrote) {
      return {
        ok: false,
        filled,
        reason: lastMismatch
          ? `value_mismatch:${outKey}`
          : `element_not_found:${outKey}`,
      }
    }
  }
  return { ok: filled.length > 0, filled, reason: filled.length ? undefined : 'nothing_filled' }
}

/**
 * form_fill 失败 → 结构化缺参/缺元素说明（给用户短追问，禁止空成功）。
 * 纯函数，可 smoke。
 */
export function buildFormFillClarifyMessage(input: {
  reason?: string
  requestedKeys?: string[]
  filledKeys?: string[]
  pageUrl?: string
}): string {
  const reason = String(input.reason || '').trim()
  const requested = (input.requestedKeys || []).map((k) => String(k || '').trim()).filter(Boolean)
  const filled = new Set((input.filledKeys || []).map((k) => String(k || '').trim()).filter(Boolean))
  const missing = requested.filter((k) => !filled.has(k))
  const url = String(input.pageUrl || '').trim()

  if (!requested.length && /no_fields/i.test(reason)) {
    return [
      '浏览器填表未完成：任务里没有可映射的字段值。',
      '请补充要填的字段（例如：First name=张三，Last name=李四）。',
      url ? `当前页：${url}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const fieldHint =
    missing.length > 0
      ? `未写入字段：${missing.join('、')}。请确认字段名与取值，或换公开测试页（httpbin / w3school 表单）。`
      : reason
        ? `原因：${reason}`
        : '未能写入任何字段。'

  const code = /element_not_found/i.test(reason)
    ? 'element_not_found'
    : /no_fields|nothing_filled/i.test(reason)
      ? 'success_criteria_unmet'
      : 'success_criteria_unmet'

  return [
    `浏览器填表未完成（${code}）。`,
    fieldHint,
    url ? `当前页：${url}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 确定性抽取：title + h1 + url（不依赖 Stagehand LLM JSON） */
export async function playwrightExtractBasics(stagehand: any): Promise<{
  title: string
  url: string
  summary: string
}> {
  const page = getPage(stagehand)
  if (!page) return { title: '', url: '', summary: '' }
  let url = ''
  let title = ''
  let h1 = ''
  try {
    url = typeof page.url === 'function' ? String(page.url() || '') : String(page.url || '')
  } catch {
    /* ignore */
  }
  try {
    title = String((await page.title?.()) || '').trim()
  } catch {
    /* ignore */
  }
  try {
    const el = page.locator('h1').first()
    h1 = String((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
  } catch {
    /* ignore */
  }
  const best = h1 || title
  const summary = best && url ? `标题：${best}\n链接：${url}` : best || url
  return { title: best, url, summary }
}

function sameHomeUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return (
      ua.hostname.replace(/^www\./, '') === ub.hostname.replace(/^www\./, '') &&
      (ua.pathname.replace(/\/$/, '') || '/') === (ub.pathname.replace(/\/$/, '') || '/')
    )
  } catch {
    return false
  }
}

/** 是否仍停在起始页（供 mustLeave fail-closed） */
export function isStillOnStartUrl(currentUrl: string, startUrl: string): boolean {
  if (!currentUrl || !startUrl) return false
  return sameHomeUrl(currentUrl, startUrl)
}
