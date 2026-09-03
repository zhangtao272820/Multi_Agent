/**
 * lob_gui_experience 回读 — 路由/规划阶段注入相似 GUI 任务经验
 * 仅召回用户点「有用」确认的行（status=confirmed + useful source）。
 */

import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import { normalizeDbQuestionKey } from './dbExperienceBridge'
import { isConfirmedExperienceRow, isExperienceRecallConfirmedOnly } from './experienceRecallPolicy'

export type GuiExperienceRow = {
  id: number
  taskNorm: string
  scenario?: string
  executionMode?: string
  hint: string
  score: number
}

export function isGuiExperienceReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_GUI_EXPERIENCE_READ ?? '1').trim() !== '0'
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeDbQuestionKey(a).match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g) ?? [])
  const tb = new Set(normalizeDbQuestionKey(b).match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/g) ?? [])
  if (!ta.size || !tb.size) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++
  return hit / Math.max(ta.size, tb.size)
}

export async function recallGuiExperience(
  question: string,
  opts?: { limit?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<GuiExperienceRow[]> {
  if (!isGuiExperienceReadEnabled(env) || !isAgentPgConfigured(env)) return []
  const q = String(question || '').trim()
  const taskNorm = normalizeDbQuestionKey(q)
  if (!taskNorm) return []
  const limit = Math.max(1, Math.min(8, opts?.limit ?? 3))

  const prefix = taskNorm.slice(0, Math.min(24, taskNorm.length))
  const res = await agentPgQuery<{
    id: string
    task_norm: string
    scenario: string | null
    execution_mode: string | null
    hint: string
    source: string | null
    status: string | null
  }>(
    `SELECT id::text, task_norm, scenario, execution_mode, hint, source, status
     FROM lob_gui_experience
     WHERE status = 'confirmed'
       AND (task_norm = $1 OR task_norm LIKE $2)
     ORDER BY ts DESC
     LIMIT $3`,
    [taskNorm, `${prefix}%`, Math.min(limit * 6, 24)],
    env
  ).catch(() => null)

  const rows = res?.rows ?? []
  const requireUseful = isExperienceRecallConfirmedOnly(env)
  const scored = rows
    .filter((r) => {
      if (!requireUseful) return true
      return isConfirmedExperienceRow({
        source: String(r.source || ''),
        status: String(r.status || ''),
        userConfirmed: String(r.source || '').includes('manager_feedback_confirmed')
      })
    })
    .map((r) => ({
      id: Number(r.id) || 0,
      taskNorm: String(r.task_norm || ''),
      scenario: r.scenario ? String(r.scenario) : undefined,
      executionMode: r.execution_mode ? String(r.execution_mode) : undefined,
      hint: String(r.hint || '').trim(),
      score: tokenOverlap(q, String(r.task_norm || ''))
    }))
    .filter((r) => r.hint)
    .sort((a, b) => b.score - a.score)

  const out: GuiExperienceRow[] = []
  const seen = new Set<string>()
  for (const row of scored) {
    if (seen.has(row.taskNorm)) continue
    seen.add(row.taskNorm)
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

export function formatGuiExperienceBlock(rows: GuiExperienceRow[]): string {
  if (!rows.length) return ''
  const lines = rows.map((r, i) => {
    const engine = r.executionMode ? `引擎=${r.executionMode}` : ''
    const scenario = r.scenario ? `场景=${r.scenario}` : ''
    const meta = [engine, scenario].filter(Boolean).join('，')
    return `${i + 1}. ${meta ? `（${meta}）` : ''}${r.hint.slice(0, 160)}`
  })
  return [
    '### GUI 任务经验（相似历史 run，供路由/规划参考；仅「有用」确认）',
    '若任务语义匹配，可建议 allowedAgents 含 gui，并优先 engineHint/storageProfile：',
    ...lines
  ].join('\n')
}
