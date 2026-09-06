/**
 * B站 video_play / social_engagement 专属执行面（Playwright + 闸门）。
 * 由 Router 在 task_kind 匹配且 host 为 bilibili 时调用；不新开 MCP 进程。
 */
import { chromium } from 'playwright'
import type { RunParams } from './lobster/types'
import { buildChromiumLaunchOptions } from '../utils/chromiumLaunch'
import { resolveEffectiveHeadless } from '../utils/lobster_env'
import { ensureLobsterGuiFinalPayload } from './lobsterGuiFinalPayload'
import {
  declaredBiliToolsFromArgs,
  isBilibiliEngagementHost,
  planBilibiliEngagementFromSpec,
  runBilibiliEngagementSession,
} from './bilibiliEngagement'

function emitLog(params: RunParams, level: 'info' | 'warn' | 'error', message: string) {
  params.emit({
    type: 'log',
    payload: { level, message: String(message || '').slice(0, 2000), ts: Date.now() },
  })
}

function resolveStartUrl(params: RunParams): string {
  const fromParam = String(params.startUrl || '').trim()
  if (fromParam && /^https?:\/\//i.test(fromParam)) return fromParam
  const fromSpec = String(params.taskSpec?.start_url || '').trim()
  if (fromSpec && /^https?:\/\//i.test(fromSpec)) return fromSpec
  const m = String(params.task || '').match(/https?:\/\/[^\s)\]"'<>]+/i)
  return m ? m[0] : 'https://www.bilibili.com/'
}

export function shouldRunBilibiliEngagementAgent(params: {
  taskKind?: string
  task?: string
  startUrl?: string
}): boolean {
  const kind = String(params.taskKind || '').trim()
  if (kind !== 'video_play' && kind !== 'social_engagement') return false
  const blob = `${params.startUrl || ''} ${params.task || ''}`
  return isBilibiliEngagementHost(blob) || /B站|哔哩/i.test(blob)
}

export async function runBilibiliEngagementAgent(params: RunParams) {
  const taskKind = String(params.taskSpec?.task_kind || '').trim() || 'social_engagement'
  const plan = planBilibiliEngagementFromSpec({
    taskKind,
    declaredTools: declaredBiliToolsFromArgs(params.workflowArgs || null),
  })

  const startUrl = resolveStartUrl(params)
  emitLog(params, 'info', `B站专属：kind=${taskKind} tools=${plan.tools.join(',') || '-'} url=${startUrl}`)

  const ts = Date.now()
  params.emit({
    type: 'engine_chain',
    payload: { ts, chain: ['classic'], activeIndex: 0, biliEngagement: true },
  })
  params.emit({
    type: 'engine_active',
    payload: { ts, engine: 'classic', actualEngine: 'classic', attemptIndex: 0, biliEngagement: true },
  })

  if (plan.needsHitl) {
    if (!params.human?.waitConfirm) {
      return ensureLobsterGuiFinalPayload(
        {
          ok: false,
          engine: 'classic',
          actualEngine: 'classic',
          answer: 'B站写互动须人工确认，但当前通道无 HITL。',
          failureType: 'need_human',
          finalUrl: startUrl,
        },
        params.task,
      )
    }
    const id = `bili_eng_${Date.now()}`
    params.emit({
      type: 'confirm',
      payload: {
        id,
        title: '确认 B站写互动',
        message: [
          `即将执行：${plan.tools.join('、') || '互动'}`,
          '点赞/投币/收藏/关注会改变账号状态；取消则中止。',
          '发弹幕本阶段不自动执行。',
          `页面：${startUrl}`,
        ].join('\n'),
        ts: Date.now(),
      },
    })
    const ok = await params.human.waitConfirm(id, params.signal)
    if (!ok) {
      return ensureLobsterGuiFinalPayload(
        {
          ok: false,
          engine: 'classic',
          actualEngine: 'classic',
          answer: '已取消 B站写互动。',
          failureType: 'canceled',
          finalUrl: startUrl,
        },
        params.task,
      )
    }
  }

  const configHeadless = params.config?.lobster?.headless !== false
  // 播放/互动：尽量有头（Docker noVNC）；config 强制 headless 时仍尊重
  const headless = resolveEffectiveHeadless(Boolean(configHeadless && process.env.LOBSTER_BILI_FORCE_HEADLESS === '1'))
  const launch = buildChromiumLaunchOptions(headless)
  const browser = await chromium.launch({
    headless,
    args: launch.args,
    env: launch.env,
  })

  try {
    const context = await browser.newContext(
      params.storageProfile
        ? {
            /* storage 由上层 import；此处仅标记 hasStorage */
          }
        : undefined,
    )
    const page = await context.newPage()
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // 关登录弹窗（可选）
    for (const sel of [
      "button:has-text('暂不登录')",
      '.bili-mini-close-icon',
      '[aria-label="关闭"]',
    ]) {
      try {
        await page.click(sel, { timeout: 2000 })
      } catch {
        /* optional */
      }
    }

    const session = await runBilibiliEngagementSession({
      page,
      taskKind,
      declaredTools: plan.tools,
      hitlApproved: true,
      hasStorageProfile: Boolean(params.storageProfile),
      userClaimsLoggedIn: params.taskSpec?.needs_login === true && Boolean(params.storageProfile),
    })

    const finalUrl = page.url()
    const pageTitle = await page.title().catch(() => '')
    return ensureLobsterGuiFinalPayload(
      {
        ok: session.ok,
        engine: 'classic',
        actualEngine: 'classic',
        answer: session.answer,
        failureType: session.failureType,
        finalUrl,
        pageTitle,
        data: [{ items: session.results }],
        task_kind: taskKind,
      },
      params.task,
    )
  } finally {
    await browser.close().catch(() => {})
  }
}
