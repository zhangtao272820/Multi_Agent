/**
 * LLMCompiler Task Fetching Unit：依赖满足即 dispatch，支持并行与等待上游 terminal。
 * 调度只认 resolveEffectiveDependencies + completedById，不做意图层改写。
 */

import type { Step } from '../../../utils/shared/taskPlan'
import {
  canForceRunPendingStep,
  describeParallelReadyBatch,
  isStepReadyForExecution,
  listBlockingDependencies,
  prioritizeOutputParallelBatch,
  scheduleWaitIntervalMs,
  stepUpstreamTerminal,
  type StepCompletionRecord
} from '../plan/planParallel'

export type StepCompleteResult =
  | Step[]
  | {
      append?: Step[]
      replaceRemaining?: Step[]
      removePendingIds?: string[]
    }
  | void

export type TaskFetcherCallbacks = {
  ensureNotAborted: () => void
  onRunStep: (step: Step) => Promise<void>
  onReadyBatch?: (ready: Step[]) => void
  onScheduleWait?: (detail: string) => void
  onScheduleStall?: (stuck: Step[]) => Promise<void>
  filterReadyBatch?: (ready: Step[]) => Step[]
  stepPriority?: (step: Step) => number
  /**
   * 步骤完成后可：
   * - 返回 Step[]：动态追加（兼容旧 crawler→gui）
   * - 返回 { append, replaceRemaining, removePendingIds }：局部修订剩余计划
   */
  onStepComplete?: (step: Step) => StepCompleteResult | Promise<StepCompleteResult>
}

export type TaskFetcherOpts = {
  steps: Step[]
  maxParallel: number
  completedById: Record<string, StepCompletionRecord>
  callbacks: TaskFetcherCallbacks
  maxWaitSpins?: number
}

const DEFAULT_MAX_WAIT_SPINS = 48

function injectDynamicSteps(steps: Step[], pending: Map<string, Step>, extra: Step[]): void {
  for (const s of extra) {
    const id = String(s.id || '').trim()
    if (!id || pending.has(id) || steps.some((x) => String(x.id) === id)) continue
    steps.push(s)
    pending.set(id, s)
  }
}

function applyStepCompletePatch(
  steps: Step[],
  pending: Map<string, Step>,
  completedById: Record<string, StepCompletionRecord>,
  patch: StepCompleteResult
): void {
  if (!patch) return
  if (Array.isArray(patch)) {
    injectDynamicSteps(steps, pending, patch)
    return
  }
  if (Array.isArray(patch.removePendingIds)) {
    for (const raw of patch.removePendingIds) {
      const id = String(raw || '').trim()
      if (!id) continue
      pending.delete(id)
      const idx = steps.findIndex((s) => String(s.id) === id)
      if (idx >= 0 && !completedById[id]) steps.splice(idx, 1)
    }
  }
  if (Array.isArray(patch.replaceRemaining)) {
    const completedIds = new Set(Object.keys(completedById))
    for (const id of [...pending.keys()]) pending.delete(id)
    const completedOrdered = steps.filter((s) => completedIds.has(String(s.id || '').trim()))
    const next: Step[] = [...completedOrdered]
    for (const s of patch.replaceRemaining) {
      const id = String(s.id || '').trim()
      if (!id || completedIds.has(id)) continue
      if (next.some((x) => String(x.id) === id)) continue
      next.push(s)
      pending.set(id, s)
    }
    steps.length = 0
    steps.push(...next)
  }
  if (Array.isArray(patch.append) && patch.append.length) {
    injectDynamicSteps(steps, pending, patch.append)
  }
}

/** 选出当前可执行步骤（依赖均已 terminal） */
export function selectReadySteps(
  pending: Iterable<Step>,
  allSteps: Step[],
  completedById: Record<string, StepCompletionRecord>
): Step[] {
  const ready: Step[] = []
  for (const s of pending) {
    if (isStepReadyForExecution(s, allSteps, completedById)) ready.push(s)
  }
  return ready
}

/**
 * Task Fetching Unit 主循环：就绪即跑，至 pending/active 皆空。
 * clean/code/visualize 等须等待上游时由 isStepReadyForExecution 自然阻塞。
 */
export async function runTaskFetcherLoop(opts: TaskFetcherOpts): Promise<void> {
  const {
    steps,
    maxParallel,
    completedById,
    callbacks,
    maxWaitSpins = DEFAULT_MAX_WAIT_SPINS
  } = opts
  const { ensureNotAborted, onRunStep, onReadyBatch, onScheduleWait, onScheduleStall, filterReadyBatch, stepPriority, onStepComplete } =
    callbacks

  const pending = new Map<string, Step>()
  for (const s of steps) {
    const id = String(s.id || '').trim()
    if (!id) continue
    // 图级重试 hydrate 后：已 terminal 的步不再进 pending，避免整 plan 重跑
    if (stepUpstreamTerminal(completedById[id])) continue
    pending.set(id, s)
  }

  const active = new Set<Promise<void>>()
  let waitSpins = 0
  let waitLoggedAt = 0
  let loggedReadyPreview = false

  const priority = stepPriority ?? (() => 0)

  while (pending.size > 0 || active.size > 0) {
    ensureNotAborted()

    let ready = selectReadySteps(pending.values(), steps, completedById)
    ready.sort((a, b) => priority(b) - priority(a))
    if (filterReadyBatch) ready = filterReadyBatch(ready)

    if (!loggedReadyPreview && ready.length > 1 && onReadyBatch) {
      onReadyBatch(ready)
      loggedReadyPreview = true
    }

    if (ready.length > 0 && active.size < maxParallel) {
      waitSpins = 0
      const slots = maxParallel - active.size
      const batch = prioritizeOutputParallelBatch(ready, slots)
      for (const s of batch) {
        const stepId = String(s.id)
        pending.delete(stepId)
        const p = onRunStep(s)
          .then(async () => {
            if (onStepComplete) {
              const patch = await onStepComplete(s)
              applyStepCompletePatch(steps, pending, completedById, patch)
            }
          })
          .finally(() => active.delete(p))
        active.add(p)
      }
    } else if (active.size > 0) {
      await Promise.race(active)
    } else if (pending.size > 0) {
      waitSpins += 1
      const forceable = [...pending.values()].filter((s) =>
        canForceRunPendingStep(s, steps, completedById)
      )
      const force =
        forceable[0] ??
        ([...pending.values()].find((s) => isStepReadyForExecution(s, steps, completedById)) as
          | Step
          | undefined)

      if (!force) {
        if (waitSpins >= maxWaitSpins) {
          if (onScheduleStall) {
            await onScheduleStall([...pending.values()].slice(0, 4))
            for (const s of [...pending.values()].slice(0, 4)) {
              const id = String(s.id || '').trim()
              if (id) pending.delete(id)
            }
          }
          waitSpins = 0
          continue
        }
        const now = Date.now()
        if (onScheduleWait && now - waitLoggedAt > 2800) {
          const detail = [...pending.values()]
            .slice(0, 4)
            .map((s) => {
              const blockers = listBlockingDependencies(s, steps, completedById)
              return `${String(s.id)}:${String(s.agent)}${blockers.length ? `(等${blockers.join('+')})` : ''}`
            })
            .join('；')
          onScheduleWait(detail || `${pending.size} 步待上游`)
          waitLoggedAt = now
        }
        await new Promise((r) => setTimeout(r, scheduleWaitIntervalMs([...pending.values()], steps, completedById)))
        continue
      }

      waitSpins = 0
      const stepId = String(force.id)
      pending.delete(stepId)
      const p = onRunStep(force)
        .then(async () => {
          if (onStepComplete) {
            const patch = await onStepComplete(force)
            applyStepCompletePatch(steps, pending, completedById, patch)
          }
        })
        .finally(() => active.delete(p))
      active.add(p)
    }
  }
}

export { describeParallelReadyBatch, applyStepCompletePatch }
