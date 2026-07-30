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

/** 按计划目标/任务，点第一个像「内容入口」的链接（非导航栏噪音） */
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

    let score = 1
    if (!text) score -= 1
    score += scoreLinkAgainstHints(text, href, tokens)
    if (preferTutorial && /学习|教程|入门|Python|Java|HTML|CSS|JS|前端|后端/.test(text)) score += 5
    if (/【学习/.test(text)) score += 4
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
      if (p !== startPath && p.length >= 2) score += 2
      if (/\.(htm|html)(\?|$)/i.test(p)) score += 2
      if (/\/(python|java|html|css|js|jquery|bootstrap|sql|csharp|cplusplus|php|vue|react|nodejs)/i.test(p))
        score += 4
    } catch {
      /* ignore */
    }
    if (score < 1) continue
    cands.push({ i, text: text || href, href, score })
  }

  // 若评分全被滤掉：退化为点第一个离开首页的 html 链接
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
    await links.nth(top.i).click({ timeout: 10000 })
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
