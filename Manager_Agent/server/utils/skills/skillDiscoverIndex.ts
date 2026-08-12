/**
 * 已晋级 skill 的可发现索引（闭合 draft→promote→runtime 使用）。
 * 不扫脏 skills/ 目录；仅消费本索引与策展白名单 id。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type LearnedSkillIndexEntry = {
  skillId: string
  question: string
  pathAgents: string[]
  playbookPath: string
  promotedAt: string
  sourceDraftId?: string
}

const CURATED_WHITELIST = new Set([
  'router_playbook',
  'planner_playbook',
  'failure_recovery',
  'admin_capabilities',
  'gui_automation',
  'step_sanitize',
])

function indexPath(cwd = process.cwd()): string {
  return path.join(cwd, '.data', 'skill-index', 'promoted.json')
}

export function isCuratedSkillId(skillId: string): boolean {
  const id = String(skillId || '').trim()
  if (CURATED_WHITELIST.has(id)) return true
  if (id.startsWith('intent_rag_')) return true
  if (id.startsWith('learned_')) return true
  return false
}

/** 非白名单 id 归一为 learned_<hash>，避免问句 slug 污染 skills/ */
export function normalizePromotableSkillId(skillId: string, question?: string): string {
  const id = String(skillId || '').trim()
  if (isCuratedSkillId(id) && !id.includes(' ')) return id.slice(0, 64)
  const seed = `${id}|${String(question || '').slice(0, 120)}`
  const h = createHash('sha1').update(seed).digest('hex').slice(0, 12)
  return `learned_${h}`
}

export async function loadLearnedSkillIndex(cwd = process.cwd()): Promise<LearnedSkillIndexEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(cwd), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.entries) ? (parsed.entries as LearnedSkillIndexEntry[]) : []
  } catch {
    return []
  }
}

export async function upsertLearnedSkillIndex(
  entry: LearnedSkillIndexEntry,
  cwd = process.cwd()
): Promise<LearnedSkillIndexEntry[]> {
  const file = indexPath(cwd)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const prev = await loadLearnedSkillIndex(cwd)
  const next = [entry, ...prev.filter((e) => e.skillId !== entry.skillId)].slice(0, 200)
  await fs.writeFile(file, JSON.stringify({ updatedAt: new Date().toISOString(), entries: next }, null, 2), 'utf8')
  return next
}

function tokenSet(text: string): Set<string> {
  const raw = String(text || '').toLowerCase()
  const out = new Set<string>()
  // 拉丁/数字词
  for (const m of raw.match(/[a-z0-9_]{2,}/g) || []) out.add(m)
  // CJK：单字 + 双字，避免整句无空格变成单一 token 导致 Jaccard=0
  const cjk = raw.match(/[\u3400-\u9fff]/g) || []
  for (const run of cjk) {
    for (let i = 0; i < run.length; i += 1) {
      out.add(run[i]!)
      if (i + 1 < run.length) out.add(run.slice(i, i + 2))
      if (out.size >= 120) return out
    }
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** 运行时检索已晋级技能（弱 hint，不硬改 cap） */
export async function recallLearnedSkills(
  userText: string,
  opts?: { topK?: number; cwd?: string }
): Promise<Array<LearnedSkillIndexEntry & { score: number }>> {
  const q = tokenSet(userText)
  const entries = await loadLearnedSkillIndex(opts?.cwd)
  const scored = entries
    .map((e) => ({
      ...e,
      score: jaccard(q, tokenSet(`${e.question} ${e.pathAgents.join(' ')}`)),
    }))
    .filter((e) => e.score >= 0.12)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, opts?.topK ?? 3))
}

export function formatLearnedSkillHints(
  hits: Array<LearnedSkillIndexEntry & { score?: number }>
): string {
  if (!hits.length) return ''
  const lines = hits.map((h, i) => {
    const path = h.pathAgents?.length ? h.pathAgents.join('→') : '?'
    return `${i + 1}. [${h.skillId}] ${String(h.question || '').slice(0, 80)} | path=${path}`
  })
  return `\n\n## 已晋级技能提示（弱参考，不改 cap）\n${lines.join('\n')}`
}
