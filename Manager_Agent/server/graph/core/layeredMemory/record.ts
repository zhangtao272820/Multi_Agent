import fs from 'node:fs/promises'
import path from 'node:path'
import { readManagerMemoryEntries } from '#agent-shared/managerMemoryHistory'
import { recordMemory } from '#agent-shared/agentMemoryApi'
import { deriveScenarioKey } from '../text'
import { buildLongMemoryRecall, type LongMemoryItem } from '../memory/longMemory'
import { buildUserProfileRecall } from '../memory/userProfile'
import type { FailureAttribution } from '../evolution/failureAttribution'



export type MemoryLayer = 'working' | 'semantic' | 'experience' | 'reflection'

export type ReflectionRecord = {
  ts: string
  sessionId?: string
  scenarioKey: string
  category: string
  lesson: string
  intent?: string
  userSummary: string
  successScore?: number
  severity?: string
  superseded?: boolean
}

export type SemanticRecord = {
  ts: string
  scenarioKey: string
  intent: string
  fact: string
  confidence: number
  sessionId?: string
}

export type WorkingMemoryRecord = {
  sessionId: string
  updatedAt: string
  recentGoals: string[]
  lastUserSnippets: string[]
  lastAssistantSnippets: string[]
  turnCount: number
}

export const REFLECTION_FILE = 'manager-memory-reflections.jsonl'
export const SEMANTIC_FILE = 'manager-memory-semantic.jsonl'
export const WORKING_DIR = 'memory-working'

export function isLayeredMemoryEnabled() {
  return String(process.env.MANAGER_LAYERED_MEMORY ?? '1').trim() !== '0'
}

export function isReflectionMemoryEnabled() {
  if (!isLayeredMemoryEnabled()) return false
  return String(process.env.MANAGER_MEMORY_REFLECT ?? '1').trim() !== '0'
}

export function isSemanticMemoryEnabled() {
  if (!isLayeredMemoryEnabled()) return false
  return String(process.env.MANAGER_MEMORY_SEMANTIC ?? '1').trim() !== '0'
}

function maxWorkingTurns() {
  const n = Number(process.env.MANAGER_MEMORY_WORKING_TURNS ?? 8)
  return Number.isFinite(n) && n >= 2 ? Math.min(20, Math.floor(n)) : 8
}

export function maxReflectionLines() {
  const n = Number(process.env.MANAGER_MEMORY_REFLECTION_MAX ?? 80)
  return Number.isFinite(n) && n >= 10 ? Math.min(300, Math.floor(n)) : 80
}

export function summarize(text: string, max = 140) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function tokenBag(text: string): Set<string> {
  const s = String(text || '').toLowerCase()
  const parts = s.match(/[\p{L}\p{N}_]{2,}/gu) || []
  return new Set(parts.slice(0, 120))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

export async function readJsonlTail(filePath: string, maxLines: number): Promise<any[]> {
  const raw = await fs.readFile(filePath, 'utf8').catch(() => '')
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

async function appendJsonl(filePath: string, row: Record<string, unknown>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined)
  await fs.appendFile(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, 'utf8')
}

function workingPath(policyDir: string, sessionId: string) {
  return path.join(policyDir, WORKING_DIR, `${sessionId}.json`)
}

export async function loadWorkingMemory(policyDir: string, sessionId: string): Promise<WorkingMemoryRecord | null> {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  try {
    const raw = await fs.readFile(workingPath(policyDir, sid), 'utf8')
    const o = JSON.parse(raw)
    return {
      sessionId: sid,
      updatedAt: String(o?.updatedAt || new Date().toISOString()),
      recentGoals: Array.isArray(o?.recentGoals) ? o.recentGoals.map(String).filter(Boolean).slice(0, 6) : [],
      lastUserSnippets: Array.isArray(o?.lastUserSnippets) ? o.lastUserSnippets.map(String).slice(0, maxWorkingTurns()) : [],
      lastAssistantSnippets: Array.isArray(o?.lastAssistantSnippets)
        ? o.lastAssistantSnippets.map(String).slice(0, maxWorkingTurns())
        : [],
      turnCount: Number(o?.turnCount ?? 0) || 0
    }
  } catch {
    return null
  }
}

export async function updateWorkingMemoryFromMessages(
  policyDir: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>
) {
  if (!isLayeredMemoryEnabled()) return
  const sid = String(sessionId || '').trim()
  if (!sid || !messages?.length) return

  const users = messages.filter((m) => m.role === 'user').map((m) => summarize(m.content, 160))
  const assistants = messages.filter((m) => m.role === 'assistant').map((m) => summarize(m.content, 200))
  const prev = await loadWorkingMemory(policyDir, sid)
  const recentGoals = [...(prev?.recentGoals || [])]
  const lastUser = users.slice(-maxWorkingTurns())
  const lastAssistant = assistants.slice(-maxWorkingTurns())

  const GOAL_ACTION_MARKERS = ['需要', '请', '帮我', '整理', '修复', '完成', '推进', '查询', '生成'] as const

  const lastUserMsg = users[users.length - 1]
  if (lastUserMsg && GOAL_ACTION_MARKERS.some((m) => lastUserMsg.includes(m))) {
    const g = summarize(lastUserMsg, 100)
    if (g && !recentGoals.includes(g)) recentGoals.unshift(g)
  }

  const record: WorkingMemoryRecord = {
    sessionId: sid,
    updatedAt: new Date().toISOString(),
    recentGoals: recentGoals.slice(0, 5),
    lastUserSnippets: lastUser,
    lastAssistantSnippets: lastAssistant,
    turnCount: messages.length
  }
  await fs.mkdir(path.join(policyDir, WORKING_DIR), { recursive: true }).catch(() => undefined)
  await fs.writeFile(workingPath(policyDir, sid), JSON.stringify(record, null, 2), 'utf8')
}

export async function updateWorkingMemoryFromSessionFile(policyDir: string, sessionId: string) {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  try {
    const p = path.join(policyDir, 'sessions', `${sid}.json`)
    const raw = await fs.readFile(p, 'utf8')
    const o = JSON.parse(raw)
    const messages = Array.isArray(o?.messages) ? o.messages : []
    await updateWorkingMemoryFromMessages(
      policyDir,
      sid,
      messages.map((m: any) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content ?? '') }))
    )
  } catch {}
}

export async function appendReflectionMemory(
  policyDir: string,
  entry: {
    sessionId?: string
    tenantId?: string
    scenarioKey: string
    failure: FailureAttribution
    user: string
    intent?: string
    successScore?: number
  }
) {
  if (!isReflectionMemoryEnabled()) return
  if (entry.failure.category === 'success') return
  // 纯库空结果不写反思，避免回灌「应澄清/换 Agent」污染后续编排
  const reasons = entry.failure.reasons || []
  if (
    reasons.length > 0 &&
    reasons.every((r) => /db no data|empty_result|business outcome/i.test(String(r)))
  ) {
    return
  }
  const lesson = buildLessonFromFailure(entry.failure)
  if (!lesson) return
  const row: ReflectionRecord = {
    ts: new Date().toISOString(),
    sessionId: entry.sessionId,
    scenarioKey: entry.scenarioKey,
    category: entry.failure.category,
    lesson,
    intent: entry.intent,
    userSummary: summarize(entry.user, 120),
    successScore: entry.successScore,
    severity: entry.failure.severity
  }
  await appendJsonl(path.join(policyDir, REFLECTION_FILE), row as unknown as Record<string, unknown>)
  await recordMemory(
    {
      type: 'reflection',
      agent: 'manager',
      tenantId: entry.tenantId,
      sessionId: entry.sessionId,
      successScore: entry.successScore,
      payload: { ...row, tenantId: entry.tenantId } as unknown as Record<string, unknown>
    },
    process.env
  ).catch(() => undefined)
}

function buildLessonFromFailure(failure: FailureAttribution): string {
  const cat = failure.category
  const reasons = (failure.reasons || []).slice(0, 2).join('；')
  const templates: Record<string, string> = {
    clarify_needed: '缺少关键约束时应先澄清，不要强行编排多步。',
    route_error: '路由置信度低时应提高澄清阈值或复用相似成功样本。',
    plan_error: '多步计划应拆成可独立执行的子 query，避免把输出格式塞进检索步。',
    tool_failure: '工具失败时应降级或切换备选 Agent，并记录健康状态。',
    evidence_gap: '报告/综合前须先有 db/rag/crawler 证据步骤。',
    synthesis_error: '有子 Agent 结果但无 final 时，检查 synth 是否误拒媒体或截断。',
    verification_gap: '声明须有 evidence 支撑，unsupported claims 须剔除或标注假设。',
    policy_boundary: '超出能力边界时只给步骤建议，不假装已执行。',
    timeout: '步骤过多或并行过高时，应减少 plan 步数或降低 maxParallel。',
    unclear: reasons ? `未明失败：${reasons}` : '失败原因未明，建议回看路由与 plan。'
  }
  const base = templates[cat] || templates.unclear
  return reasons && !base.includes(reasons) ? `${base}（${reasons}）` : base
}

export async function appendSemanticMemory(
  policyDir: string,
  entry: {
    sessionId?: string
    tenantId?: string
    scenarioKey: string
    intent: string
    user: string
    successScore: number
    finalSnippet?: string
  }
) {
  if (!isSemanticMemoryEnabled()) return
  if (entry.successScore < 0.72) return
  const fact = summarize(entry.finalSnippet || entry.user, 160)
  if (fact.length < 12) return
  const row: SemanticRecord = {
    ts: new Date().toISOString(),
    sessionId: entry.sessionId,
    scenarioKey: entry.scenarioKey,
    intent: String(entry.intent || 'unknown'),
    fact,
    confidence: Math.min(0.95, entry.successScore)
  }
  await appendJsonl(path.join(policyDir, SEMANTIC_FILE), row as unknown as Record<string, unknown>)
  await recordMemory(
    {
      type: 'semantic',
      agent: 'manager',
      tenantId: entry.tenantId,
      sessionId: entry.sessionId,
      successScore: entry.successScore,
      payload: { ...row, tenantId: entry.tenantId } as unknown as Record<string, unknown>
    },
    process.env
  ).catch(() => undefined)
}

