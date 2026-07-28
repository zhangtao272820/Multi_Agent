import type { Step } from '../../../utils/shared/taskPlan'
import { adminStepNeedsUpstreamData } from '../stepIsolation'

/** 规划阶段：visualize ∥ report 同组并行 */
export function assignOutputParallelGroups(planIn: Step[]): Step[] {
  if (!Array.isArray(planIn) || !planIn.length) return planIn
  const hasViz = planIn.some((s) => s.agent === 'visualize')
  const hasReport = planIn.some((s) => s.agent === 'report')
  if (!hasViz || !hasReport) return planIn
  return planIn.map((s) => {
    if (s.agent === 'visualize' || s.agent === 'report') {
      return { ...s, parallelGroup: s.parallelGroup || 'output' }
    }
    return s
  })
}

/** Task Fetching：同批优先拉起 visualize + report */
export function prioritizeOutputParallelBatch(ready: Step[], maxTake: number): Step[] {
  if (maxTake < 2 || ready.length < 2) return ready.slice(0, maxTake)
  const viz = ready.find((s) => s.agent === 'visualize')
  const rep = ready.find((s) => s.agent === 'report')
  if (!viz || !rep) return ready.slice(0, maxTake)
  const rest = ready.filter((s) => s !== viz && s !== rep)
  return [viz, rep, ...rest].slice(0, maxTake)
}

/** code 完成后 output 层等待时的短轮询间隔（ms） */
export function scheduleWaitIntervalMs(
  pending: Step[],
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): number {
  const outputPending = pending.filter((s) => OUTPUT_PARALLEL_AGENTS.has(s.agent))
  if (!outputPending.length) return 400
  const onlyCodeBlockers = outputPending.every((s) => {
    const blockers = listBlockingDependencies(s, allSteps, completedById)
    return blockers.length > 0 && blockers.every((id) => {
      const agent = allSteps.find((x) => String(x.id) === id)?.agent
      return agent === 'code'
    })
  })
  return onlyCodeBlockers ? 60 : 400
}

/** 全部可编排 Agent（与 taskPlan / ALL_PLAN_AGENTS 一致） */
export const ALL_PLAN_AGENTS_LIST: Step['agent'][] = [
  'db',
  'rag',
  'code',
  'crawler',
  'admin',
  'visualize',
  'report',
  'clean',
  'multimodal',
  'music',
  'video'
]

/** 取数层：彼此无业务依赖 */
export const DATA_PARALLEL_AGENTS = new Set<Step['agent']>(['rag', 'db', 'crawler'])

/** 媒体层：无 dependsOn 时可与取数层等同批并行 */
export const MEDIA_PARALLEL_AGENTS = new Set<Step['agent']>(['multimodal', 'music', 'video'])

/** 输出层：仅依赖同一上游（如 code）时 visualize ∥ report */
export const OUTPUT_PARALLEL_AGENTS = new Set<Step['agent']>(['visualize', 'report'])

const DATA = DATA_PARALLEL_AGENTS

/**
 * 各 Agent 允许的「语义上游」类型。
 * - `none`：默认无上游，仅保留 Planner `inputs` 显式声明的依赖
 * - `Set`：仅允许依赖这些类型的步骤
 */
const SEMANTIC_UPSTREAM: Record<Step['agent'], 'none' | Set<Step['agent']>> = {
  db: 'none',
  rag: 'none',
  crawler: 'none',
  multimodal: 'none',
  music: new Set<Step['agent']>(['multimodal']),
  video: new Set<Step['agent']>(['multimodal']),
  clean: new Set(DATA),
  code: new Set([...DATA, 'clean']),
  visualize: new Set([...DATA, 'clean', 'code']),
  report: new Set([...DATA, 'clean', 'code']),
  admin: new Set([...DATA, 'clean', 'code', 'visualize', 'report'])
}

const DEFAULT_PARALLEL_GROUP: Record<Step['agent'], string> = {
  db: 'fetch',
  rag: 'fetch',
  crawler: 'fetch',
  multimodal: 'media',
  music: 'media',
  video: 'media',
  clean: 'process',
  code: 'compute',
  visualize: 'output',
  report: 'output',
  admin: 'exec'
}

export function isParallelIndependentEnabled(): boolean {
  return String(process.env.MANAGER_PARALLEL_INDEPENDENT ?? '1').trim() !== '0'
}

/** multi 调度并发上限（与 scheduler / multiNode 共用） */
export function getManagerMaxParallel(): number {
  const v = Number(process.env.MANAGER_MAX_PARALLEL ?? 6)
  return Number.isFinite(v) && v >= 1 ? Math.min(8, Math.floor(v)) : 4
}

function stepById(steps: Step[]): Map<string, Step> {
  const m = new Map<string, Step>()
  for (const s of steps) {
    const id = String(s.id || '').trim()
    if (id) m.set(id, s)
  }
  return m
}

function upstreamAgent(depId: string, byId: Map<string, Step>): Step['agent'] | null {
  const u = byId.get(depId)
  return u?.agent ?? null
}

function explicitInputKeys(step: Step): Set<string> {
  const out = new Set<string>()
  for (const x of Array.isArray((step as any).inputs) ? (step as any).inputs : []) {
    const t = String(x ?? '').trim()
    if (t) out.add(t)
  }
  return out
}

/** 是否保留对 depId 的依赖 */
function keepDependency(
  step: Step,
  depId: string,
  byId: Map<string, Step>,
  explicit: Set<string>
): boolean {
  const rule = SEMANTIC_UPSTREAM[step.agent]
  const up = upstreamAgent(depId, byId)
  if (!up) return false
  if (explicit.has(depId) || explicit.has(up)) return true
  if (rule === 'none') return false
  return rule.has(up)
}

/** 加工/输出类：在允许多个上游时，只保留「最近一层」避免 report 绑死全链 */
function minimizeProcessingDeps(step: Step, keptIds: string[], byId: Map<string, Step>): string[] {
  if (!keptIds.length) return keptIds
  const agent = step.agent
  if (agent !== 'visualize' && agent !== 'report' && agent !== 'code') return keptIds

  const upAgents = keptIds
    .map((id) => upstreamAgent(id, byId))
    .filter((a): a is Step['agent'] => Boolean(a))

  const codeId = keptIds.find((id) => upstreamAgent(id, byId) === 'code')
  if (codeId && (agent === 'visualize' || agent === 'report')) return [codeId]

  const cleanIds = keptIds.filter((id) => upstreamAgent(id, byId) === 'clean')
  if (cleanIds.length && (agent === 'visualize' || agent === 'report' || agent === 'code')) {
    return agent === 'code' ? cleanIds : cleanIds.slice(0, 1)
  }

  const dataIds = keptIds.filter((id) => {
    const a = upstreamAgent(id, byId)
    return a && DATA.has(a)
  })
  if (agent === 'code' && dataIds.length) return dataIds
  if ((agent === 'visualize' || agent === 'report') && dataIds.length && !codeId && !cleanIds.length) {
    return dataIds
  }

  return keptIds
}

/** 保留 API；依赖由 Planner LLM 在 dependsOn / inputs 中声明 */
export function ensureIndependentAgentParallelism(planIn: Step[]): Step[] {
  return Array.isArray(planIn) ? planIn : []
}

/** 根据 DAG 根节点数建议 maxParallel（全部 Agent 类型） */
export function suggestMaxParallelForPlan(steps: Step[]): number {
  if (!isParallelIndependentEnabled() || !Array.isArray(steps) || !steps.length) return 0

  const cap = getManagerMaxParallel()
  const byId = stepById(steps)
  const roots = steps.filter((s) => {
    const deps = (Array.isArray(s.dependsOn) ? s.dependsOn : [])
      .map((d) => String(d ?? '').trim())
      .filter((d) => byId.has(d))
    return deps.length === 0
  })

  const countBy = (pred: (s: Step) => boolean) => roots.filter(pred).length
  const dataRoots = countBy((s) => DATA_PARALLEL_AGENTS.has(s.agent))
  const mediaRoots = countBy((s) => MEDIA_PARALLEL_AGENTS.has(s.agent))
  const execRoots = countBy((s) => s.agent === 'admin')
  const fanInMin = Number(process.env.MANAGER_DATA_FANIN_MIN_PARALLEL ?? 2)
  const dataFloor = Number.isFinite(fanInMin) && fanInMin >= 2 ? Math.min(cap, Math.floor(fanInMin)) : 2

  let suggested = roots.length
  if (dataRoots >= 2) suggested = Math.max(suggested, dataRoots, dataFloor)
  if (mediaRoots >= 2) suggested = Math.max(suggested, mediaRoots)
  if (execRoots >= 1 && dataRoots >= 1) suggested = Math.max(suggested, dataRoots + execRoots)
  if (mediaRoots >= 1 && dataRoots >= 1) suggested = Math.max(suggested, dataRoots + mediaRoots)

  return Math.min(cap, Math.max(1, suggested))
}

/** 同一波次可并行的 agent 列表（日志） */
export function describeParallelReadyBatch(ready: Step[]): string {
  if (!ready.length) return ''
  return ready.map((s) => String(s.agent || s.id || '?')).join(' ∥ ')
}

/** 计划中有多少步骤属于「默认可作根节点并行」的类型 */
export function countParallelCapableSteps(steps: Step[]): number {
  return steps.filter((s) => SEMANTIC_UPSTREAM[s.agent] === 'none').length
}

export type StepCompletionRecord = { status?: string } | undefined

/** 上游步骤已结束（成功/跳过/失败均可解锁下游调度，避免 skipped 导致死锁） */
export function stepUpstreamTerminal(rec: StepCompletionRecord): boolean {
  const st = String(rec?.status || '').trim()
  if (!st) return false
  return st === 'ok' || st === 'success' || st === 'skipped' || st === 'error'
}

/** 上游成功完成（visualize/report 消费 Code 数据时仍要求 code 成功） */
export function stepDependencySatisfied(rec: StepCompletionRecord): boolean {
  const st = String(rec?.status || '').trim()
  return st === 'ok' || st === 'success'
}

function stepIndex(plan: Step[], target: Step): number {
  const id = String(target.id || '').trim()
  if (id) {
    const i = plan.findIndex((s) => String(s.id || '').trim() === id)
    if (i >= 0) return i
  }
  return plan.indexOf(target)
}

/**
 * 语义 DAG：Planner 漏写 dependsOn 时，按 Agent 类型补全「必须等待的上游」。
 * - 取数 db/rag/crawler 可并行（互不依赖）
 * - clean 等全部取数完成；code 在 clean 之前则 code 等 clean
 * - visualize/report 有 code 则只等 code；否则等 clean 或取数
 * - music/video 有 multimodal 则等 multimodal
 */
export function resolveEffectiveDependencies(step: Step, allSteps: Step[]): string[] {
  const plan = Array.isArray(allSteps) ? allSteps : []
  const byId = stepById(plan)
  const sid = String(step.id || '').trim()
  const explicit = (Array.isArray(step.dependsOn) ? step.dependsOn : [])
    .map((d) => String(d ?? '').trim())
    .filter((d) => d && d !== sid && byId.has(d))

  const dataSteps = plan.filter((s) => DATA_PARALLEL_AGENTS.has(s.agent))
  const codeStep = plan.find((s) => s.agent === 'code')
  const cleanStep = plan.find((s) => s.agent === 'clean')
  const mmStep = plan.find((s) => s.agent === 'multimodal')
  const codeIdx = codeStep ? stepIndex(plan, codeStep) : -1
  const cleanIdx = cleanStep ? stepIndex(plan, cleanStep) : -1

  const implicit = new Set<string>()
  const addData = () => {
    for (const ds of dataSteps) {
      const id = String(ds.id || '').trim()
      if (id) implicit.add(id)
    }
  }

  switch (step.agent) {
    case 'code':
      if (cleanStep && cleanIdx >= 0 && codeIdx >= 0 && cleanIdx < codeIdx) {
        implicit.add(String(cleanStep.id || '').trim())
      } else {
        addData()
      }
      break
    case 'clean':
      if (codeStep && cleanIdx >= 0 && codeIdx >= 0 && cleanIdx > codeIdx) {
        implicit.add(String(codeStep.id || '').trim())
      } else {
        addData()
      }
      break
    case 'visualize':
    case 'report':
      if (codeStep) {
        implicit.clear()
        implicit.add(String(codeStep.id || '').trim())
      } else if (cleanStep) {
        implicit.add(String(cleanStep.id || '').trim())
      } else {
        addData()
      }
      break
    case 'music':
    case 'video':
      if (mmStep) implicit.add(String(mmStep.id || '').trim())
      break
    default:
      break
  }

  for (const d of explicit) implicit.add(d)
  return [...implicit].filter((d) => d && byId.has(d))
}

/**
 * 取数层 / 独立 admin 不得被 Planner 误绑串行（rag∥db∥admin 应同批就绪）。
 * - db/rag/crawler 互不依赖，且不得等待 admin
 * - 独立 admin（天气/地图/日程等）不得等待 db/rag/crawler/clean/code
 */
export function enforceFetchPlaneIndependence(planIn: Step[]): Step[] {
  if (!Array.isArray(planIn) || !planIn.length) return planIn
  const byId = stepById(planIn)

  return planIn.map((step) => {
    const explicit = (Array.isArray(step.dependsOn) ? step.dependsOn : [])
      .map((d) => String(d ?? '').trim())
      .filter((d) => byId.has(d))
    if (!explicit.length) return step

    const cleaned = explicit.filter((depId) => {
      const dep = byId.get(depId)
      if (!dep) return false
      if (DATA_PARALLEL_AGENTS.has(step.agent)) {
        if (DATA_PARALLEL_AGENTS.has(dep.agent) || dep.agent === 'admin') return false
      }
      if (step.agent === 'admin' && !adminStepNeedsUpstreamData(String(step.query || ''))) {
        if (
          DATA_PARALLEL_AGENTS.has(dep.agent) ||
          dep.agent === 'clean' ||
          dep.agent === 'code' ||
          dep.agent === 'visualize' ||
          dep.agent === 'report'
        ) {
          return false
        }
      }
      return true
    })

    if (cleaned.length === explicit.length) return step
    return { ...step, dependsOn: cleaned.length ? cleaned : undefined }
  })
}

/** 规划阶段写入 dependsOn，与调度器 resolveEffectiveDependencies 一致 */
export function enforceSemanticDependsOn(planIn: Step[]): Step[] {
  if (!Array.isArray(planIn) || !planIn.length) return planIn
  const independent = enforceFetchPlaneIndependence(planIn)
  return independent.map((step) => {
    const deps = resolveEffectiveDependencies(step, independent)
    return { ...step, dependsOn: deps.length ? deps : undefined }
  })
}

/** multi 执行前：规范化 id + 拓扑 + 语义依赖（在 plan.ts 中组合，避免循环 import） */
export function finalizePlanExecutionDeps(planIn: Step[]): Step[] {
  return enforceSemanticDependsOn(planIn)
}

/**
 * multi 调度：步骤是否可执行。
 * - 上游须 terminal 才就绪；消费链的「未成功则 skip」在 runStep 用 getUpstreamFailureSkipReason 处理
 * - visualize/report 等 code：code 须 terminal；失败/跳过后由 runStep 内门禁 skip，不再空转
 */
export function isStepReadyForExecution(
  step: Step,
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): boolean {
  const planById = stepById(allSteps)
  const depIds = resolveEffectiveDependencies(step, allSteps)
  for (const depId of depIds) {
    const rec = completedById[depId]
    const depAgent = planById.get(depId)?.agent
    if ((step.agent === 'visualize' || step.agent === 'report') && depAgent === 'code') {
      if (!stepUpstreamTerminal(rec)) return false
      continue
    }
    if (!stepUpstreamTerminal(rec)) return false
  }
  return true
}

/** 数据/加工消费链：上游未成功则应 skip，避免空转烧 token */
const UPSTREAM_CONSUMER_AGENTS = new Set<Step['agent']>([
  'clean',
  'code',
  'visualize',
  'report',
  'music',
  'video'
])

/**
 * 若本步依赖的上游已 terminal 但未成功 → 返回 skip 原因；否则 null。
 * 调用方应在 precheck 通过后、executor 前调用。
 */
export function getUpstreamFailureSkipReason(
  step: Step,
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): string | null {
  if (!UPSTREAM_CONSUMER_AGENTS.has(step.agent)) return null
  const planById = stepById(allSteps)
  const depIds = resolveEffectiveDependencies(step, allSteps)
  if (!depIds.length) return null
  for (const depId of depIds) {
    const rec = completedById[depId]
    if (!stepUpstreamTerminal(rec)) return null
    if (stepDependencySatisfied(rec)) continue
    const depAgent = String(planById.get(depId)?.agent || depId).trim()
    const st = String(rec?.status || '').trim() || 'unknown'
    return `上游 ${depAgent}(${depId}) 未成功（${st}），跳过本步以免空转`
  }
  return null
}

/** 失败/跳过某步后：列出应立即 skip 的 pending 下游（dependsOn 消费链） */
export function listDependentsToSkipAfterFailure(
  failedStepId: string,
  pendingSteps: Step[],
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): Step[] {
  const fid = String(failedStepId || '').trim()
  if (!fid) return []
  const nextCompleted: Record<string, StepCompletionRecord> = { ...completedById }
  if (!nextCompleted[fid]) nextCompleted[fid] = { status: 'error' }
  const out: Step[] = []
  for (const s of pendingSteps) {
    const sid = String(s.id || '').trim()
    if (!sid || nextCompleted[sid]) continue
    if (!UPSTREAM_CONSUMER_AGENTS.has(s.agent)) continue
    const reason = getUpstreamFailureSkipReason(s, allSteps, nextCompleted)
    if (reason) out.push(s)
  }
  return out
}

/** 列出仍阻塞该步骤的上游 id（调试用） */
export function listBlockingDependencies(
  step: Step,
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): string[] {
  const planById = stepById(allSteps)
  return resolveEffectiveDependencies(step, allSteps).filter((depId) => {
    const rec = completedById[depId]
    const depAgent = planById.get(depId)?.agent
    if ((step.agent === 'visualize' || step.agent === 'report') && depAgent === 'code') {
      return !stepUpstreamTerminal(rec)
    }
    return !stepUpstreamTerminal(rec)
  })
}

export function isCodeStepCompletedInRun(
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): boolean {
  const codeStep = allSteps.find((s) => s.agent === 'code')
  if (!codeStep) return false
  const codeId = String(codeStep.id || '').trim()
  return Boolean(codeId && stepDependencySatisfied(completedById[codeId]))
}

/** 调度死锁兜底：取数步可强行启动；code 在上游均已成功时可强行启动（失败上游则由上游剪枝 skip，不 force） */
export function canForceRunPendingStep(
  step: Step,
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord> = {}
): boolean {
  if (
    step.agent === 'visualize' ||
    step.agent === 'report' ||
    step.agent === 'clean' ||
    step.agent === 'music' ||
    step.agent === 'video'
  ) {
    return false
  }
  if (step.agent === 'code') {
    const deps = resolveEffectiveDependencies(step, allSteps)
    return deps.length > 0 && deps.every((depId) => stepDependencySatisfied(completedById[depId]))
  }
  return DATA_PARALLEL_AGENTS.has(step.agent) || step.agent === 'crawler' || step.agent === 'admin'
}
