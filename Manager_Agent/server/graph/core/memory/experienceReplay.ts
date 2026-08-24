import fs from 'node:fs/promises'
import path from 'node:path'
import { readManagerExperienceHistory } from '../runtime/runtimePersistence'
import type { BaseMessage } from '@langchain/core/messages'
import { deriveScenarioKey, shouldSkipRouteHistoryBias } from '../text'
import { blendRecallScore, isVectorMemoryEnabled, vectorScoresForUsers } from './vectorMemory'
import { shouldSuppressExperienceReplay } from '#agent-shared/turnScope'
import {
  interactionModeFromMeta,
  interactionModeMatches,
  isModeIsolateLearningEnabled
} from '../runtime/modeIsolate'
import type { ManagerInteractionMode } from '../../../utils/platform/managerInteractionMode'
import { isEvolutionRoutingHintEnabled } from '../evolution/evolutionRoutingGate'

export type ExperienceReplayItem = {
  /** 稳定 id，便于 Trace 一眼对照是否注入 */
  id: string
  /** 记忆类型 */
  type: 'experience'
  /** 本轮排序分（含衰减/向量加权） */
  score: number
  user: string
  intent: string
  path: string[]
  successScore: number
  feedbackScore?: number
  routeConfidence?: number
  finalConfidence?: number
  scenarioKey: string
  ts?: string
  explanation: string
}

export type ExperienceReplayBundle = {
  items: ExperienceReplayItem[]
  negativeText: string
  negativeCount: number
  scenarioKey: string
}

/** 是否启用路由阶段的经验回放（默认开启；设为 `0` 关闭；convergence 模式默认不注入路由） */
export function isExperienceReplayEnabled() {
  return String(process.env.MANAGER_EXPERIENCE_REPLAY ?? '').trim() !== '0'
}

/** 路由 prompt 是否注入经验回放（须显式开启 replay 且 evolution 路由 cap 允许） */
export function isExperienceReplayRoutingEnabled(env: NodeJS.ProcessEnv = process.env) {
  return isExperienceReplayEnabled() && isEvolutionRoutingHintEnabled(env)
}

/** 是否在路由提示中注入低分/隔离负样本（默认开启；`0` 关闭） */
export function isRouterNegativeHintsEnabled() {
  return String(process.env.MANAGER_ROUTER_NEGATIVE_HINTS ?? '1').trim() !== '0'
}

function decayLambdaPerDay() {
  const raw = String(process.env.MANAGER_EXPERIENCE_DECAY_PER_DAY ?? '0.09').trim()
  if (!raw) return 0.09
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n < 0.5 ? n : 0.09
}

function parseTsMs(ts: unknown): number {
  const t = Date.parse(String(ts || ''))
  return Number.isFinite(t) ? t : 0
}

/** 越旧的经验对排序权重越低（指数衰减，不写回磁盘） */
function timeDecayForEntry(entryTs: unknown): number {
  const t0 = parseTsMs(entryTs)
  if (!t0) return 1
  const days = Math.max(0, (Date.now() - t0) / 86_400_000)
  return Math.exp(-days * decayLambdaPerDay())
}

async function readQuarantineTail(policyDir: string, maxLines: number): Promise<any[]> {
  const p = path.join(policyDir, 'manager-memory-quarantine.jsonl')
  const raw = await fs.readFile(p, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-Math.max(1, maxLines))
  const out: any[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

function tokenBag(text: string): Set<string> {
  const s = String(text || '').toLowerCase()
  const parts = s.match(/[\p{L}\p{N}_]{2,}/gu) || []
  return new Set(parts.slice(0, 120))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) {
    if (b.has(x)) inter += 1
  }
  const union = a.size + b.size - inter
  return union ? inter / union : 0
}

export type ExperienceReplayRoutingResult = {
  /** 追加进路由 SystemMessage 的段落（可能为空） */
  text: string
  /** 实际选用的条数 */
  count: number
  /** 当前问句的 scenarioKey（便于日志） */
  scenarioKey: string
  /** 低分/隔离样本避雷提示（可能为空） */
  negativeText: string
  negativeCount: number
  /** 供后续记忆写入/策略分析使用的高相关经验 */
  items: ExperienceReplayItem[]
  /** 是否使用了向量召回 */
  vectorRecall?: boolean
}

/**
 * L2：从 manager-memory 中检索与当前问句相近的历史 experience，生成路由校准用上下文。
 * 不写入模型权重，仅作少样本风格提示；关闭开关见 `MANAGER_EXPERIENCE_REPLAY=0`。
 */
function minReplayJaccard(): number {
  const raw = Number(process.env.MANAGER_EXPERIENCE_REPLAY_MIN_JACCARD ?? 0.14)
  return Number.isFinite(raw) && raw >= 0.05 && raw <= 0.55 ? raw : 0.14
}

/** 用户点「有用/无用」只应影响离线权重统计，不参与正向经验回放排序 */
function feedbackAffectsReplayRanking(): boolean {
  return String(process.env.MANAGER_FEEDBACK_AFFECTS_REPLAY ?? '0').trim() === '1'
}

export async function buildExperienceReplayForRouting(
  policyDir: string,
  queryText: string,
  opts?: {
    lastTurnOnly?: string
    attachment?: { filePath?: string; mediaType?: string } | null
    messages?: BaseMessage[]
    turnScopeMode?: string | null
    interactionMode?: ManagerInteractionMode
    meta?: unknown
  }
): Promise<ExperienceReplayRoutingResult> {
  if (!isExperienceReplayRoutingEnabled()) {
    return { text: '', count: 0, scenarioKey: '', negativeText: '', negativeCount: 0, items: [] }
  }
  if (shouldSuppressExperienceReplay(opts?.turnScopeMode)) {
    return { text: '', count: 0, scenarioKey: '', negativeText: '', negativeCount: 0, items: [] }
  }
  const lastTurn = String(opts?.lastTurnOnly || '').trim()
  if (lastTurn && shouldSkipRouteHistoryBias(lastTurn, opts?.attachment ?? null, opts?.messages)) {
    return {
      text: '',
      count: 0,
      scenarioKey: deriveScenarioKey(lastTurn || queryText),
      negativeText: '',
      negativeCount: 0,
      items: []
    }
  }
  /** 相似度只对「本轮问句」算，不用拼接了历史的 heuristicsText */
  const q = String(opts?.lastTurnOnly || queryText || '').trim()
  if (q.length < 8) {
    return { text: '', count: 0, scenarioKey: deriveScenarioKey(q), negativeText: '', negativeCount: 0, items: [] }
  }
  const scenarioKey = deriveScenarioKey(q)
  const history = await readManagerExperienceHistory(policyDir, 520)
  const activeMode = opts?.interactionMode ?? interactionModeFromMeta(opts?.meta)
  const isolateReplay = isModeIsolateLearningEnabled()
  const qBag = tokenBag(q)
  const minJac = minReplayJaccard()
  const useVector = isVectorMemoryEnabled()
  const candidateUsers: string[] = []
  for (const h of history) {
    if (!h || (h.type !== 'experience' && h.type !== 'plan_outcome')) continue
    const user = String(h.user || '').trim()
    if (user.length >= 6) candidateUsers.push(user)
  }
  const vectorSims = useVector
    ? await vectorScoresForUsers(policyDir, q, candidateUsers).catch(() => new Map<string, number>())
    : new Map<string, number>()

  type Scored = { score: number; line: string; dedupe: string; item: ExperienceReplayItem }
  const scored: Scored[] = []

  for (const h of history) {
    if (!h || h.type !== 'experience') continue
    if (isolateReplay && !interactionModeMatches(h.interactionMode, activeMode)) continue
    const user = String(h.user || '').trim()
    if (user.length < 6) continue
    const hScenario = typeof h.scenarioKey === 'string' && h.scenarioKey.trim() ? String(h.scenarioKey).trim() : deriveScenarioKey(user)
    const sceneMatch = scenarioKey && hScenario && hScenario === scenarioKey ? 1 : 0
    const jac = jaccard(qBag, tokenBag(user))
    const vecSim = vectorSims.get(user) ?? 0
    if (jac < minJac) continue
    if (useVector && vecSim < 0.42 && jac < minJac + 0.04) continue

    const succRaw = typeof h.successScore === 'number' && Number.isFinite(h.successScore) ? Math.max(0, Math.min(1, h.successScore)) : 0.62
    const decay = timeDecayForEntry(h.ts)
    const succ = succRaw * decay
    const fb = typeof h.feedbackScore === 'number' && Number.isFinite(h.feedbackScore) ? h.feedbackScore : null
    const fbAdj =
      feedbackAffectsReplayRanking() && fb != null
        ? fb >= 0.78
          ? 0.1
          : fb <= 0.32
            ? -0.12
            : 0
        : fb === 1
          ? 0.08
          : fb === 0
            ? -0.15
            : 0
    const learningBoost = h.learningQualified === true ? 0.06 : 0
    const score = useVector
      ? blendRecallScore(vecSim, jac, sceneMatch * (jac >= minJac ? 1 : 0), 0.2 * succ + fbAdj + learningBoost)
      : 0.52 * jac + 0.12 * sceneMatch * (jac >= minJac ? 1 : 0) + 0.2 * succ + fbAdj + learningBoost

    const intent = String(h.intent || '').trim() || '?'
    const pathArr = Array.isArray(h.path) ? h.path.map((x: any) => String(x ?? '').trim()).filter(Boolean) : []
    const pathStr = pathArr.length ? pathArr.join('→') : '—'
    const clauseN = Number(h.clauseCount ?? 0) || 0
    const clauseBoost = clauseN >= 2 && q.split(/[；;\n]/).length >= 2 ? 0.06 : 0
    const snippet = user.replace(/\s+/g, ' ').slice(0, 120)
    const rankScore = score + clauseBoost
    const rawId = String(h.id || h.memoryId || h.ts || '').trim()
    const id =
      rawId ||
      `exp_${hScenario.slice(0, 24)}_${Buffer.from(snippet).toString('base64url').slice(0, 16)}`
    const item: ExperienceReplayItem = {
      id,
      type: 'experience',
      score: Number(rankScore.toFixed(4)),
      user,
      intent,
      path: pathArr,
      successScore: succRaw,
      feedbackScore: fb ?? undefined,
      routeConfidence: typeof h.routeConfidence === 'number' ? h.routeConfidence : undefined,
      finalConfidence: typeof h.finalConfidence === 'number' ? h.finalConfidence : undefined,
      scenarioKey: hScenario,
      ts: typeof h.ts === 'string' ? h.ts : undefined,
      explanation: `intent=${intent}; path=${pathStr}; run质量≈${succRaw.toFixed(2)}（时效加权≈${succ.toFixed(2)}）${clauseN >= 2 ? `; 子句≈${clauseN}` : ''}; 问法摘要: ${snippet}`
    }
    scored.push({
      score: rankScore,
      line: `- [${id}] score=${rankScore.toFixed(3)} ${item.explanation}`,
      dedupe: snippet.slice(0, 72),
      item
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const lines: string[] = []
  const items: ExperienceReplayItem[] = []
  for (const row of scored) {
    if (seen.has(row.dedupe)) continue
    seen.add(row.dedupe)
    lines.push(row.line)
    items.push(row.item)
    if (lines.length >= 3) break
  }

  const recallLabel = useVector && vectorSims.size > 0 ? '向量+关键词' : '关键词'
  const text = lines.length
    ? [
        `### 历史相似任务（${recallLabel}召回；仅当与【当前用户输入】问法相近时参考；点过「有用」的历史轮次不会自动复用到无关新问句；路由 intent/allowedAgents 必须以本轮输入为准，勿照搬下列 path）`,
        ...lines
      ].join('\n')
    : ''

  /** 负样本：主记忆中低分/点踩，或隔离文件中的相似记录 */
  let negativeText = ''
  let negativeCount = 0
  if (isRouterNegativeHintsEnabled()) {
    type NScored = { score: number; line: string; dedupe: string }
    const negScored: NScored[] = []
    for (const h of history) {
      if (!h || h.type !== 'experience') continue
      const user = String(h.user || '').trim()
      if (user.length < 6) continue
      const jac = jaccard(qBag, tokenBag(user))
      if (jac < minJac) continue
      const succ = typeof h.successScore === 'number' && Number.isFinite(h.successScore) ? h.successScore : 1
      const fb = typeof h.feedbackScore === 'number' && Number.isFinite(h.feedbackScore) ? h.feedbackScore : null
      const isBad = succ < 0.42 || fb === 0
      if (!isBad) continue
      const intent = String(h.intent || '').trim() || '?'
      const pathArr = Array.isArray(h.path) ? h.path.map((x: any) => String(x ?? '').trim()).filter(Boolean) : []
      const pathStr = pathArr.length ? pathArr.join('→') : '—'
      const snippet = user.replace(/\s+/g, ' ').slice(0, 110)
      const score = 0.55 * jac + (succ < 0.35 ? 0.1 : 0)
      negScored.push({
        score,
        line: `- 曾选 intent=${intent}; path=${pathStr}; 效果差(得分≈${Number(succ).toFixed(2)}${fb === 0 ? ',反馈踩' : ''}); 相似问法: ${snippet}`,
        dedupe: `${intent}|${pathStr}|${snippet.slice(0, 48)}`
      })
    }
    for (const h of await readQuarantineTail(policyDir, 100)) {
      const user = String(h?.user || '').trim()
      if (user.length < 6) continue
      const jac = jaccard(qBag, tokenBag(user))
      if (jac < minJac) continue
      const intent = String(h.intent || '').trim() || '?'
      const pathArr = Array.isArray(h.path) ? h.path.map((x: any) => String(x ?? '').trim()).filter(Boolean) : []
      const pathStr = pathArr.length ? pathArr.join('→') : '—'
      const snippet = user.replace(/\s+/g, ' ').slice(0, 110)
      const reason = String(h.quarantineReason || 'quarantine').slice(0, 24)
      negScored.push({
        score: 0.55 * jac,
        line: `- [隔离] intent=${intent}; path=${pathStr}; 原因=${reason}; 相似问法: ${snippet}`,
        dedupe: `q|${intent}|${snippet.slice(0, 48)}`
      })
    }
    negScored.sort((a, b) => b.score - a.score)
    const nSeen = new Set<string>()
    const nLines: string[] = []
    for (const row of negScored) {
      if (nSeen.has(row.dedupe)) continue
      nSeen.add(row.dedupe)
      nLines.push(row.line)
      if (nLines.length >= 2) break
    }
    if (nLines.length) {
      negativeCount = nLines.length
      negativeText = ['### 历史负样本（仅供路由避雷：以下路线在历史中效果差或被隔离；若与当前用户明确意图冲突，以当前为准）', ...nLines].join('\n')
    }
  }

  return {
    text,
    count: lines.length,
    scenarioKey,
    negativeText,
    negativeCount,
    items,
    vectorRecall: useVector && vectorSims.size > 0
  }
}
