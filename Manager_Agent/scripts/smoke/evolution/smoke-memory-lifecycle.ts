/**
 * W3 / Wave6：记忆生命周期 — importance / 衰减 / prefs 热路径 / forget 过滤
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scoreMemoryImportance } from '../../../agent-repo-shared/memoryImportance'
import {
  blendRecallScore,
  filterActiveMemoryPayloads,
  rankRecallCandidates,
  resolveExperiencePathConflicts,
  compareMemoryTrust,
  timeDecayScore,
} from '../../../agent-repo-shared/agentMemoryRecall'
import { ampRecallDecayLambdaPerDay } from '../../../agent-repo-shared/agentMemoryPolicy'
import {
  applyHotPathPrefsFromSignal,
  formatUserProfileBlock,
  prefsPatchFromFeedbackSignal,
  summarizeWeakProfileForTrace,
  updateUserProfilePrefs,
  type UserProfile,
} from '../../../server/graph/core/memory/userProfile'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-memory-lifecycle] ${msg}`)
}

async function main() {
  console.log('smoke-memory-lifecycle: start')

  const low = scoreMemoryImportance({ chitchat: true })
  const high = scoreMemoryImportance({ userExplicitPreference: true })
  const mid = scoreMemoryImportance({ successScore: 0.9, entryType: 'experience' })
  assert(low < 0.3 && high > 0.9 && mid > 0.7, `importance order ${low}/${mid}/${high}`)

  const withImp = blendRecallScore({
    vectorSim: 0.2,
    jaccard: 0.2,
    recency: 0.5,
    successScore: 0.8,
    importance: 0.95,
  })
  const without = blendRecallScore({
    vectorSim: 0.2,
    jaccard: 0.2,
    recency: 0.5,
    successScore: 0.8,
    importance: 0.1,
  })
  assert(withImp > without, 'importance lifts blend score')

  const ranked = rankRecallCandidates(
    '护理员配比',
    [
      {
        text: '护理员配比标准 1:3',
        ts: new Date().toISOString(),
        successScore: 0.8,
        importance: 0.3,
      },
      {
        text: '护理员配比与值班表',
        ts: new Date().toISOString(),
        successScore: 0.8,
        importance: 0.95,
      },
    ],
    { limit: 2 }
  )
  assert(ranked[0]?.importance === 0.95, 'higher importance ranks first when lexical similar')

  // Wave6：时间衰减可配
  const oldTs = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const fresh = timeDecayScore(new Date().toISOString(), 0.2)
  const stale = timeDecayScore(oldTs, 0.2)
  assert(fresh > stale, `decay fresh ${fresh} > stale ${stale}`)
  const lambda = ampRecallDecayLambdaPerDay({ AMP_RECALL_DECAY_LAMBDA: '0.2' } as NodeJS.ProcessEnv)
  assert(Math.abs(lambda - 0.2) < 1e-9, 'amp decay env')
  const decayRanked = rankRecallCandidates(
    '配比',
    [
      { text: '配比旧记忆', ts: oldTs, successScore: 0.9, importance: 0.5 },
      { text: '配比新记忆', ts: new Date().toISOString(), successScore: 0.9, importance: 0.5 },
    ],
    { limit: 2, decayLambdaPerDay: 0.25 }
  )
  assert(decayRanked[0]?.text.includes('新'), 'fresher ranks first under decay')

  // forget → recall 过滤（集成契约，无 PG 时测过滤函数）
  const active = filterActiveMemoryPayloads([
    { text: 'keep', payload: {} },
    { text: 'gone', payload: { deleted_at: new Date().toISOString() } },
    { text: 'gone2', deleted_at: '2026-01-01T00:00:00.000Z' },
  ])
  assert(active.length === 1 && active[0]?.text === 'keep', 'forget filter drops deleted')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-life-'))
  const profile = await updateUserProfilePrefs(
    tmp,
    'user_lifecycle_1',
    {
      timezone: 'Asia/Shanghai',
      preferredAgents: ['rag', 'db'],
      refusePreference: '无证据不编造制度数字',
    },
    'default'
  )
  assert(profile?.prefs?.timezone === 'Asia/Shanghai', 'prefs timezone')
  const block = formatUserProfileBlock(profile as UserProfile, 'user')
  assert(block.includes('时区偏好'), 'profile block timezone')
  assert(block.includes('不得据此扩写 allowedAgents'), 'weak hint disclaimer')
  assert(block.includes('拒答偏好'), 'refuse pref')

  // Wave6：反馈 → prefs 热路径（仅提议，须 confirm）
  const rejectPatch = prefsPatchFromFeedbackSignal({ feedbackScore: 0.2, implicitKind: 'human_reject' })
  assert(rejectPatch?.refusePreference, 'reject → refusePreference')
  const posPatch = prefsPatchFromFeedbackSignal({
    feedbackScore: 0.9,
    preferredAgentsHint: ['rag', 'db'],
  })
  assert(posPatch?.preferredAgents?.includes('rag'), 'positive feedback → preferredAgents')
  const hot = await applyHotPathPrefsFromSignal(tmp, 'user_lifecycle_1', {
    feedbackScore: 0.9,
    preferredAgentsHint: ['admin'],
    tenantId: 'default',
  })
  assert(hot?.pendingPrefs?.preferredAgents?.includes('admin'), 'hot path proposes pendingPrefs')
  assert(!hot?.prefs?.preferredAgents?.includes('admin'), 'hot path does not silent-write prefs')
  const {
    confirmPendingUserPrefs,
    rejectPendingUserPrefs,
  } = await import('../../../server/graph/core/memory/userProfile')
  const rejected = await rejectPendingUserPrefs(tmp, 'user_lifecycle_1', 'default')
  assert(!rejected?.pendingPrefs, 'reject clears pending')
  assert(!rejected?.prefs?.preferredAgents?.includes('admin'), 'reject does not write prefs')

  const hot2 = await applyHotPathPrefsFromSignal(tmp, 'user_lifecycle_1', {
    feedbackScore: 0.9,
    preferredAgentsHint: ['admin'],
    tenantId: 'default',
  })
  assert(hot2?.pendingPrefs?.preferredAgents?.includes('admin'), 're-propose after reject')
  const confirmed = await confirmPendingUserPrefs(tmp, 'user_lifecycle_1', 'default')
  assert(confirmed?.prefs?.preferredAgents?.includes('admin'), 'confirm writes prefs')
  assert(!confirmed?.pendingPrefs, 'confirm clears pending')

  const weak = summarizeWeakProfileForTrace(confirmed)
  assert(weak && weak.prefs, 'weak profile for Trace')

  // S1.3：升华冲突门
  const { evaluateSemanticClusterGate } = await import('../../../agent-repo-shared/semanticConsolidationJob')
  const okGate = evaluateSemanticClusterGate(
    [
      { payload: { intent: '查护理员配比制度', successScore: 0.9 } },
      { payload: { intent: '护理员配比标准', successScore: 0.88 } },
      { payload: { intent: '配比要求是多少', successScore: 0.91 } },
    ],
    { minCluster: 3, maxUniqueIntents: 3 }
  )
  assert(okGate.ok, 'similar intents consolidate')
  const badGate = evaluateSemanticClusterGate(
    [
      { payload: { intent: '查护理员配比制度', successScore: 0.9 } },
      { payload: { intent: '明天北京天气怎么样', successScore: 0.9 } },
      { payload: { intent: '打开门户填报请假单', successScore: 0.9 } },
    ],
    { minCluster: 3, maxUniqueIntents: 3 }
  )
  assert(!badGate.ok && badGate.reason === 'intent_conflict', 'conflict intents rejected')

  // path 冲突：同 scenario 不同 path 只保留更可信的一条
  const resolved = resolveExperiencePathConflicts([
    {
      scenarioKey: 'care_ratio',
      pathKey: 'rag',
      score: 0.82,
      ts: '2026-01-01T00:00:00.000Z',
      source: 'implicit',
      feedbackScore: 0.7,
    },
    {
      scenarioKey: 'care_ratio',
      pathKey: 'db→rag',
      score: 0.8,
      ts: '2026-08-01T00:00:00.000Z',
      source: 'explicit_user_request',
      feedbackScore: 0.9,
    },
  ])
  assert(resolved.length === 1, 'path conflict collapses to one row')
  assert(resolved[0]?.pathKey === 'db→rag', 'explicit newer path wins conflict')
  assert(
    compareMemoryTrust(
      { score: 0.8, ts: '2026-08-01T00:00:00.000Z', source: 'explicit_user_request', feedbackScore: 0.9 },
      { score: 0.82, ts: '2026-01-01T00:00:00.000Z', source: 'implicit', feedbackScore: 0.7 }
    ) > 0,
    'compareMemoryTrust prefers explicit'
  )

  const { proposeUserProfilePrefs, detectPrefsConflictNote } = await import(
    '../../../server/graph/core/memory/userProfile'
  )
  const conflictNote = detectPrefsConflictNote(
    { preferredAgents: ['rag', 'db'], timezone: 'Asia/Shanghai' },
    { preferredAgents: ['admin'], timezone: 'Asia/Tokyo' }
  )
  assert(conflictNote?.includes('专家偏好冲突'), 'prefs conflict detected')
  assert(conflictNote?.includes('时区冲突'), 'timezone conflict detected')
  const conflictTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-conflict-'))
  const conflictProfile = await proposeUserProfilePrefs(
    conflictTmp,
    'user_conflict_1',
    { preferredAgents: ['admin'] },
    'default',
    'explicit_user_request'
  )
  await updateUserProfilePrefs(conflictTmp, 'user_conflict_1', { preferredAgents: ['rag'] }, 'default')
  const conflictProfile2 = await proposeUserProfilePrefs(
    conflictTmp,
    'user_conflict_1',
    { preferredAgents: ['admin'] },
    'default',
    'explicit_user_request'
  )
  assert(conflictProfile2?.pendingPrefs?.conflictNote?.includes('专家偏好冲突'), 'pending stores conflictNote')
  await fs.rm(conflictTmp, { recursive: true, force: true }).catch(() => undefined)

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log('smoke-memory-lifecycle: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
