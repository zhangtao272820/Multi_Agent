import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery, isAgentPgConfigured } from '#agent-shared/agentPgClient'
import { resolveUserKey } from '#agent-shared/resolveUserKey'
import { resolveStorageBackend, shouldWriteFile, shouldWritePostgres } from '#agent-shared/storageBackend'
import { sanitizeUserId } from '../task/userIdentity'

export type UserProfilePrefs = {
  /** IANA 时区，弱 hint */
  timezone?: string
  /** 常用专家 cap，弱 hint，禁止扩写路由 */
  preferredAgents?: string[]
  /** 拒答/谨慎偏好说明 */
  refusePreference?: string
}

export type PendingUserProfilePrefs = UserProfilePrefs & {
  proposedAt: string
  source?: string
}

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
  /** 弱 CRM 结构化偏好 */
  prefs?: UserProfilePrefs
  /** S1.1：热路径提议的 prefs，须显式确认后才写入 prefs */
  pendingPrefs?: PendingUserProfilePrefs | null
}

/** Wave6：热路径反馈 → 弱 prefs（不得改 cap） */
export function prefsPatchFromFeedbackSignal(input: {
  feedbackScore?: number | null
  implicitKind?: string | null
  successScore?: number | null
  preferredAgentsHint?: string[] | null
}): UserProfilePrefs | null {
  const patch: UserProfilePrefs = {}
  const fb = typeof input.feedbackScore === 'number' ? input.feedbackScore : null
  const kind = String(input.implicitKind || '').trim()
  if (kind === 'human_reject' || kind === 'user_cancel' || (fb != null && fb <= 0.35)) {
    patch.refusePreference = '用户近期对答案不满意或取消；优先证据与澄清，勿硬编'
  }
  if (fb != null && fb >= 0.78) {
    const agents = (input.preferredAgentsHint || []).map((a) => String(a || '').trim()).filter(Boolean).slice(0, 6)
    if (agents.length) patch.preferredAgents = agents
  }
  if (typeof input.successScore === 'number' && input.successScore >= 0.85 && !patch.preferredAgents) {
    const agents = (input.preferredAgentsHint || []).map((a) => String(a || '').trim()).filter(Boolean).slice(0, 6)
    if (agents.length) patch.preferredAgents = agents
  }
  if (!patch.refusePreference && !patch.preferredAgents && !patch.timezone) return null
  return patch
}

export async function applyHotPathPrefsFromSignal(
  policyDir: string,
  userId: string | undefined,
  signal: {
    feedbackScore?: number | null
    implicitKind?: string | null
    successScore?: number | null
    preferredAgentsHint?: string[] | null
    tenantId?: string
  }
): Promise<UserProfile | null> {
  const uid = sanitizeUserId(userId || '')
  if (!uid) return null
  const patch = prefsPatchFromFeedbackSignal(signal)
  if (!patch) return null
  // S1.1：热路径只提议，不直接写入 prefs
  return proposeUserProfilePrefs(policyDir, uid, patch, signal.tenantId, 'hot_path_signal')
}

/** 将 prefs 补丁记为 pending（不合并进正式 prefs） */
export async function proposeUserProfilePrefs(
  policyDir: string,
  userId: string,
  prefs: UserProfilePrefs,
  tenantId?: string,
  source = 'ops'
): Promise<UserProfile | null> {
  const uid = sanitizeUserId(userId)
  if (!uid) return null
  const prev = await loadUserProfile(policyDir, '', uid, tenantId)
  const pending: PendingUserProfilePrefs = {
    ...prefs,
    preferredAgents: prefs.preferredAgents,
    proposedAt: new Date().toISOString(),
    source,
  }
  const next: UserProfile = {
    sessionId: prev?.sessionId || '',
    userId: uid,
    updatedAt: new Date().toISOString(),
    runCount: prev?.runCount || 1,
    successCount: prev?.successCount || 0,
    intentCounts: prev?.intentCounts || {},
    recentSuccessSummaries: prev?.recentSuccessSummaries || [],
    lastIntent: prev?.lastIntent,
    lastPath: prev?.lastPath,
    lastScenarioKey: prev?.lastScenarioKey,
    prefersRag: prev?.prefersRag,
    prefersDb: prev?.prefersDb,
    prefs: prev?.prefs,
    pendingPrefs: pending,
  }
  return persistUserProfile(policyDir, uid, next, tenantId)
}

/** 显式确认：pending → prefs，并清空 pending */
export async function confirmPendingUserPrefs(
  policyDir: string,
  userId: string,
  tenantId?: string
): Promise<UserProfile | null> {
  const uid = sanitizeUserId(userId)
  if (!uid) return null
  const prev = await loadUserProfile(policyDir, '', uid, tenantId)
  const pending = prev?.pendingPrefs
  if (!pending) return prev
  const { proposedAt: _a, source: _s, ...prefsPatch } = pending
  const merged = await updateUserProfilePrefs(policyDir, uid, prefsPatch, tenantId)
  if (!merged) return null
  const cleared: UserProfile = { ...merged, pendingPrefs: null }
  return persistUserProfile(policyDir, uid, cleared, tenantId)
}

/** 拒绝提议：清空 pending，不改 prefs */
export async function rejectPendingUserPrefs(
  policyDir: string,
  userId: string,
  tenantId?: string
): Promise<UserProfile | null> {
  const uid = sanitizeUserId(userId)
  if (!uid) return null
  const prev = await loadUserProfile(policyDir, '', uid, tenantId)
  if (!prev) return null
  if (!prev.pendingPrefs) return prev
  const next: UserProfile = { ...prev, pendingPrefs: null, updatedAt: new Date().toISOString() }
  return persistUserProfile(policyDir, uid, next, tenantId)
}

async function persistUserProfile(
  policyDir: string,
  uid: string,
  next: UserProfile,
  tenantId?: string
): Promise<UserProfile> {
  const backend = profileStorageBackend()
  if (shouldWritePostgres(backend)) {
    await savePgUserProfile(uid, next, tenantId)
  }
  if (shouldWriteFile(backend) || !isPgProfileEnabled()) {
    const all = await readProfiles(policyDir)
    all[userKey(uid)] = next
    await writeProfiles(policyDir, all)
  }
  return next
}

/** Trace / ops 可读的弱画像摘要（非 CRM 产品） */
export function summarizeWeakProfileForTrace(profile: UserProfile | null): Record<string, unknown> | null {
  if (!profile || profile.runCount < 1) return null
  return {
    runCount: profile.runCount,
    successCount: profile.successCount,
    lastIntent: profile.lastIntent || null,
    prefersRag: Boolean(profile.prefersRag),
    prefersDb: Boolean(profile.prefersDb),
    prefs: profile.prefs || null,
    pendingPrefs: profile.pendingPrefs || null,
  }
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
  const prefsRaw = o.prefs && typeof o.prefs === 'object' ? (o.prefs as Record<string, unknown>) : null
  const prefs: UserProfilePrefs | undefined = prefsRaw
    ? {
        timezone: prefsRaw.timezone ? String(prefsRaw.timezone).slice(0, 64) : undefined,
        preferredAgents: Array.isArray(prefsRaw.preferredAgents)
          ? prefsRaw.preferredAgents.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
          : undefined,
        refusePreference: prefsRaw.refusePreference
          ? String(prefsRaw.refusePreference).slice(0, 200)
          : undefined,
      }
    : undefined
  const pendingRaw =
    o.pendingPrefs && typeof o.pendingPrefs === 'object' ? (o.pendingPrefs as Record<string, unknown>) : null
  const pendingPrefs: PendingUserProfilePrefs | null | undefined = pendingRaw
    ? {
        timezone: pendingRaw.timezone ? String(pendingRaw.timezone).slice(0, 64) : undefined,
        preferredAgents: Array.isArray(pendingRaw.preferredAgents)
          ? pendingRaw.preferredAgents.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
          : undefined,
        refusePreference: pendingRaw.refusePreference
          ? String(pendingRaw.refusePreference).slice(0, 200)
          : undefined,
        proposedAt: String(pendingRaw.proposedAt || new Date().toISOString()),
        source: pendingRaw.source ? String(pendingRaw.source).slice(0, 64) : undefined,
      }
    : o.pendingPrefs === null
      ? null
      : undefined
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
    prefersDb: Boolean(o.prefersDb),
    prefs,
    pendingPrefs,
  }
}

async function loadPgUserProfile(
  uid: string,
  tenantId?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<UserProfile | null> {
  if (!uid || !isPgProfileEnabled(env)) return null
  const { normalizeTenantId } = await import('#agent-shared/tenantScope')
  const tid = normalizeTenantId(tenantId, env)
  const key = resolveUserKey({ userId: uid })
  const res = await agentPgQuery<{ payload: unknown }>(
    `SELECT payload FROM mgr_user_profiles WHERE user_key = $1 AND tenant_id = $2 LIMIT 1`,
    [key, tid],
    env
  ).catch(() => null)
  const row = res?.rows?.[0]
  return coerceProfile(row?.payload)
}

async function savePgUserProfile(
  uid: string,
  profile: UserProfile,
  tenantId?: string,
  env: NodeJS.ProcessEnv = process.env
) {
  if (!uid || !isPgProfileEnabled(env)) return
  const { normalizeTenantId } = await import('#agent-shared/tenantScope')
  const tid = normalizeTenantId(tenantId, env)
  const key = resolveUserKey({ userId: uid })
  await agentPgQuery(
    `INSERT INTO mgr_user_profiles (user_key, payload, tenant_id, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (user_key) DO UPDATE SET
       payload = EXCLUDED.payload,
       tenant_id = EXCLUDED.tenant_id,
       updated_at = NOW()`,
    [key, JSON.stringify(profile), tid],
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
    prefersDb: session.prefersDb || user.prefersDb,
    prefs: { ...(user.prefs || {}), ...(session.prefs || {}) },
  }
}

/** 更新弱 CRM prefs（不改路由 cap；仅注入 composer hint）；显式 set 时保留 pending */
export async function updateUserProfilePrefs(
  policyDir: string,
  userId: string,
  prefs: UserProfilePrefs,
  tenantId?: string
): Promise<UserProfile | null> {
  const uid = sanitizeUserId(userId)
  if (!uid) return null
  const prev = await loadUserProfile(policyDir, '', uid, tenantId)
  const next: UserProfile = {
    sessionId: prev?.sessionId || '',
    userId: uid,
    updatedAt: new Date().toISOString(),
    runCount: prev?.runCount || 1,
    successCount: prev?.successCount || 0,
    intentCounts: prev?.intentCounts || {},
    recentSuccessSummaries: prev?.recentSuccessSummaries || [],
    lastIntent: prev?.lastIntent,
    lastPath: prev?.lastPath,
    lastScenarioKey: prev?.lastScenarioKey,
    prefersRag: prev?.prefersRag,
    prefersDb: prev?.prefersDb,
    prefs: {
      ...(prev?.prefs || {}),
      ...prefs,
      preferredAgents: prefs.preferredAgents ?? prev?.prefs?.preferredAgents,
    },
    pendingPrefs: prev?.pendingPrefs ?? null,
  }
  return persistUserProfile(policyDir, uid, next, tenantId)
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
    prefersDb: Boolean(run.probeDbMatched) || prev?.prefersDb,
    prefs: prev?.prefs,
    pendingPrefs: prev?.pendingPrefs ?? null,
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
  userId?: string,
  tenantId?: string
): Promise<UserProfile | null> {
  const sid = String(sessionId || '').trim()
  if (!sid && !userId) return null
  const all = await readProfiles(policyDir)
  const legacy = sid ? all[sid] : undefined
  const session = sid ? all[sessionKey(sid)] || legacy : undefined
  const uid = sanitizeUserId(userId || '')
  const fileUser = uid ? all[userKey(uid)] : undefined
  const pgUser = uid ? await loadPgUserProfile(uid, tenantId) : null
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
    tenantId?: string
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
    const prevPg = await loadPgUserProfile(uid, run.tenantId)
    const prev = prevPg || all[uk]
    const next = applyRunToProfile(prev, sid, uid, run)
    all[uk] = next
    if (shouldWritePostgres(backend)) {
      await savePgUserProfile(uid, next, run.tenantId)
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
  if (profile.prefs?.timezone) lines.push(`- 时区偏好：${profile.prefs.timezone}（弱参考）`)
  if (profile.prefs?.preferredAgents?.length) {
    lines.push(`- 常用专家偏好：${profile.prefs.preferredAgents.join('、')}（弱参考，不得据此扩写 allowedAgents）`)
  }
  if (profile.prefs?.refusePreference) {
    lines.push(`- 拒答偏好：${profile.prefs.refusePreference}（弱参考）`)
  }
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
  userId?: string,
  tenantId?: string
): Promise<{ text: string; profile: UserProfile | null }> {
  const profile = await loadUserProfile(policyDir, sessionId, userId, tenantId)
  const text = formatUserProfileBlock(profile, userId ? 'merged' : 'session')
  return { text, profile }
}
