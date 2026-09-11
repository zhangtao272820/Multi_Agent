/**
 * 执行拓扑：solo | parallel | hub（学成熟 Agent 的任务自适应，非关键词路由）。
 * - solo：单专才 / 单源 → maxParallel=1
 * - parallel：多取数面无序依赖 → 尽量 fan-out
 * - hub：有依赖的多步（默认）→ DAG + 有界并行
 */
import type { Step } from '../../../utils/shared/taskPlan'
import { DATA_PARALLEL_AGENTS, suggestMaxParallelForPlan, getManagerMaxParallel } from './planParallel'

export type ExecutionTopology = 'solo' | 'parallel' | 'hub'

const TOPOLOGIES = new Set<string>(['solo', 'parallel', 'hub'])

/**
 * LLM 枚举近邻归一（schema 修复，非用户原话路由）。
 * 例：parallel_hub → hub；fanout → parallel。
 */
export function coerceExecutionTopology(raw: unknown): ExecutionTopology | null {
  const t = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (!t) return null
  if (TOPOLOGIES.has(t)) return t as ExecutionTopology
  // hub 优先于 parallel，使 parallel_hub / hub_parallel 落到有依赖的 DAG
  if (t.includes('hub') || t.includes('dag') || t.includes('pipeline') || t.includes('serial')) {
    return 'hub'
  }
  if (t.includes('solo') || t === 'single' || t.includes('single_agent') || t.includes('one_shot')) {
    return 'solo'
  }
  if (t.includes('parallel') || t.includes('fanout') || t.includes('fan_out') || t.includes('concurrent')) {
    return 'parallel'
  }
  return null
}

/**
 * 优先采信编排 LLM 字段；否则用结构信号派生（厚度 / agents / 蓝图依赖）。
 */
export function resolveExecutionTopology(input: {
  executionTopology?: unknown
  isMulti?: boolean
  allowedAgents?: string[]
  orchestrationThickness?: string
  planSteps?: Array<{ agent?: string; dependsOn?: string[]; dependsOnAgents?: string[] }>
}): ExecutionTopology {
  const forced = coerceExecutionTopology(input.executionTopology)
  if (forced) return forced

  const thickness = String(input.orchestrationThickness || '').trim()
  if (thickness === 'memory_capture' || thickness === 'single_source') return 'solo'

  const agents = (input.allowedAgents || []).map((a) => String(a || '').trim()).filter(Boolean)
  if (!input.isMulti && agents.length <= 1) return 'solo'
  if (agents.length <= 1) return 'solo'

  const steps = Array.isArray(input.planSteps) ? input.planSteps : []
  const dataAgents = agents.filter((a) => DATA_PARALLEL_AGENTS.has(a as Step['agent']))
  const hasCrossDeps = steps.some((s) => {
    const deps = Array.isArray(s.dependsOn)
      ? s.dependsOn
      : Array.isArray(s.dependsOnAgents)
        ? s.dependsOnAgents
        : []
    return deps.length > 0
  })

  if (dataAgents.length >= 2 && !hasCrossDeps && agents.every((a) => DATA_PARALLEL_AGENTS.has(a as Step['agent']) || a === 'admin')) {
    return 'parallel'
  }
  if (dataAgents.length >= 2 && agents.length <= dataAgents.length + 1 && !hasCrossDeps) {
    return 'parallel'
  }
  return 'hub'
}

/** multi 调度：按拓扑收紧 / 放开并发 */
export function resolveMaxParallelForTopology(input: {
  topology: ExecutionTopology
  steps: Step[]
  executionMode?: string
  schedulerMaxParallel?: number
  policyMaxParallel?: number
}): number {
  if (String(input.executionMode || '') === 'serial' || input.topology === 'solo') return 1
  const cap = getManagerMaxParallel()
  const policy = Math.max(1, Number(input.policyMaxParallel || 3) || 3)
  const sched = Number(input.schedulerMaxParallel || 0)
  let base = Math.max(1, Math.min(cap, sched > 0 ? sched : policy))
  const suggested = suggestMaxParallelForPlan(input.steps)
  if (suggested > 0) base = Math.max(base, suggested)
  if (input.topology === 'parallel') {
    base = Math.max(base, Math.min(cap, suggested || input.steps.length))
  }
  return Math.min(cap, Math.max(1, base))
}
