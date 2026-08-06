/**
 * 短剧本缓存：同 host + task_kind + goals 指纹命中历史成功 plan_steps，先 replay 再 LLM。
 * 仅写入 verify 成功轨迹；DOM 变则回退默认计划（不硬绑永久 selector）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { LobsterPlanStep, LobsterTaskGoals, LobsterTaskKind } from './lobsterTaskUnderstandSchema'

export type PlaybookRecord = {
  key: string
  host: string
  taskKind: string
  goalsFp: string
  plan_steps: LobsterPlanStep[]
  savedAt: number
  hits: number
}

function dataDir(): string {
  const fromEnv = String(process.env.LOBSTER_PLAYBOOK_DIR || '').trim()
  if (fromEnv) return fromEnv
  return path.join(process.cwd(), '.data', 'lobster')
}

function playbookPath(): string {
  return path.join(dataDir(), 'playbooks.jsonl')
}

function hostFromUrl(url?: string): string {
  const s = String(url || '').trim()
  if (!s) return ''
  try {
    return new URL(s).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function goalsFingerprint(goals?: LobsterTaskGoals | null): string {
  const g = goals || {}
  const bits = [
    g.must_leave_start ? '1' : '0',
    g.must_extract ? '1' : '0',
    g.must_submit ? '1' : '0',
    g.expected_url_change ? '1' : '0',
  ]
  return bits.join('')
}

export function playbookCacheKey(input: {
  startUrl?: string
  taskKind?: LobsterTaskKind | string | null
  goals?: LobsterTaskGoals | null
}): string {
  const host = hostFromUrl(input.startUrl)
  const kind = String(input.taskKind || 'unknown').trim().toLowerCase() || 'unknown'
  const gfp = goalsFingerprint(input.goals)
  const raw = `${host}|${kind}|${gfp}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)
}

function readAll(): PlaybookRecord[] {
  const file = playbookPath()
  if (!fs.existsSync(file)) return []
  try {
    const text = fs.readFileSync(file, 'utf8')
    const out: PlaybookRecord[] = []
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try {
        const row = JSON.parse(s) as PlaybookRecord
        if (row?.key && Array.isArray(row.plan_steps) && row.plan_steps.length) out.push(row)
      } catch {
        /* skip bad line */
      }
    }
    return out
  } catch {
    return []
  }
}

function writeAll(rows: PlaybookRecord[]): void {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  const body = rows
    .slice(-200)
    .map((r) => JSON.stringify(r))
    .join('\n')
  fs.writeFileSync(playbookPath(), body ? `${body}\n` : '', 'utf8')
}

export function lookupPlaybook(input: {
  startUrl?: string
  taskKind?: LobsterTaskKind | string | null
  goals?: LobsterTaskGoals | null
}): PlaybookRecord | null {
  if (String(process.env.LOBSTER_PLAYBOOK_CACHE ?? '1').trim() === '0') return null
  const key = playbookCacheKey(input)
  const rows = readAll()
  const hit = rows.find((r) => r.key === key)
  return hit || null
}

export function savePlaybook(input: {
  startUrl?: string
  taskKind?: LobsterTaskKind | string | null
  goals?: LobsterTaskGoals | null
  plan_steps: LobsterPlanStep[]
}): PlaybookRecord | null {
  if (String(process.env.LOBSTER_PLAYBOOK_CACHE ?? '1').trim() === '0') return null
  const steps = (input.plan_steps || [])
    .filter((s) => s && s.op)
    .slice(0, 8)
    .map((s) => ({
      op: s.op,
      ...(s.target ? { target: String(s.target).slice(0, 240) } : {}),
      ...(s.done_when ? { done_when: String(s.done_when).slice(0, 240) } : {}),
    }))
  if (!steps.length) return null
  const host = hostFromUrl(input.startUrl)
  if (!host) return null
  const key = playbookCacheKey(input)
  const rows = readAll().filter((r) => r.key !== key)
  const rec: PlaybookRecord = {
    key,
    host,
    taskKind: String(input.taskKind || 'unknown'),
    goalsFp: goalsFingerprint(input.goals),
    plan_steps: steps,
    savedAt: Date.now(),
    hits: 0,
  }
  rows.push(rec)
  writeAll(rows)
  return rec
}

/** 命中后增加 hits（可选，失败不影响主路径） */
export function touchPlaybookHit(key: string): void {
  try {
    const rows = readAll()
    const idx = rows.findIndex((r) => r.key === key)
    if (idx < 0) return
    rows[idx] = { ...rows[idx], hits: Number(rows[idx].hits || 0) + 1 }
    writeAll(rows)
  } catch {
    /* ignore */
  }
}

/** 测试用：清空缓存文件 */
export function clearPlaybookCacheForTests(): void {
  const file = playbookPath()
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
}
