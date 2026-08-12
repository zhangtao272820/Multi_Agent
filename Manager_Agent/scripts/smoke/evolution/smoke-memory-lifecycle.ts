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

  // Wave6：反馈 → prefs 热路径
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
  assert(hot?.prefs?.preferredAgents?.includes('admin'), 'hot path prefs write')
  const weak = summarizeWeakProfileForTrace(hot)
  assert(weak && weak.prefs, 'weak profile for Trace')

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log('smoke-memory-lifecycle: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
