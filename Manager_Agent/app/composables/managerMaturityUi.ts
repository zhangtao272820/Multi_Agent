/**
 * 成熟执行 UI：人话标签 + 类型（纯函数，可供 smoke）。
 * 用户面禁 raw code；侧栏可用略偏指标的中文。
 */

export type TaskBoardStatusUi = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'replan'

export type TaskBoardItemUi = {
  id: string
  agent: string
  query: string
  status: TaskBoardStatusUi
  optional?: boolean
  async?: boolean
  dependsOn?: string[]
  /** 验收/失败原因（内部码）；展示前必须 humanize */
  reason?: string
}

export type MaturitySliUi = {
  stepsTotal: number
  stepsAccepted: number
  stepsReplan: number
  stepsFailed: number
  acceptanceRate: number
  briefAttached: number
  specialistRoundsP95: number
  localReplanCount: number
  raceEnabled: boolean
}

const STATUS_ZH: Record<TaskBoardStatusUi, string> = {
  pending: '等待中',
  running: '进行中',
  success: '已完成',
  failed: '未完成',
  skipped: '已跳过',
  replan: '调整中'
}

/** 用户面 / 侧栏共用步进状态中文 */
export function stepBoardStatusLabelZh(status: string): string {
  const s = String(status || '').trim().toLowerCase()
  if (s === 'ok') return STATUS_ZH.success
  if (s in STATUS_ZH) return STATUS_ZH[s as TaskBoardStatusUi]
  if (s.includes('replan')) return STATUS_ZH.replan
  if (s.includes('run')) return STATUS_ZH.running
  if (s.includes('fail') || s.includes('error')) return STATUS_ZH.failed
  if (s.includes('skip')) return STATUS_ZH.skipped
  if (s.includes('success') || s.includes('done')) return STATUS_ZH.success
  return STATUS_ZH.pending
}

/**
 * Acceptance / observation 内部码 → 用户可读短句（禁暴露 empty_evidence 等原码）。
 */
export function humanizeAcceptanceReason(reason: string | null | undefined): string {
  const r = String(reason || '').trim().toLowerCase()
  if (!r || r === 'ok' || r === 'optional') return ''
  if (r.includes('empty') || r.includes('no_hit') || r.includes('no_row')) {
    return '未找到有效结果，正在调整查询'
  }
  if (r.includes('clarify') || r.includes('needs_clarify')) {
    return '还需要一点信息才能继续'
  }
  if (r.includes('protocol') || r.includes('malformed')) {
    return '返回格式异常，正在重试'
  }
  if (r.includes('self_check') || r.startsWith('gaps:') || r.includes('gap')) {
    return '结果未通过自检，正在补全'
  }
  if (r.includes('timeout')) return '处理超时，正在换种方式'
  if (r.includes('circuit')) return '该专才暂时不可用，已调整计划'
  if (r.includes('status_failed') || r.includes('ok_false') || r.includes('error')) {
    return '本步未成功，正在调整'
  }
  if (r.includes('replan') || r.includes('verify_replan')) {
    return '执行未达预期，正在有界重规划'
  }
  // 未知码：笼统提示，不原样抛内部串
  return '本步需要调整后再继续'
}

export function topologyLabelZh(topology: string | null | undefined): string {
  const t = String(topology || '').trim().toLowerCase()
  if (t === 'parallel') return '并行协同'
  if (t === 'hub') return '主从协同'
  if (t === 'solo') return '单步直达'
  return t ? '智能编排' : ''
}

export function formatAcceptanceRateZh(rate: number): string {
  const n = Number(rate)
  if (!Number.isFinite(n)) return '—'
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`
}

export function parseTaskBoardPayload(raw: unknown): {
  items: TaskBoardItemUi[]
  topology: string
} | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const itemsRaw = Array.isArray(p.items) ? p.items : []
  const items: TaskBoardItemUi[] = itemsRaw
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const r = row as Record<string, unknown>
      const id = String(r.id || '').trim()
      const agent = String(r.agent || '').trim()
      if (!id && !agent) return null
      const st = String(r.status || 'pending').toLowerCase() as TaskBoardStatusUi
      const status: TaskBoardStatusUi =
        st === 'running' ||
        st === 'success' ||
        st === 'failed' ||
        st === 'skipped' ||
        st === 'replan'
          ? st
          : 'pending'
      return {
        id: id || `agent:${agent}`,
        agent: agent || 'unknown',
        query: String(r.query || '').slice(0, 240),
        status,
        ...(r.optional === true ? { optional: true } : {}),
        ...(r.async === true ? { async: true } : {}),
        ...(Array.isArray(r.dependsOn)
          ? { dependsOn: r.dependsOn.map((x) => String(x)).slice(0, 8) }
          : {}),
        ...(String(r.reason || '').trim() ? { reason: String(r.reason).trim().slice(0, 120) } : {})
      } satisfies TaskBoardItemUi
    })
    .filter(Boolean) as TaskBoardItemUi[]
  return {
    items,
    topology: String(p.topology || '').trim()
  }
}

export function parseMaturitySliPayload(raw: unknown): MaturitySliUi | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const num = (k: string) => {
    const n = Number(p[k])
    return Number.isFinite(n) ? n : 0
  }
  return {
    stepsTotal: Math.max(0, Math.floor(num('stepsTotal'))),
    stepsAccepted: Math.max(0, Math.floor(num('stepsAccepted'))),
    stepsReplan: Math.max(0, Math.floor(num('stepsReplan'))),
    stepsFailed: Math.max(0, Math.floor(num('stepsFailed'))),
    acceptanceRate: Math.min(1, Math.max(0, num('acceptanceRate'))),
    briefAttached: Math.max(0, Math.floor(num('briefAttached'))),
    specialistRoundsP95: Math.max(0, num('specialistRoundsP95')),
    localReplanCount: Math.max(0, Math.floor(num('localReplanCount'))),
    raceEnabled: p.raceEnabled === true
  }
}

/**
 * 任务板 reason → 按 agent 的人话 tip（仅 replan/failed；禁 raw code）。
 * SpecialistCards / 进度条共用。
 */
export function humanizedBoardTipsByAgent(
  items: TaskBoardItemUi[] | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const it of items || []) {
    if (it.status !== 'replan' && it.status !== 'failed') continue
    const tip = humanizeAcceptanceReason(it.reason)
    if (!tip) continue
    const key = String(it.agent || '')
      .trim()
      .toLowerCase()
    if (!key) continue
    out[key] = tip
  }
  return out
}

/** 用 step_status 补丁任务板某一行 */
export function patchTaskBoardItemStatus(
  items: TaskBoardItemUi[],
  patch: { stepId?: string; agent?: string; status?: string; error?: string; query?: string }
): TaskBoardItemUi[] {
  const sid = String(patch.stepId || '').trim()
  const agent = String(patch.agent || '').trim().toLowerCase()
  const stRaw = String(patch.status || '').toLowerCase()
  let status: TaskBoardStatusUi = 'pending'
  if (stRaw === 'ok' || stRaw === 'success') status = 'success'
  else if (stRaw === 'failed' || stRaw === 'error') status = 'failed'
  else if (stRaw === 'running') status = 'running'
  else if (stRaw === 'skipped') status = 'skipped'
  else if (stRaw === 'replan') status = 'replan'
  else if (stRaw === 'pending') status = 'pending'
  else return items

  const reason = String(patch.error || '').trim()
  let hit = false
  const next = items.map((it) => {
    if ((sid && it.id === sid) || (!sid && agent && it.agent.toLowerCase() === agent)) {
      hit = true
      return {
        ...it,
        status,
        ...(patch.query ? { query: String(patch.query).slice(0, 240) } : {}),
        ...(reason ? { reason: reason.slice(0, 120) } : {})
      }
    }
    return it
  })
  return hit ? next : items
}
