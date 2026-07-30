import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery, isAgentPgConfigured } from '#agent-shared/agentPgClient'
import { resolveUserKey } from '#agent-shared/resolveUserKey'
import { resolveStorageBackend, shouldWriteFile, shouldWritePostgres } from '#agent-shared/storageBackend'
import { sanitizeUserId } from '../task/userIdentity'

export type UserProfile = {
  sessionId: string
  userId?: string
  updatedAt: string
  lastIntent?: string
  lastPath?: string[]
  lastScenarioKey?: string
  runCount: number
  successCount: number
  intentCounts: Record<string, number>
  /** 近期成功任务摘要（供路由/planner 偏好参考） */
  recentSuccessSummaries: string[]
  prefersRag?: boolean
  prefersDb?: boolean
}

const PROFILE_FILE = 'manager-user-profiles.json'

function summarize(text: string, max = 100) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function sessionKey(sessionId: string) {
  return `session:${String(sessionId || '').trim()}`
}

function userKey(userId: string) {
  return `user:${sanitizeUserId(userId)}`
}

function profileStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.MANAGER_STORAGE_BACKEND, 'dual')
}

function isPgProfileEnabled(env: NodeJS.ProcessEnv = process.env) {
  return shouldWritePostgres(profileStorageBackend(env)) && isAgentPgConfigured(env)
}

async function readProfiles(policyDir: string): Promise<Record<string, UserProfile>> {
  try {
    const raw = await fs.readFile(path.join(policyDir, PROFILE_FILE), 'utf8')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as Record<string, UserProfile>) : {}
  } catch {
    return {}
  }
}

async function writeProfiles(policyDir: string, data: Record<string, UserProfile>) {
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  await fs.writeFile(path.join(policyDir, PROFILE_FILE), JSON.stringify(data, null, 2), 'utf8')
}

function coerceProfile(raw: unknown, fallbackSessionId = ''): UserProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const intentCounts =
    o.intentCounts && typeof o.intentCounts === 'object' ? (o.intentCounts as Record<string, number>) : {}
  const summaries = Array.isArray(o.recentSuccessSummaries)
    ? o.recentSuccessSummaries.map((x) => String(x || '').trim()).filter(Boolean).slice(-5)
    : []
  return {
    sessionId: String(o.sessionId || fallbackSessionId || ''),
    userId: o.userId ? String(o.userId) : undefined,
    updatedAt: String(o.updatedAt || new Date().toISOString()),
    lastIntent: o.lastIntent ? String(o.lastIntent) : undefined,
    lastPath: Array.isArray(o.lastPath) ? o.lastPath.map((x) => String(x)) : undefined,
    lastScenarioKey: o.lastScenarioKey ? String(o.lastScenarioKey) : undefined,
    runCount: Number(o.runCount || 0),
    successCount: Number(o.successCount || 0),
    intentCounts,
    recentSuccessSummaries: summaries,
    prefersRag: Boolean(o.prefersRag),
    prefersDb: Boolean(o.prefersDb)
  }
}

async function loadPgUserProfile(uid: string, env: NodeJS.ProcessEnv = process.env): Promise<UserProfile | null> {
  if (!uid || !isPgProfileEnabled(env)) return null
  const key = resolveUserKey({ userId: uid })
  const res = await agentPgQuery<{ payload: unknown }>(
    `SELECT payload FROM mgr_user_profiles WHERE user_key = $1 LIMIT 1`,
    [key],
    env
  ).catch(() => null)
  const row = res?.rows?.[0]
  return coerceProfile(row?.payload)
}

async function savePgUserProfile(uid: string, profile: UserProfile, env: NodeJS.ProcessEnv = process.env) {
  if (!uid || !isPgProfileEnabled(env)) return
  const key = resolveUserKey({ userId: uid })
  await agentPgQuery(
    `INSERT INTO mgr_user_profiles (user_key, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [key, JSON.stringify(profile)],
    env
  ).catch(() => undefined)
}

function mergeProfiles(session: UserProfile | null, user: UserProfile | null): UserProfile | null {
  if (!session && !user) return null
  if (!user) return session
  if (!session) return user
  const intentCounts = { ...user.intentCounts }
  for (const [k, v] of Object.entries(session.intentCounts || {})) {
    intentCounts[k] = (intentCounts[k] || 0) + v
  }
  const summaries = [
    ...new Set([...(user.recentSuccessSummaries || []), ...(session.recentSuccessSummaries || [])])
  ].slice(-5)
  return {
    sessionId: session.sessionId,
    userId: user.userId || session.userId,
    updatedAt: session.updatedAt > user.updatedAt ? session.updatedAt : user.updatedAt,
    lastIntent: session.lastIntent || user.lastIntent,
    lastPath: session.lastPath?.length ? session.lastPath : user.lastPath,
    lastScenarioKey: session.lastScenarioKey || user.lastScenarioKey,
    runCount: (user.runCount || 0) + (session.runCount || 0),
    successCount: (user.successCount || 0) + (session.successCount || 0),
    intentCounts,
    recentSuccessSummaries: summaries,
    prefersRag: session.prefersRag || user.prefersRag,
    prefersDb: session.prefersDb || user.prefersDb
  }
}

function applyRunToProfile(
  prev: UserProfile | undefined,
  sid: string,
  uid: string | undefined,
  run: {
    user: string
    intent?: string
    path?: string[]
    scenarioKey?: string
    successScore?: number
    probeRagHits?: number
    probeDbMatched?: boolean
  }
): UserProfile {
  const score = typeof run.successScore === 'number' ? run.successScore : 0.5
  const intent = String(run.intent || '').trim() || 'unknown'
  const intentCounts = { ...(prev?.intentCounts || {}) }
  intentCounts[intent] = (intentCounts[intent] || 0) + 1

  const profile: UserProfile = {
    sessionId: sid,
    userId: uid || prev?.userId,
    updatedAt: new Date().toISOString(),
    lastIntent: intent,
    lastPath: Array.isArray(run.path) ? run.path : prev?.lastPath,
    lastScenarioKey: run.scenarioKey || prev?.lastScenarioKey,
    runCount: (prev?.runCount || 0) + 1,
    successCount: (prev?.successCount || 0) + (score >= 0.75 ? 1 : 0),
    intentCounts,
    recentSuccessSummaries: [...(prev?.recentSuccessSummaries || [])],
    prefersRag: Boolean(run.probeRagHits && run.probeRagHits > 0) || prev?.prefersRag,
    prefersDb: Boolean(run.probeDbMatched) || prev?.prefersDb
  }

  if (score >= 0.75) {
    const line = summarize(run.user, 100)
    if (line) {
      profile.recentSuccessSummaries = [...profile.recentSuccessSummaries.filter((x) => x !== line), line].slice(-5)
    }
  }
  return profile
}

export async function loadUserProfile(
  policyDir: string,
  sessionId: string,
  userId?: string
): Promise<UserProfile | null> {
  const sid = String(sessionId || '').trim()
  if (!sid && !userId) return null
  const all = await readProfiles(policyDir)
  const legacy = sid ? all[sid] : undefined
  const session = sid ? all[sessionKey(sid)] || legacy : undefined
  const uid = sanitizeUserId(userId || '')
  const fileUser = uid ? all[userKey(uid)] : undefined
  const pgUser = uid ? await loadPgUserProfile(uid) : null
  // PG 为跨会话权威；文件仅作回退 / dual 镜像
  const user = pgUser || fileUser || null
  return mergeProfiles(session || null, user)
}

export async function updateUserProfileFromRun(
  policyDir: string,
  sessionId: string,
  run: {
    user: string
    intent?: string
    path?: string[]
    scenarioKey?: string
    successScore?: number
    probeRagHits?: number
    probeDbMatched?: boolean
    userId?: string
  }
) {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  const uid = sanitizeUserId(run.userId || '')
  const backend = profileStorageBackend()
  const all = await readProfiles(policyDir)

  const sk = sessionKey(sid)
  all[sk] = applyRunToProfile(all[sk] || (all[sid] ? { ...all[sid], sessionId: sid } : undefined), sid, uid || undefined, run)
  if (all[sid] && sid !== sk) delete all[sid]

  if (uid) {
    const uk = userKey(uid)
    const prevPg = await loadPgUserProfile(uid)
    const prev = prevPg || all[uk]
    const next = applyRunToProfile(prev, sid, uid, run)
    all[uk] = next
    if (shouldWritePostgres(backend)) {
      await savePgUserProfile(uid, next)
    }
  }

  if (shouldWriteFile(backend) || !isPgProfileEnabled()) {
    await writeProfiles(policyDir, all)
  }
}

export function formatUserProfileBlock(profile: UserProfile | null, scope?: 'session' | 'user' | 'merged'): string {
  if (!profile || profile.runCount < 1) return ''
  const topIntents = Object.entries(profile.intentCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}×${v}`)
    .join('，')
  const scopeLabel =
    scope === 'user' ? '跨会话用户画像' : scope === 'session' ? '本会话用户画像' : '用户画像（会话+跨会话合并）'
  const lines = [
    `### ${scopeLabel}（结构化记忆，供路由/planner 参考）`,
    profile.userId ? `- 用户 ID：${profile.userId}` : '',
    `- 累计对话 ${profile.runCount} 次，成功 ${profile.successCount} 次`,
    topIntents ? `- 常用意图：${topIntents}` : '',
    profile.lastIntent ? `- 最近一次意图：${profile.lastIntent}` : '',
    profile.lastPath?.length ? `- 最近一次路径：${profile.lastPath.join('→')}` : '',
    profile.prefersRag ? '- 历史倾向：知识库/RAG' : '',
    profile.prefersDb ? '- 历史倾向：数据库/结构化查询' : ''
  ]
  if (profile.recentSuccessSummaries.length) {
    lines.push('- 近期成功任务摘要：')
    for (const s of profile.recentSuccessSummaries.slice(-3)) {
      lines.push(`  - ${s}`)
    }
  }
  return lines.filter(Boolean).join('\n')
}

export async function buildUserProfileRecall(
  policyDir: string,
  sessionId: string,
  userId?: string
): Promise<{ text: string; profile: UserProfile | null }> {
  const profile = await loadUserProfile(policyDir, sessionId, userId)
  const text = formatUserProfileBlock(profile, userId ? 'merged' : 'session')
  return { text, profile }
}
