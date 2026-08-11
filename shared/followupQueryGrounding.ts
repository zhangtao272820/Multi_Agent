/**
 * 短承接 / output_followup 检索问句锚定（跨 Manager / DB / RAG）。
 * 原则：有上轮任务锚点时，lean/coalesced/queryFocus 必须落在锚点主题上，禁止 LLM 另起新主题。
 * 不做关键词改路由 / 改 cap。
 */

export type FollowupTurnKind =
  | 'new_task'
  | 'continuation'
  | 'output_followup'
  | 'slot_answer'
  | 'chitchat'
  | string
  | null
  | undefined

const DETAIL_EXPAND_SUFFIX = '（请在同一主题上更详细展开，勿改换主题）'

/** 末轮是否短到需要锚点承接（非词表改 cap，仅长度启发） */
export function isShortFollowupUtterance(lastUser: string, maxChars = 24): boolean {
  const t = String(lastUser || '').trim()
  if (!t) return false
  return t.replace(/\s+/g, '').length <= maxChars
}

export function shouldGroundFollowupQuery(input: {
  turnKind?: FollowupTurnKind
  lastUser?: string
  anchorTask?: string | null
}): boolean {
  const anchor = String(input.anchorTask || '').trim()
  if (!anchor) return false
  const kind = String(input.turnKind || '').trim()
  if (kind === 'output_followup') return true
  if (kind === 'continuation' && isShortFollowupUtterance(String(input.lastUser || ''))) return true
  return false
}

/** 中文/英文内容 bigram，用于主题覆盖（比单字符重叠更稳） */
export function followupContentBigrams(text: string): string[] {
  const s = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[（）()【】\[\]，,。．.、；;：:！!？?·…—\-_]/g, '')
    .slice(0, 160)
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2)
    if (seen.has(bg)) continue
    seen.add(bg)
    out.push(bg)
  }
  return out
}

/**
 * 锚点 bigram 被候选覆盖的比例。
 * 仅共享文档名前缀、丢掉任务核心词时，覆盖率会明显下降。
 */
export function followupTopicOverlapRatio(candidate: string, anchor: string): number {
  const a = String(anchor || '').replace(/\s+/g, '')
  const c = String(candidate || '').replace(/\s+/g, '')
  if (!a || !c) return 0
  if (c.includes(a) || a.includes(c)) return 1
  const aToks = followupContentBigrams(a)
  if (!aToks.length) return 0
  let hit = 0
  for (const t of aToks) {
    if (c.includes(t)) hit += 1
  }
  return hit / aToks.length
}

/** 候选相对锚点的新 bigram 占比（另起主题时常升高） */
export function followupNovelBigramRatio(candidate: string, anchor: string): number {
  const a = String(anchor || '').replace(/\s+/g, '')
  const cToks = followupContentBigrams(candidate)
  if (!cToks.length) return 0
  let novel = 0
  for (const t of cToks) {
    if (!a.includes(t)) novel += 1
  }
  return novel / cToks.length
}

/** 候选相对锚点是否跑题（无锚点时不算跑题） */
export function isFollowupQueryUngrounded(
  candidate: string,
  anchorTask: string | null | undefined,
  minOverlap = 0.42
): boolean {
  const anchor = String(anchorTask || '').trim()
  const cand = String(candidate || '').trim()
  if (!anchor) return false
  if (!cand) return true
  if (cand === anchor) return false
  // 短承接原话本身不算有效检索主题
  if (isShortFollowupUtterance(cand) && !cand.includes(anchor.slice(0, Math.min(8, anchor.length)))) {
    return true
  }
  const coverage = followupTopicOverlapRatio(cand, anchor)
  if (coverage < minOverlap) return true
  // 覆盖尚可但大量新主题词（如共享「服务规范」却改成远程护理）→ 仍视为跑题
  const novel = followupNovelBigramRatio(cand, anchor)
  if (novel >= 0.45 && coverage < 0.72) return true
  return false
}

/**
 * 解析本轮应用于检索/编排的 grounded 问句。
 * - 需要锚定且有锚点 → 锚点（可选 detail 修饰）
 * - 候选已相对锚点不跑题 → 保留候选
 * - 否则回退锚点
 */
export function groundFollowupQuery(input: {
  lastUser: string
  turnKind?: FollowupTurnKind
  anchorTask?: string | null
  /** 编排/merge 已产出的候选；若跑题则丢弃 */
  candidate?: string | null
  lastAssistantSnippet?: string | null
  expandDetail?: boolean
}): string {
  const lastUser = String(input.lastUser || '').trim()
  const anchor = String(input.anchorTask || '').trim()
  const candidate = String(input.candidate || '').trim()
  const need = shouldGroundFollowupQuery({
    turnKind: input.turnKind,
    lastUser,
    anchorTask: anchor
  })

  if (!need) {
    return candidate || lastUser
  }
  if (!anchor) {
    return candidate || lastUser
  }

  if (candidate && !isFollowupQueryUngrounded(candidate, anchor)) {
    return candidate.slice(0, 900)
  }

  const expand =
    input.expandDetail !== false &&
    (String(input.turnKind || '') === 'output_followup' || isShortFollowupUtterance(lastUser))
  const grounded = expand ? `${anchor}${DETAIL_EXPAND_SUFFIX}` : anchor
  return grounded.slice(0, 900)
}

/** 对任意候选强制拉回锚点（编排后处理） */
export function coerceFollowupTextToAnchor(input: {
  text: string
  anchorTask?: string | null
  turnKind?: FollowupTurnKind
  lastUser?: string
}): string {
  return groundFollowupQuery({
    lastUser: input.lastUser || input.text,
    turnKind: input.turnKind,
    anchorTask: input.anchorTask,
    candidate: input.text,
    expandDetail: true
  })
}
