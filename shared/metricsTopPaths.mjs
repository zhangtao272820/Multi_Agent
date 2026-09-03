/**
 * 贵路径 Top：按 phase / agent / thickness 聚合 token + 估算 USD（纯函数）。
 */

function readCostPer1k(env = process.env) {
  const n = Number(env.MANAGER_COST_PER_1K_TOKENS_USD ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function resolveMetricRowUsd(row, env = process.env) {
  const usd = Number(row?.usd ?? 0)
  if (Number.isFinite(usd) && usd > 0) return usd
  const tok = Number(row?.tokens ?? 0)
  const rate = readCostPer1k(env)
  if (!Number.isFinite(tok) || tok <= 0 || rate <= 0) return 0
  return Math.round((tok / 1000) * rate * 1_000_000) / 1_000_000
}

function bucketKey(phase, agent, thickness) {
  return `${phase}|${agent}|${thickness}`
}

export function aggregateTopPathsFromMetricRows(rows, env = process.env) {
  const map = new Map()
  for (const raw of rows) {
    const phase = String(raw?.phase || 'unknown').trim() || 'unknown'
    const agent = String(raw?.agent || '').trim()
    const extra = raw?.extra && typeof raw.extra === 'object' ? raw.extra : {}
    const thickness =
      phase === 'route_authority'
        ? String(extra.orchestrationThickness || 'unknown').trim() || 'unknown'
        : ''
    const agentBucket = agent || (['db', 'rag', 'code', 'crawler', 'admin'].includes(phase) ? phase : '')
    const key = bucketKey(phase, agentBucket, thickness)
    const prev = map.get(key) || {
      key,
      phase,
      agent: agentBucket,
      thickness,
      count: 0,
      tokens: 0,
      usd: 0
    }
    prev.count += 1
    const tok = Number(raw?.tokens ?? 0)
    if (Number.isFinite(tok) && tok > 0) prev.tokens += tok
    prev.usd += resolveMetricRowUsd({ usd: raw?.usd, tokens: raw?.tokens }, env)
    map.set(key, prev)
  }
  return [...map.values()]
    .map((b) => ({ ...b, usd: Math.round(b.usd * 10000) / 10000 }))
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
}

export function formatTopPathsReport(buckets, topN = 10) {
  const lines = ['# Manager 贵路径 Top（token + 估算 USD）', '']
  const head = buckets.slice(0, topN)
  for (const b of head) {
    lines.push(
      `- ${b.phase}${b.agent ? `/${b.agent}` : ''}${b.thickness ? ` [${b.thickness}]` : ''}: count=${b.count} tokens=${b.tokens} usd≈${b.usd}`
    )
  }
  if (!head.length) lines.push('(no samples)')
  return lines.join('\n')
}
