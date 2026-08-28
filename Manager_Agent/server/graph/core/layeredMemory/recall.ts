/** 冲突消解：同场景下，反思记忆若与高分成功经验语义相反，降低反思权重 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readManagerMemoryEntries } from '#agent-shared/managerMemoryHistory'
import { deriveScenarioKey } from '../text'
import { buildLongMemoryRecall, type LongMemoryItem } from '../memory/longMemory'
import { buildUserProfileRecall } from '../memory/userProfile'
import type { FailureAttribution } from '../evolution/failureAttribution'
import {
  tokenBag,
  jaccard,
  SEMANTIC_FILE,
  REFLECTION_FILE,
  WORKING_DIR,
  readJsonlTail,
  maxReflectionLines,
  summarize,
  isLayeredMemoryEnabled,
  isReflectionMemoryEnabled,
  isSemanticMemoryEnabled,
  loadWorkingMemory,
  updateWorkingMemoryFromSessionFile,
  updateWorkingMemoryFromMessages,
  appendReflectionMemory,
  appendSemanticMemory,
  type ReflectionRecord,
  type SemanticRecord,
  type WorkingMemoryRecord
} from './record'

export function applyMemoryConflictResolution(
  reflections: Array<{ lesson: string; category: string; score: number }>,
  experienceSuccessSummaries: string[]
): Array<{ lesson: string; category: string; score: number }> {
  if (!experienceSuccessSummaries.length) return reflections
  const successBag = tokenBag(experienceSuccessSummaries.join(' '))
  return reflections.filter((r) => {
    const rb = tokenBag(r.lesson)
    const overlap = jaccard(rb, successBag)
    if (r.category === 'success') return true
    if (overlap > 0.55 && r.score < 0.5) return false
    return true
  })
}

async function readLayeredMemoryRows(
  policyDir: string,
  type: 'semantic' | 'reflection',
  maxLines: number
): Promise<any[]> {
  const pgRows = await readManagerMemoryEntries(policyDir, { types: [type], maxLines })
  if (pgRows.length) return pgRows
  const file = type === 'semantic' ? SEMANTIC_FILE : REFLECTION_FILE
  return readJsonlTail(path.join(policyDir, file), maxLines)
}

async function buildReflectionBlock(
  policyDir: string,
  queryText: string,
  scenarioKey: string,
  opts?: { skipClarifyLessons?: boolean }
): Promise<string> {
  const rows = await readLayeredMemoryRows(policyDir, 'reflection', maxReflectionLines())
  const qBag = tokenBag(queryText)
  const scored = rows
    .filter((r) => !r?.superseded)
    .map((r) => {
      const lesson = String(r?.lesson || '').trim()
      const sk = String(r?.scenarioKey || '')
      const scene = sk && sk === scenarioKey ? 0.25 : 0
      const jac = jaccard(qBag, tokenBag(`${lesson} ${r?.userSummary || ''}`))
      return {
        lesson,
        category: String(r?.category || 'unclear'),
        score: jac + scene + (r?.severity === 'high' ? 0.1 : 0)
      }
    })
    .filter((x) => x.lesson && x.score >= 0.12)
    .filter((x) => !(opts?.skipClarifyLessons && x.category === 'clarify_needed'))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)

  if (!scored.length) return ''
  const resolved = applyMemoryConflictResolution(scored, [])
  if (!resolved.length) return ''
  return [
    '### 反思记忆（历史失败教训；若与本轮用户明确意图冲突，以本轮为准）',
    ...resolved.map((r) => `- [${r.category}] ${r.lesson}`)
  ].join('\n')
}

async function buildSemanticBlock(policyDir: string, queryText: string, scenarioKey: string): Promise<string> {
  const rows = await readLayeredMemoryRows(policyDir, 'semantic', 120)
  const qBag = tokenBag(queryText)
  const scored = rows
    .map((r) => {
      const fact = String(r?.fact || '').trim()
      const sk = String(r?.scenarioKey || '')
      const scene = sk && sk === scenarioKey ? 0.3 : 0
      const conf = typeof r?.confidence === 'number' ? r.confidence * 0.15 : 0.08
      const jac = jaccard(qBag, tokenBag(fact))
      return { fact, score: jac + scene + conf }
    })
    .filter((x) => x.fact && x.score >= 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
  if (!scored.length) return ''
  return [
    '### 长期语义记忆（跨轮事实摘要；若与本轮用户明确意图冲突，以本轮为准）',
    ...scored.map((r) => `- ${r.fact}`)
  ].join('\n')
}

function buildWorkingBlock(working: WorkingMemoryRecord | null): string {
  if (!working) return ''
  const lines = ['### 工作记忆（当前会话上下文；非新指令；换话题时以本轮用户输入为准）']
  if (working.recentGoals.length) {
    lines.push('- 近期目标：')
    for (const g of working.recentGoals.slice(0, 3)) lines.push(`  - ${g}`)
  }
  if (working.lastUserSnippets.length) {
    lines.push('- 最近用户表述：')
    for (const u of working.lastUserSnippets.slice(-3)) lines.push(`  - ${u}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

export type LayeredMemoryRecall = {
  text: string
  items: LongMemoryItem[]
  counts: { success: number; failure: number; similar: number }
  layers: {
    working: boolean
    semantic: boolean
    experience: boolean
    reflection: boolean
    profile: boolean
  }
}

export async function buildLayeredMemoryRecall(
  policyDir: string,
  queryText: string,
  sessionId?: string,
  userId?: string,
  opts?: { skipClarifyLessons?: boolean }
): Promise<LayeredMemoryRecall> {
  if (!isLayeredMemoryEnabled()) {
    const base = await buildLongMemoryRecall(policyDir, queryText, sessionId, userId)
    return {
      ...base,
      layers: { working: false, semantic: false, experience: true, reflection: false, profile: Boolean(sessionId || userId) }
    }
  }

  const q = String(queryText || '').trim()
  const scenarioKey = deriveScenarioKey(q)
  const blocks: string[] = []

  if (sessionId) {
    await updateWorkingMemoryFromSessionFile(policyDir, sessionId).catch(() => undefined)
    const working = await loadWorkingMemory(policyDir, sessionId)
    const wb = buildWorkingBlock(working)
    if (wb) blocks.push(wb)
  }

  const semantic = await buildSemanticBlock(policyDir, q, scenarioKey)
  if (semantic) blocks.push(semantic)

  const reflection = await buildReflectionBlock(policyDir, q, scenarioKey, {
    skipClarifyLessons: opts?.skipClarifyLessons === true
  })
  if (reflection) blocks.push(reflection)

  const experience = await buildLongMemoryRecall(policyDir, q, sessionId, userId)
  if (experience.text) blocks.push(experience.text)

  let profileText = ''
  if (sessionId || userId) {
    const pr = await buildUserProfileRecall(policyDir, sessionId || '', userId).catch(() => ({ text: '' }))
    profileText = pr.text
    if (profileText && !experience.text.includes('用户画像')) blocks.push(profileText)
  }

  return {
    text: blocks.filter(Boolean).join('\n\n'),
    items: experience.items,
    counts: experience.counts,
    layers: {
      working: blocks.some((b) => b.includes('工作记忆')),
      semantic: Boolean(semantic),
      experience: experience.items.length > 0,
      reflection: Boolean(reflection),
      profile: Boolean(profileText)
    }
  }
}

export async function recordLayeredMemoryFromRun(
  policyDir: string,
  run: {
    sessionId?: string
    tenantId?: string
    user: string
    scenarioKey: string
    intent?: string
    failure: FailureAttribution
    successScore: number
    finalSnippet?: string
    messages?: Array<{ role: string; content: string }>
  }
) {
  if (!isLayeredMemoryEnabled()) return
  if (run.sessionId && run.messages?.length) {
    await updateWorkingMemoryFromMessages(policyDir, run.sessionId, run.messages)
  } else if (run.sessionId) {
    await updateWorkingMemoryFromSessionFile(policyDir, run.sessionId)
  }
  await appendReflectionMemory(policyDir, {
    sessionId: run.sessionId,
    tenantId: run.tenantId,
    scenarioKey: run.scenarioKey,
    failure: run.failure,
    user: run.user,
    intent: run.intent,
    successScore: run.successScore
  })
  await appendSemanticMemory(policyDir, {
    sessionId: run.sessionId,
    tenantId: run.tenantId,
    scenarioKey: run.scenarioKey,
    intent: String(run.intent || 'unknown'),
    user: run.user,
    successScore: run.successScore,
    finalSnippet: run.finalSnippet
  })
}

/** 分层记忆治理：反思去重、语义合并、过期工作记忆清理 */
export async function maybeCurateLayeredMemory(
  policyDir: string,
  opts?: { force?: boolean }
): Promise<{ ran: boolean; reflectionTrimmed?: number; semanticDeduped?: number; workingCleared?: number }> {
  if (!isLayeredMemoryEnabled() && !opts?.force) return { ran: false }

  let reflectionTrimmed = 0
  let semanticDeduped = 0
  let workingCleared = 0

  const refPath = path.join(policyDir, REFLECTION_FILE)
  const reflections = await readJsonlTail(refPath, 400)
  if (reflections.length > maxReflectionLines()) {
    const kept = reflections.slice(-maxReflectionLines())
    reflectionTrimmed = reflections.length - kept.length
    await fs.writeFile(refPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }

  const semPath = path.join(policyDir, SEMANTIC_FILE)
  const semantics = await readJsonlTail(semPath, 200)
  if (semantics.length > 15) {
    const best = new Map<string, any>()
    for (const s of semantics) {
      const k = `${s?.scenarioKey}|${summarize(String(s?.fact || ''), 80)}`
      const conf = Number(s?.confidence ?? 0)
      const prev = best.get(k)
      if (!prev || conf > Number(prev?.confidence ?? 0)) best.set(k, s)
    }
    const kept = Array.from(best.values()).slice(-100)
    semanticDeduped = semantics.length - kept.length
    if (semanticDeduped > 0) {
      await fs.writeFile(semPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    }
  }

  const workingDir = path.join(policyDir, WORKING_DIR)
  try {
    const files = await fs.readdir(workingDir)
    const ttlMs = Number(process.env.MANAGER_MEMORY_WORKING_TTL_MS ?? 7 * 86_400_000)
    const cutoff = Date.now() - (Number.isFinite(ttlMs) ? ttlMs : 7 * 86_400_000)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const fp = path.join(workingDir, f)
      const st = await fs.stat(fp)
      if (st.mtimeMs < cutoff) {
        await fs.unlink(fp).catch(() => undefined)
        workingCleared += 1
      }
    }
  } catch {}

  const ran = reflectionTrimmed > 0 || semanticDeduped > 0 || workingCleared > 0
  return { ran, reflectionTrimmed, semanticDeduped, workingCleared }
}

export async function buildLayeredMemoryDashboard(policyDir: string, sessionId?: string) {
  const reflections = await readJsonlTail(path.join(policyDir, REFLECTION_FILE), 500)
  const semantics = await readJsonlTail(path.join(policyDir, SEMANTIC_FILE), 200)
  const working = sessionId ? await loadWorkingMemory(policyDir, sessionId) : null
  let workingFileCount = 0
  try {
    const files = await fs.readdir(path.join(policyDir, WORKING_DIR))
    workingFileCount = files.filter((f: string) => f.endsWith('.json')).length
  } catch {}
  return {
    enabled: isLayeredMemoryEnabled(),
    reflectionEnabled: isReflectionMemoryEnabled(),
    semanticEnabled: isSemanticMemoryEnabled(),
    reflectionCount: reflections.filter((r) => !r?.superseded).length,
    semanticCount: semantics.length,
    workingSessions: workingFileCount,
    sessionWorking: working
      ? {
          goals: working.recentGoals.length,
          userSnippets: working.lastUserSnippets.length,
          turnCount: working.turnCount
        }
      : null
  }
}

