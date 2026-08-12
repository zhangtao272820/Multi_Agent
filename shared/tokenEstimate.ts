/**
 * Token 估计：优先 js-tiktoken（cl100k_base，Qwen/兼容 OpenAI 近似）；
 * 失败回退启发式并标注 accounting=estimated。
 */

export type TokenEstimateResult = {
  tokens: number
  accounting: 'tiktoken' | 'estimated'
  encoding?: string
}

let _enc: { encode: (s: string) => number[] } | null | undefined

async function tryLoadTiktoken(): Promise<{ encode: (s: string) => number[] } | null> {
  if (_enc !== undefined) return _enc
  try {
    const mod = await import('js-tiktoken')
    const getEncoding = (mod as { getEncoding?: (name: string) => { encode: (s: string) => number[] } }).getEncoding
    if (typeof getEncoding !== 'function') {
      _enc = null
      return null
    }
    _enc = getEncoding('cl100k_base')
    return _enc
  } catch {
    _enc = null
    return null
  }
}

/** CJK 偏多时 ≈ 字数；ASCII 偏多时 ≈ chars/4 */
export function estimateTokensHeuristic(text: string): number {
  const s = String(text ?? '')
  if (!s) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.max(1, cjk + Math.ceil(other / 4))
}

export async function estimateTokensAsync(text: string): Promise<TokenEstimateResult> {
  const s = String(text ?? '')
  if (!s) return { tokens: 0, accounting: 'estimated' }
  const enc = await tryLoadTiktoken()
  if (enc) {
    try {
      const n = enc.encode(s).length
      return { tokens: Math.max(1, n), accounting: 'tiktoken', encoding: 'cl100k_base' }
    } catch {
      /* fall through */
    }
  }
  return { tokens: estimateTokensHeuristic(s), accounting: 'estimated' }
}

export function estimateTokensSync(text: string): TokenEstimateResult {
  const s = String(text ?? '')
  if (!s) return { tokens: 0, accounting: 'estimated' }
  // sync 路径不阻塞加载；若已缓存 encoder 则用
  if (_enc) {
    try {
      return { tokens: Math.max(1, _enc.encode(s).length), accounting: 'tiktoken', encoding: 'cl100k_base' }
    } catch {
      /* fall through */
    }
  }
  return { tokens: estimateTokensHeuristic(s), accounting: 'estimated' }
}

/** 按 token 预算裁剪字符串（从尾部截断） */
export function clipToTokenBudget(text: string, maxTokens: number): { text: string; tokens: number; accounting: TokenEstimateResult['accounting'] } {
  const max = Math.max(0, Math.floor(maxTokens))
  if (max <= 0) return { text: '', tokens: 0, accounting: 'estimated' }
  const full = estimateTokensSync(text)
  if (full.tokens <= max) return { text: String(text || ''), tokens: full.tokens, accounting: full.accounting }
  // 二分字符长度逼近 token 预算
  let lo = 0
  let hi = String(text || '').length
  let best = ''
  let bestTok = 0
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const slice = String(text || '').slice(0, mid)
    const est = estimateTokensSync(slice)
    if (est.tokens <= max) {
      best = slice
      bestTok = est.tokens
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const out = best ? `${best.replace(/…$/, '')}…` : ''
  const final = estimateTokensSync(out)
  return { text: out, tokens: final.tokens, accounting: final.accounting }
}

/** 预热 tiktoken（可选） */
export async function warmTokenEncoder(): Promise<boolean> {
  const enc = await tryLoadTiktoken()
  return Boolean(enc)
}
