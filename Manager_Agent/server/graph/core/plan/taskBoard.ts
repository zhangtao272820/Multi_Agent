/**
 * 共享任务板（Phase C）：由 plan steps 确定性投影，供观测 / 续轮 / 父会话。
 * 不新开 LLM；异步专才 = optional 媒体步，不阻塞 hub 主链验收。
 */
import type { Step } from '../../../utils/shared/taskPlan'

export type TaskBoardStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'replan'

export type TaskBoardItem = {
  id: string
  agent: string
  query: string
  status: TaskBoardStatus
  optional?: boolean
  async?: boolean
  dependsOn?: string[]
  /** 验收/失败原因（内部）；UI 须 humanize */
  reason?: string
}

const ASYNC_AGENT_SET = new Set<string>([])

export function isAsyncSpecialistAgent(agent: unknown): boolean {
  // Music/Video 已踢出集群；保留钩子供未来 optional 专才，当前无默认 async
  return ASYNC_AGENT_SET.has(String(agent || '').trim().toLowerCase())
}

export function buildTaskBoardFromSteps(
  steps: Step[],
  completedById?: Record<string, { status?: string } | undefined>
): TaskBoardItem[] {
  const done = completedById && typeof completedById === 'object' ? completedById : {}
  return (Array.isArray(steps) ? steps : []).map((s) => {
    const id = String(s.id || '').trim()
    const agent = String(s.agent || '').trim()
    const rec = id ? done[id] : undefined
    const st = String(rec?.status || '').trim()
    let status: TaskBoardStatus = 'pending'
    if (st === 'ok' || st === 'success') status = 'success'
    else if (st === 'error' || st === 'failed') status = 'failed'
    else if (st === 'skipped') status = 'skipped'
    else if (st === 'running') status = 'running'
    else if (st === 'replan') status = 'replan'
    const optional = Boolean(s.optional)
    const async = optional && isAsyncSpecialistAgent(agent)
    return {
      id: id || `agent:${agent}`,
      agent,
      query: String(s.query || '').slice(0, 240),
      status,
      ...(optional ? { optional: true } : {}),
      ...(async ? { async: true } : {}),
      ...(Array.isArray(s.dependsOn) && s.dependsOn.length
        ? { dependsOn: s.dependsOn.map((d) => String(d)).slice(0, 8) }
        : {})
    }
  })
}

/** 主链是否可收束：忽略 async / optional 未完成项；replan/pending/running 未验收则未完成 */
export function taskBoardMainPathComplete(board: TaskBoardItem[]): boolean {
  const main = board.filter((b) => !b.async && !b.optional)
  if (!main.length) {
    return board.every(
      (b) =>
        b.status === 'success' ||
        b.status === 'skipped' ||
        b.optional ||
        b.status === 'failed'
    )
  }
  return main.every(
    (b) => b.status === 'success' || b.status === 'skipped' || b.status === 'failed'
  )
}

/** 投影完成态时应用 Acceptance 结果（success 步若未验收 → replan） */
export function applyAcceptanceToBoardItem(
  item: TaskBoardItem,
  accepted: boolean,
  boardStatus: TaskBoardStatus
): TaskBoardItem {
  if (item.optional || item.async) return item
  if (accepted && boardStatus === 'success') return { ...item, status: 'success' }
  if (!accepted && (boardStatus === 'replan' || boardStatus === 'failed')) {
    return { ...item, status: boardStatus }
  }
  return item
}

export function formatTaskBoardForParent(board: TaskBoardItem[], max = 8): string {
  const rows = (Array.isArray(board) ? board : []).slice(0, Math.max(1, max))
  if (!rows.length) return ''
  return [
    '【任务板】',
    ...rows.map((b) => {
      const flags = [b.async ? 'async' : '', b.optional ? 'opt' : ''].filter(Boolean).join(',')
      return `- [${b.status}] ${b.agent}${flags ? `(${flags})` : ''}: ${b.query.slice(0, 80)}`
    })
  ].join('\n')
}
