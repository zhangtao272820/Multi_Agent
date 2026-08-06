/**
 * Stagehand 分步计划环：goto → observe/act → extract → 真实 finalUrl
 */
import type { LobsterPlanStep, LobsterTaskSpec } from './lobsterTaskUnderstandSchema'
import { defaultPlanStepsForTask } from './lobsterTaskUnderstandSchema'
import { isUnreachableBrowseUrl, looksLikeNetworkFailure } from '#agent-shared/lobsterRunVerifyLite'
import { lookupPlaybook, touchPlaybookHit } from './lobsterPlaybookCache'

/** 短计划硬上限（goto + act* + extract） */
export const STAGEHAND_PLAN_MAX_STEPS = 6

function capPlanSteps(steps: LobsterPlanStep[]): LobsterPlanStep[] {
  if (steps.length <= STAGEHAND_PLAN_MAX_STEPS) return steps
  const extract = steps.filter((s) => s.op === 'extract')
  const rest = steps.filter((s) => s.op !== 'extract')
  const kept = rest.slice(0, Math.max(1, STAGEHAND_PLAN_MAX_STEPS - Math.min(1, extract.length)))
  return [...kept, ...extract.slice(0, 1)].slice(0, STAGEHAND_PLAN_MAX_STEPS)
}

export function resolveStagehandPlanSteps(input: {
  task: string
  startUrl?: string
  taskSpec?: LobsterTaskSpec | null
}): { steps: LobsterPlanStep[]; playbookKey?: string } {
  const startUrl = input.startUrl || input.taskSpec?.start_url
  const fromSpec = input.taskSpec?.plan_steps

  const hit = lookupPlaybook({
    startUrl,
    taskKind: input.taskSpec?.task_kind,
    goals: input.taskSpec?.goals,
  })
  if (hit?.plan_steps?.length) {
    touchPlaybookHit(hit.key)
    return { steps: capPlanSteps(hit.plan_steps), playbookKey: hit.key }
  }

  const raw =
    Array.isArray(fromSpec) && fromSpec.length > 0
      ? fromSpec
      : defaultPlanStepsForTask({
          task: input.task,
          startUrl,
          taskKind: input.taskSpec?.task_kind,
          goals: input.taskSpec?.goals,
          completionCriteria: input.taskSpec?.success_criteria || input.taskSpec?.completion_criteria,
        })
  return { steps: capPlanSteps(raw) }
}

export function stagehandStepInstruction(step: LobsterPlanStep, task: string): string {
  const target = String(step.target || '').trim()
  const done = String(step.done_when || '').trim()
  const doneHint = done ? `。完成条件：${done}` : ''
  switch (step.op) {
    case 'goto':
      return `打开或确认已在页面：${target || '起始 URL'}${doneHint}`
    case 'observe':
      return `观察页面：${target || '列出可点击链接、按钮与输入框'}${doneHint}`
    case 'click':
      return `点击：${target || '按用户任务点击目标元素'}。总任务：${task.slice(0, 200)}${doneHint}`
    case 'type':
      return `在合适输入框输入：${target || '按用户任务填写'}。总任务：${task.slice(0, 200)}${doneHint}`
    case 'submit':
      return `提交表单或确认操作：${target || '提交'}${doneHint}`
    case 'wait':
      return `等待页面稳定：${target || '等待加载完成'}${doneHint}`
    case 'extract':
      return `提取：${target || '按完成标准提取标题/链接等'}。总任务：${task.slice(0, 200)}${doneHint}`
    default:
      return `${step.op}: ${target || task.slice(0, 160)}${doneHint}`
  }
}

/** 尽量从 Stagehand / Playwright 取真实 URL */
export async function readStagehandPageUrl(stagehand: any, fallback = ''): Promise<string> {
  try {
    const page = stagehand?.page || stagehand?.context?.pages?.()?.[0]
    if (page?.url) {
      const u = typeof page.url === 'function' ? page.url() : page.url
      const s = String(u || '').trim()
      if (s && /^https?:\/\//i.test(s)) return s
    }
  } catch {
    /* ignore */
  }
  try {
    const pages = stagehand?.context?.pages?.()
    if (Array.isArray(pages) && pages[0]?.url) {
      const u = typeof pages[0].url === 'function' ? pages[0].url() : pages[0].url
      const s = String(u || '').trim()
      if (s) return s
    }
  } catch {
    /* ignore */
  }
  return String(fallback || '').trim()
}

export async function readStagehandPageTitle(stagehand: any): Promise<string> {
  try {
    const page = stagehand?.page || stagehand?.context?.pages?.()?.[0]
    if (page?.title) {
      const t = typeof page.title === 'function' ? await page.title() : page.title
      return String(t || '').trim()
    }
  } catch {
    /* ignore */
  }
  return ''
}

export async function gotoStagehandUrl(stagehand: any, url: string): Promise<void> {
  const u = String(url || '').trim()
  if (!u) return
  const page = stagehand?.page || stagehand?.context?.pages?.()?.[0]
  if (page?.goto) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 })
    return
  }
  await stagehand.act(`打开页面 ${u}`)
}

/** goto 后是否落在浏览器错误页（chrome-error / 无法访问） */
export async function detectStagehandNetworkErrorPage(
  stagehand: any,
  fallbackUrl = '',
): Promise<{ unreachable: boolean; url: string; title: string }> {
  const url = await readStagehandPageUrl(stagehand, fallbackUrl)
  const title = await readStagehandPageTitle(stagehand)
  const blob = `${url}\n${title}`
  const unreachable =
    isUnreachableBrowseUrl(url) || looksLikeNetworkFailure(blob) || looksLikeNetworkFailure(title)
  return { unreachable, url, title }
}

export function goalsNeedLeaveStart(goals?: LobsterTaskGoals | null, task = ''): boolean {
  if (goals?.must_leave_start === true) return true
  if (goals?.expected_url_change === true) return true
  return /(点击|进入|打开第一个|第一条|教程|详情)/i.test(task)
}
