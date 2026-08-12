/**
 * Wave7：生产契约禁写的评测 fixture 专名（eval/doc/smoke 文本可出现）。
 * 勿把本列表当路由关键词表——仅用于源码/组装 prompt 泄漏门禁。
 */
export const DOMAIN_BLEED_DENY_LIST: readonly string[] = [
  '王建国',
  '林雨欣',
  '龙奶奶',
  '养老机构服务规范',
  '个人月收入',
  '足底压力',
  '护理员配比',
  '半失能',
  'p2026',
  '天津西站',
  '天津站',
  'remote_activity_foot_log',
  'person_info'
] as const

export type DomainBleedHit = { term: string; where: string }

/** 在任意文本中找泄漏；返回命中列表（可空） */
export function findDomainBleedInText(text: string, where: string): DomainBleedHit[] {
  const src = String(text || '')
  const hits: DomainBleedHit[] = []
  for (const term of DOMAIN_BLEED_DENY_LIST) {
    if (term && src.includes(term)) hits.push({ term, where })
  }
  return hits
}

export function assertNoDomainBleed(text: string, where: string): void {
  const hits = findDomainBleedInText(text, where)
  if (hits.length) {
    const detail = hits.map((h) => `${h.term}@${h.where}`).join('; ')
    throw new Error(`[domain-bleed] forbidden fixture terms in production surface: ${detail}`)
  }
}
