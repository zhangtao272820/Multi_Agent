/**
 * gui-plus 有限步 computer_use 兜底：截图 → CAP_GUI 模型 → 坐标点击/输入
 * 仅在 Stagehand/MCP verify 失败后由 router 调用；硬帽 ≤4 步，默认关思考。
 */
import crypto from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import type { RunParams } from './lobster/types'
import { wrapLobsterOutput } from './lobsterResultEnvelope'
import { buildChromiumLaunchOptions } from '../utils/chromiumLaunch'
import { resolveEffectiveHeadless } from '../utils/lobster_env'
import { resolveRunStoragePaths, readStorageStateFile } from './sessionStorageBridge'
import { ensureLobsterGuiFinalPayload } from './lobsterGuiFinalPayload'
import {
  GUI_PLUS_SYSTEM_PROMPT,
  mapNormCoordToViewport,
  parseGuiPlusToolCall,
  resolveGuiPlusMaxSteps,
  type GuiPlusAction,
} from './lobsterGuiPlusFallback'
import { readQwenEnableThinkingFromEnv } from '#agent-shared/qwenModelKwargs'

function emitThinking(params: RunParams, message: string) {
  params.emit({
    type: 'thinking',
    payload: { stage: 'gui_plus', text: String(message || '').slice(0, 240), ts: Date.now() },
  })
}

function resolveGuiModel(params: RunParams): string {
  const lobster = params.config?.lobster
  return (
    String(lobster?.guiModel || '').trim() ||
    String(lobster?.visionModel || '').trim() ||
    String(process.env.LOBSTER_GUI_MODEL || process.env.LOBSTER_VISION_MODEL || 'gui-plus-2026-02-26').trim()
  )
}

async function callGuiPlusOnce(opts: {
  apiKey: string
  baseURL: string
  model: string
  task: string
  imageDataUrl: string
  pageUrl: string
  pageTitle: string
  maxTokens: number
}): Promise<string> {
  const userText = [
    `任务：${opts.task}`,
    `当前URL：${opts.pageUrl || '(unknown)'}`,
    `当前标题：${opts.pageTitle || '(unknown)'}`,
    '根据截图选择下一步唯一 computer_use 动作。完成后用 action=terminate 并 status=success，必要时在 text 写出页面标题。',
  ].join('\n')

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: 0.1,
    messages: [
      { role: 'system', content: GUI_PLUS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: opts.imageDataUrl } },
        ],
      },
    ],
    enable_thinking: readQwenEnableThinkingFromEnv(),
    vl_high_resolution_images: true,
  }

  const url = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`gui_plus_http_${res.status}:${errText.slice(0, 200)}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && c.type === 'text' ? String(c.text || '') : ''))
      .join('\n')
  }
  return ''
}

async function applyAction(page: Page, action: GuiPlusAction, viewport: { w: number; h: number }) {
  const a = action.action
  if (a === 'wait') {
    const ms = Math.min(5000, Math.max(200, Math.floor((action.time || 1) * 1000)))
    await page.waitForTimeout(ms)
    return
  }
  if (a === 'terminate') return

  let x = 0
  let y = 0
  if (action.coordinate) {
    const mapped = mapNormCoordToViewport(action.coordinate[0], action.coordinate[1], viewport.w, viewport.h)
    x = mapped.x
    y = mapped.y
  }

  if (a === 'mouse_move' && action.coordinate) {
    await page.mouse.move(x, y)
    return
  }
  if ((a === 'left_click' || a === 'click') && action.coordinate) {
    await page.mouse.click(x, y)
    return
  }
  if (a === 'double_click' && action.coordinate) {
    await page.mouse.dblclick(x, y)
    return
  }
  if (a === 'right_click' && action.coordinate) {
    await page.mouse.click(x, y, { button: 'right' })
    return
  }
  if (a === 'middle_click' && action.coordinate) {
    await page.mouse.click(x, y, { button: 'middle' })
    return
  }
  if (a === 'scroll') {
    await page.mouse.wheel(0, 600)
    return
  }
  if (a === 'type' && action.text) {
    if (action.coordinate) await page.mouse.click(x, y)
    await page.keyboard.type(String(action.text), { delay: 20 })
    return
  }
  if (a === 'key' && action.keys?.length) {
    for (const k of action.keys) await page.keyboard.press(String(k))
    return
  }
  if (a === 'left_click_drag' && action.coordinate) {
    await page.mouse.down()
    await page.mouse.move(x, y)
    await page.mouse.up()
  }
}

export async function runLobsterGuiPlusAgent(
  params: RunParams,
  opts?: { resumeUrl?: string; priorFailure?: string },
): Promise<Record<string, unknown>> {
  const apiKey = String(params.config?.openaiApiKey || process.env.OPENAI_API_KEY || '').trim()
  const baseURL = String(
    params.config?.openaiBaseUrl || process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ).trim()
  const model = resolveGuiModel(params)
  if (!apiKey) throw new Error('gui_plus_missing_api_key')

  const maxSteps = resolveGuiPlusMaxSteps()
  const maxTokens = Math.min(
    512,
    Math.max(120, Math.floor(Number(params.config?.lobster?.visionMaxTokens ?? 320) || 320)),
  )
  const headless = resolveEffectiveHeadless(Boolean(params.config?.lobster?.headless))
  const launchOpts = buildChromiumLaunchOptions(headless)
  const storage = await resolveRunStoragePaths({
    startUrl: params.startUrl,
    sessionId: params.sessionId,
    storageProfile: params.storageProfile,
    storageDir: String(params.config?.lobster?.storageDir || '').trim() || undefined,
  })
  const storageState = storage.loadPath ? await readStorageStateFile(storage.loadPath) : null

  const startUrl = String(opts?.resumeUrl || params.startUrl || params.taskSpec?.start_url || '').trim()
  const runId = String(params.runId || crypto.randomUUID())
  const startedAt = Date.now()
  let browser: Browser | null = null
  const stepsLog: Array<Record<string, unknown>> = []

  emitThinking(
    params,
    `gui-plus 兜底启动 model=${model} maxSteps=${maxSteps}${opts?.priorFailure ? ` prior=${opts.priorFailure}` : ''}`,
  )
  params.emit({
    type: 'engine_active',
    payload: { ts: Date.now(), engine: 'gui_plus', actualEngine: 'gui_plus', attemptIndex: 1 },
  })

  try {
    browser = await chromium.launch({
      headless,
      args: launchOpts.args,
      env: launchOpts.env,
      ...(launchOpts.executablePath ? { executablePath: launchOpts.executablePath } : {}),
    })
    const context = await browser.newContext({
      ...(storageState ? { storageState: storageState as any } : {}),
      viewport: { width: 1280, height: 720 },
    })
    const page = await context.newPage()
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    }

    let terminateOk = false
    let lastTitle = ''
    let lastUrl = startUrl

    for (let i = 0; i < maxSteps; i++) {
      await page.waitForTimeout(400)
      const shot = await page.screenshot({ type: 'png' })
      const dataUrl = `data:image/png;base64,${shot.toString('base64')}`
      const vp = page.viewportSize() || { width: 1280, height: 720 }
      lastUrl = page.url()
      lastTitle = await page.title().catch(() => '')

      emitThinking(params, `gui-plus 步骤 ${i + 1}/${maxSteps} · ${lastUrl.slice(0, 80)}`)
      params.emit({
        type: 'state',
        payload: { phase: 'gui_plus_step', stepCount: i + 1, pageUrl: lastUrl },
      })

      const raw = await callGuiPlusOnce({
        apiKey,
        baseURL,
        model,
        task: params.task,
        imageDataUrl: dataUrl,
        pageUrl: lastUrl,
        pageTitle: lastTitle,
        maxTokens,
      })
      const action = parseGuiPlusToolCall(raw)
      if (!action) {
        stepsLog.push({ step: i + 1, error: 'parse_failed', preview: raw.slice(0, 160) })
        emitThinking(params, 'gui-plus 输出无法解析，结束兜底')
        break
      }
      stepsLog.push({ step: i + 1, action: action.action, coordinate: action.coordinate, status: action.status })
      emitThinking(
        params,
        `gui-plus 动作：${action.action}${action.coordinate ? ` @${action.coordinate.join(',')}` : ''}`,
      )

      if (action.action === 'terminate') {
        terminateOk = String(action.status || 'success').toLowerCase() !== 'failure'
        if (action.text) lastTitle = String(action.text).slice(0, 200)
        break
      }
      await applyAction(page, action, { w: vp.width, h: vp.height })
    }

    lastUrl = page.url()
    lastTitle = lastTitle || (await page.title().catch(() => ''))
    const answer =
      lastTitle && lastUrl
        ? `标题：${lastTitle}\n链接：${lastUrl}`
        : lastUrl
          ? `页面：${lastUrl}`
          : 'gui-plus 兜底未得到可读结果'

    const ok = terminateOk || (Boolean(lastTitle) && Boolean(lastUrl) && lastUrl !== startUrl)
    const rawOut = ensureLobsterGuiFinalPayload(
      {
        ok,
        answer,
        summary: answer,
        finalUrl: lastUrl,
        pageTitle: lastTitle,
        title: lastTitle,
        guiPlusSteps: stepsLog,
        failureType: ok ? undefined : 'gui_plus_incomplete',
        startedAt,
        finishedAt: Date.now(),
        runId,
        task: params.task,
      },
      params.task,
    )

    return wrapLobsterOutput(rawOut, 'gui_plus', {
      failureType: ok ? undefined : 'gui_plus_incomplete',
      answer,
    }) as Record<string, unknown>
  } finally {
    await browser?.close().catch(() => {})
  }
}
