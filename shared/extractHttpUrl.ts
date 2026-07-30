/**
 * HTTP(S) URL 抽取 SSOT：避免中文任务里全角标点/CJK 粘连污染 startUrl。
 * 例：`打开 https://www.runoob.com/，点击第一个教程` → `https://www.runoob.com/`
 */

const HTTP_URL_LOOSE_RE = /https?:\/\/[^\s)\]"'<>]+/gi

/** 空白、全角标点、常见中文标点、未编码 CJK —— 均不应出现在未编码 URL 字面量中 */
const URL_POLLUTION_RE =
  /[\s\u3000]|[\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\u2014\u2026\u3008-\u3011\uFF08\uFF09\u3014\u3015]|[\u4e00-\u9fff]/

function stripAsciiTrailPunct(s: string): string {
  return String(s || '').replace(/[.,;:!?)\]]+$/g, '')
}

/**
 * 拒绝 LLM 示例占位 host（如 `https://...` → hostname `...`）。
 * `new URL('https://...')` 语法合法但不可解析，会导致 chrome-error。
 */
function isPlausibleHttpHostname(hostname: string): boolean {
  const host = String(hostname || '').trim().toLowerCase()
  if (!host) return false
  // 纯点号 / 纯标点（无字母数字）
  if (/^\.+$/.test(host)) return false
  if (!/[a-z0-9]/i.test(host)) return false
  return true
}

/** 截断污染后缀并用 URL 校验；失败则逐步缩短到可解析前缀 */
export function sanitizeExtractedHttpUrl(raw: string): string | undefined {
  let s = String(raw || '').trim()
  if (!s || !/^https?:\/\//i.test(s)) return undefined

  const cut = s.search(URL_POLLUTION_RE)
  if (cut >= 0) s = s.slice(0, cut)
  s = stripAsciiTrailPunct(s)
  if (!s || !/^https?:\/\//i.test(s)) return undefined

  for (let guard = 0; guard < 24; guard++) {
    try {
      const u = new URL(s)
      if (!/^https?:$/i.test(u.protocol)) return undefined
      if (!isPlausibleHttpHostname(u.hostname)) return undefined
      // 保留用户写法的尾斜杠语义：能 parse 即返回截断后的字面量
      return s
    } catch {
      const next = stripAsciiTrailPunct(s.replace(/[^/]+$/, '').replace(/\/+$/, '') || s.slice(0, -1))
      if (!next || next === s || next.length < 'https://x'.length) return undefined
      s = next
    }
  }
  return undefined
}

/** 从文本抽取第一个合法 http(s) URL */
export function extractFirstHttpUrl(text: string): string | undefined {
  const m = String(text || '').match(HTTP_URL_LOOSE_RE)
  if (!m?.[0]) return undefined
  return sanitizeExtractedHttpUrl(m[0])
}

/** 从文本抽取全部合法 http(s) URL（去重保序） */
export function extractAllHttpUrls(text: string): string[] {
  const matches = String(text || '').match(HTTP_URL_LOOSE_RE) || []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of matches) {
    const u = sanitizeExtractedHttpUrl(raw)
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}
