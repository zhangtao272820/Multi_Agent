import { readManagerExperienceHistory } from '#agent-shared/managerMemoryHistory'
import { deriveScenarioKey } from '../text'
import { blendRecallScore, isVectorMemoryEnabled, vectorScoresForUsers } from './vectorMemory'
import { buildUserProfileRecall } from './userProfile'

export type LongMemoryItem = {
  kind: 'success' | 'failure' | 'similar'
  score: number
  scenarioKey: string
  intent: string
  summary: string
  user: string
  path?: string[]
  failureCategory?: string
  successScore?: number
  feedbackScore?: number
  ts?: string
}

function tokenBag(text: string): Set<string> {
  const s = String(text || '').toLowerCase()
  const parts = s.match(/[\p{L}\p{N}_]{2,}/gu) || []
  return new Set(parts.slice(0, 160))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

function summarizeUser(text: string, max = 120) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export async function buildLongMemoryRecall(
  policyDir: string,
  queryText: string,
  sessionId?: string,
  userId?: string
): Promise<{ text: string; items: LongMemoryItem[]; counts: { success: number; failure: number; similar: number } }> {
  const q = String(queryText || '').trim()
  if (!q) return { text: '', items: [], counts: { success: 0, failure: 0, similar: 0 } }
  const scenarioKey = deriveScenarioKey(q)
  const history = await readManagerExperienceHistory(policyDir, 900)
  const qBag = tokenBag(q)
  const useVector = isVectorMemoryEnabled()
  const users: string[] = []
  for (const h of history) {
    if (h?.type !== 'experience') continue
    const u = String(h.user || '').trim()
    if (u.length >= 6) users.push(u)
  }
  const vectorSims = useVector
    ? await vectorScoresForUsers(policyDir, q, users).catch(() => new Map<string, number>())
    : new Map<string, number>()
  const scored: LongMemoryItem[] = []

  for (const h of history) {
    if (h?.type !== 'experience') continue
    const user = String(h.user || '').trim()
    if (user.length < 6) continue
    const hScenario = typeof h.scenarioKey === 'string' && h.scenarioKey.trim() ? String(h.scenarioKey).trim() : deriveScenarioKey(user)
    const jac = jaccard(qBag, tokenBag(user))
    const vecSim = vectorSims.get(user) ?? 0
    const scene = scenarioKey && hScenario === scenarioKey ? 1 : 0
    const successScore = typeof h.successScore === 'number' ? h.successScore : 0.5
    const failureCategory = String(h.failureCategory || '')
    const isFailure = failureCategory && failureCategory !== 'success' || successScore < 0.72
    const kind: LongMemoryItem['kind'] = isFailure ? 'failure' : 'success'
    const boost = kind === 'success' ? successScore * 0.1 : 0.08
    const minJac = 0.14
    if (jac < minJac) continue
    const score = useVector ? blendRecallScore(vecSim, jac, scene * (jac >= minJac ? 1 : 0), boost) : jac * 0.72 + 0.08 * scene * (jac >= minJac ? 1 : 0) + boost
    if (score < 0.1) continue
    scored.push({
      kind,
      score,
      scenarioKey: hScenario,
      intent: String(h.intent || ''),
      summary: summarizeUser(user),
      user,
      path: Array.isArray(h.path) ? h.path.map((x: any) => String(x ?? '').trim()).filter(Boolean) : [],
      failureCategory: failureCategory || undefined,
      successScore,
      feedbackScore: typeof h.feedbackScore === 'number' ? h.feedbackScore : undefined,
      ts: typeof h.ts === 'string' ? h.ts : undefined
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const items = scored.slice(0, 6)
  const success = items.filter((x) => x.kind === 'success').slice(0, 2)
  const failure = items.filter((x) => x.kind === 'failure').slice(0, 2)
  const similar = items.slice(0, 2)

  const lines: string[] = [
    '### 长期经验记忆（相似历史任务；仅当与【当前用户输入】问法/条件相近时参考；冲突时以当前输入为准，勿照搬 path）'
  ]
  if (success.length) {
    lines.push('#### 相似成功经验')
    for (const it of success) {
      lines.push(`- intent=${it.intent}; path=${it.path?.join('→') || '—'}; 任务摘要: ${it.summary}`)
    }
  }
  if (failure.length) {
    lines.push('#### 相似失败经验')
    for (const it of failure) {
      lines.push(`- failure=${it.failureCategory || 'unclear'}; intent=${it.intent}; path=${it.path?.join('→') || '—'}; 任务摘要: ${it.summary}`)
    }
  }
  if (similar.length) {
    lines.push('#### 相似任务')
    for (const it of similar) {
      lines.push(`- kind=${it.kind}; score=${it.score.toFixed(2)}; 摘要: ${it.summary}`)
    }
  }
  let text = lines.length ? lines.join('\n') : ''
  if (sessionId) {
    const profileRecall = await buildUserProfileRecall(policyDir, sessionId, userId).catch(() => ({
      text: '',
      profile: null
    }))
    if (profileRecall.text) {
      text = text ? `${profileRecall.text}\n\n${text}` : profileRecall.text
    }
  }
  return {
    text,
    items,
    counts: { success: success.length, failure: failure.length, similar: similar.length }
  }
}
