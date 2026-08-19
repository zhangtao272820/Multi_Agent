/**
 * 从 TurnGroup 派生活动时间线条目（Cursor 式：模式 / 计划 / 路由 / 步骤 / HITL）。
 * 纯函数，不依赖 Vue。
 */
import type {
  CollaborationPosture,
  TurnGroup,
  WorkbenchMode
} from '~/composables/managerChatTypes'
import { collaborationPostureLabel } from '~/composables/managerChatTypes'
import { agentDisplayLabel, agentToneClass } from '~/composables/managerAgentDisplay'

export type TurnActivityKind = 'posture' | 'plan' | 'route' | 'step' | 'hitl'

export type TurnActivityStepStatus = 'pending' | 'running' | 'success' | 'failed'

export type TurnActivityItem = {
  id: string
  kind: TurnActivityKind
  title: string
  detail?: string
  agent?: string
  agentTone?: string
  status?: TurnActivityStepStatus
  posture?: CollaborationPosture | string
  agents?: string[]
}

export type PipelineStepLike = {
  id: string
  agent: string
  label: string
  status: string
  query?: string
  summary?: string
}

export type BuildTurnActivityInput = {
  turn: TurnGroup
  workbenchMode: WorkbenchMode
  steps: PipelineStepLike[]
  routeAgents?: string[]
  posture?: CollaborationPosture
  postureNote?: string
  /** 编排建议姿态（来自 plan_preview.suggestedPosture） */
  suggestedPosture?: CollaborationPosture | string
  /** 本轮仍在等计划确认 */
  awaitingPlanConfirm?: boolean
  planStepCount?: number
  hitlTitle?: string
  hitlAgent?: string
  /** 用户气泡已展示姿态徽章时，跳过重复的「已切到 X」 */
  skipUserPostureBadge?: boolean
}

function statusLabel(status: string): TurnActivityStepStatus {
  if (status === 'running') return 'running'
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  return 'pending'
}

export function buildTurnActivityItems(input: BuildTurnActivityInput): TurnActivityItem[] {
  const professional = input.workbenchMode === 'professional'
  const items: TurnActivityItem[] = []
  const posture = input.posture

  if (posture && posture !== 'agent' && !input.skipUserPostureBadge) {
    items.push({
      id: 'posture-user',
      kind: 'posture',
      title: `协作姿态 · ${collaborationPostureLabel(posture)}`,
      detail: input.postureNote || undefined,
      posture
    })
  } else if (input.postureNote) {
    items.push({
      id: 'posture-note',
      kind: 'posture',
      title: input.postureNote,
      posture: posture || undefined
    })
  }

  if (input.suggestedPosture) {
    const sp = String(input.suggestedPosture).toLowerCase()
    if (sp && sp !== String(posture || '').toLowerCase()) {
      items.push({
        id: 'posture-suggest',
        kind: 'posture',
        title: `编排建议切到 ${collaborationPostureLabel(sp)}`,
        posture: sp
      })
    }
  }

  if (input.awaitingPlanConfirm) {
    const n = input.planStepCount || 0
    items.push({
      id: 'plan-await',
      kind: 'plan',
      title: n > 0 ? `等待确认蓝图 · ${n} 步` : '等待确认蓝图',
      detail: professional ? '批准前不会执行写操作' : undefined
    })
  } else if (posture === 'plan' && !input.steps.length) {
    items.push({
      id: 'plan-align',
      kind: 'plan',
      title: 'Plan：对齐蓝图中',
      detail: professional ? '确认后才执行' : undefined
    })
  }

  const agents = (input.routeAgents || []).filter(Boolean)
  if (agents.length) {
    items.push({
      id: 'route',
      kind: 'route',
      title: '专才路由',
      agents
    })
  }

  if (professional) {
    for (const step of input.steps) {
      items.push({
        id: `step-${step.id}`,
        kind: 'step',
        title: agentDisplayLabel(step.agent, true) || step.label,
        detail: [step.query, step.summary].filter(Boolean).join(' · ') || undefined,
        agent: step.agent,
        agentTone: agentToneClass(step.agent),
        status: statusLabel(step.status)
      })
    }
  } else if (input.steps.length) {
    const running = input.steps.find((s) => s.status === 'running')
    const failed = input.steps.find((s) => s.status === 'failed')
    const current = running || failed || input.steps[input.steps.length - 1]
    if (current) {
      const done = input.steps.filter((s) => s.status === 'success').length
      items.push({
        id: `step-compact-${current.id}`,
        kind: 'step',
        title: `${agentDisplayLabel(current.agent, false)} · ${
          current.status === 'running'
            ? '进行中'
            : current.status === 'failed'
              ? '失败'
              : current.status === 'success'
                ? '完成'
                : '等待'
        }`,
        detail: `${done}/${input.steps.length} 步`,
        agent: current.agent,
        agentTone: agentToneClass(current.agent),
        status: statusLabel(current.status)
      })
    }
  }

  if (input.hitlTitle) {
    items.push({
      id: 'hitl',
      kind: 'hitl',
      title: professional ? input.hitlTitle : '需要确认',
      detail: professional && input.hitlAgent
        ? agentDisplayLabel(input.hitlAgent, true)
        : input.hitlAgent
          ? agentDisplayLabel(input.hitlAgent, false)
          : undefined,
      agent: input.hitlAgent,
      agentTone: input.hitlAgent ? agentToneClass(input.hitlAgent) : undefined
    })
  }

  return items
}

export function turnHasActivity(items: TurnActivityItem[], steps: PipelineStepLike[]): boolean {
  return items.length > 0 || steps.length > 0
}
