import crypto from 'node:crypto'
import { Stagehand } from '@browserbasehq/stagehand'
import { z } from 'zod'
import { extractFirstHttpUrl, sanitizeExtractedHttpUrl } from '#agent-shared/extractHttpUrl'
import { sanitize } from './lobster/text'
import type { RunParams } from './lobster/types'
import { wrapLobsterOutput } from './lobsterResultEnvelope'
import {
  persistCookiesStorage,
  readStorageStateFile,
  resolveRunStoragePaths,
  stagehandCookiesFromStorage
} from './sessionStorageBridge'
import { stagehandHintsForPrompt, recipeActTemplate, isRecipeComplexPage } from './siteRecipes'
import { isStagehandEnabled, resolveEffectiveHeadless, resolveStagehandModelName, isStagehandLlmActPreferred } from '../utils/lobster_env'
import { resolveBrowserCdpUrl } from './browserProfiles'
import { buildChromiumLaunchOptions } from '../utils/chromiumLaunch'
import { verifyLobsterRunResult } from './lobsterRunVerify'
import {
  detectStagehandNetworkErrorPage,
  gotoStagehandUrl,
  goalsNeedLeaveStart,
  readStagehandPageTitle,
  readStagehandPageUrl,
  resolveStagehandPlanSteps,
  stagehandStepInstruction
} from './stagehandPlanLoop'
import {
  isStillOnStartUrl,
  playwrightClickContentLink,
  playwrightExtractBasics,
  playwrightFillAndSubmit,
} from './stagehandPlaywrightBridge'
import { isHttpBrowseUrl, isUnreachableBrowseUrl, looksLikeNetworkFailure } from '#agent-shared/lobsterRunVerifyLite'

const RISKY_TASK_PATTERN =
  /(支付|下单|购买|删除|注销|上传|投稿|checkout|pay\b|delete|remove|upload|purchase)/i

export async function probeStagehandReady(): Promise<{ ok: boolean; error?: string }> {
  if (!isStagehandEnabled()) return { ok: false, error: 'disabled' }
  try {
    if (!Stagehand) return { ok: false, error: 'import_failed' }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ? String(e.message) : String(e) }
  }
}

export async function runLobsterStagehandAgent(params: RunParams) {
  if (!isStagehandEnabled()) throw new Error('lobster_stagehand_disabled')

  const traceId = String(params.runId || crypto.randomUUID()).trim()
  const startedAt = Date.now()
  let confirmCount = 0
  let stepCount = 0

  let milestoneCount = 0
  const MAX_MILESTONES = 10
  const emitLog = (level: 'info' | 'warn' | 'error', message: string) => {
    // 仅 warn/error 与关键里程碑进 log；info 降噪
    if (level === 'info') return
    params.emit({ type: 'log', payload: { level, message: sanitize(message).slice(0, 240), ts: Date.now() } })
  }
  const emitThinking = (stage: string, text: string) => {
    if (milestoneCount >= MAX_MILESTONES) return
    const s = sanitize(String(text || '').trim()).slice(0, 200)
    if (!s) return
    milestoneCount++
    params.emit({ type: 'thinking', payload: { stage, text: s, ts: Date.now() } })
  }
  const emitMilestoneLog = (message: string) => {
    if (milestoneCount >= MAX_MILESTONES) return
    milestoneCount++
    params.emit({
      type: 'log',
      payload: { level: 'info', message: sanitize(message).slice(0, 240), ts: Date.now() },
    })
  }

  const requestConfirm = async (title: string, message: string) => {
    if (!params.human) return false
    const id = crypto.randomUUID()
    params.emit({ type: 'confirm', payload: { id, title: sanitize(title), message: sanitize(message), ts: Date.now() } })
    const ok = await params.human.waitConfirm(id, params.signal)
    if (ok) confirmCount++
    return ok
  }

  const apiKey = String(params.config?.openaiApiKey || process.env.OPENAI_API_KEY || '').trim()
  const baseURL = String(params.config?.openaiBaseUrl || process.env.OPENAI_BASE_URL || '').trim()
  const modelName = resolveStagehandModelName(params.config)
  if (!apiKey) throw new Error('lobster_stagehand_llm_missing')

  const configuredHeadless = Boolean(params.config?.lobster?.headless ?? true)
  const headless = resolveEffectiveHeadless(configuredHeadless)
  if (!configuredHeadless && headless) {
    emitLog('warn', 'Stagehand：DISPLAY/Xvfb 不可用，已改用 headless 启动浏览器')
  }
  const cdpUrl = resolveBrowserCdpUrl()
  const browserLaunch = buildChromiumLaunchOptions(headless)
  if (!browserLaunch.executablePath && !cdpUrl) {
    throw new Error(
      'stagehand_chrome_unavailable: 未找到 Chrome/Chromium。请设置 CHROME_PATH，或使用 Playwright 镜像（/ms-playwright）。',
    )
  }
  const storage = await resolveRunStoragePaths({
    startUrl: params.startUrl,
    sessionId: params.sessionId,
    storageProfile: params.storageProfile,
    storageDir: String(params.config?.lobster?.storageDir || '').trim() || undefined
  })
  const loadedState = storage.loadPath ? await readStorageStateFile(storage.loadPath) : null

  const stagehand = new Stagehand({
    env: 'LOCAL',
    disablePino: true,
    verbose: 0,
    model: {
      modelName,
      apiKey,
      ...(baseURL ? { baseURL } : {})
    },
    localBrowserLaunchOptions: {
      headless,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      args: browserLaunch.args,
      env: browserLaunch.env,
      chromiumSandbox: false,
      ...(browserLaunch.executablePath ? { executablePath: browserLaunch.executablePath } : {}),
      ...(cdpUrl ? { cdpUrl } : {})
    },
    logger: () => {
      /* 禁 Stagehand 内部 verbose → 总管日志洪水 */
    }
  })

  const startUrl =
    sanitizeExtractedHttpUrl(String(params.startUrl || '').trim()) ||
    sanitizeExtractedHttpUrl(String(params.taskSpec?.start_url || '').trim()) ||
    extractFirstHttpUrl(params.task) ||
    ''
  const planSteps = resolveStagehandPlanSteps({
    task: params.task,
    startUrl,
    taskSpec: params.taskSpec,
  })
  const goals = params.taskSpec?.goals
  const mustLeave = goalsNeedLeaveStart(goals, params.task)
  let leaveStartOk = !mustLeave
  let clickAttempted = false
  let lastClickFailReason = ''

  try {
    emitMilestoneLog('Stagehand：初始化…')
    params.emit({ type: 'state', payload: { phase: 'stagehand_init', stepCount: 0, pageUrl: startUrl || '' } })
    await stagehand.init()
    stepCount++

    if (loadedState) {
      const cookies = stagehandCookiesFromStorage(loadedState)
      if (cookies.length) {
        try {
          await stagehand.context.addCookies(cookies as any)
        } catch (e: any) {
          emitLog('warn', `加载 cookie 失败：${e?.message || e}`)
        }
      }
    }

    if (RISKY_TASK_PATTERN.test(params.task)) {
      const ok = await requestConfirm('高风险浏览器任务', 'Stagehand 任务可能涉及敏感操作，是否继续？')
      if (!ok) {
        const output = wrapLobsterOutput(
          {
            traceId,
            task: params.task,
            finalUrl: startUrl || '',
            stats: { stepCount, latency_ms: Date.now() - startedAt },
            data: [{ via: 'stagehand', text: '已中止：高风险操作未获确认。' }],
            answer: '已中止：高风险操作未获确认。',
            failureType: 'canceled',
          },
          'stagehand',
          { confirmCount, failureType: 'canceled', answer: '已中止：高风险操作未获确认。' }
        )
        params.emit({ type: 'result', payload: output })
        return output
      }
    }

    params.emit({
      type: 'state',
      payload: { phase: 'stagehand_execute', stepCount, pageUrl: startUrl || '' },
    })
    emitThinking(
      'plan',
      `${planSteps.length} 步：${planSteps.map((s) => s.op).join(' → ')}`,
    )

    const recipeHint = stagehandHintsForPrompt(params.task, startUrl)
    const actTpl = recipeActTemplate(params.task, startUrl)

    // 1) 可靠导航；错误页 / goto 失败 → fail-closed（禁止继续 click/extract）
    if (startUrl) {
      emitThinking('step', `1/${planSteps.length || 1} goto`)
      let navFailed = false
      let navErrMsg = ''
      try {
        await gotoStagehandUrl(stagehand, startUrl)
        stepCount++
      } catch (e: any) {
        navErrMsg = String(e?.message || e).slice(0, 160)
        emitLog('warn', `goto 失败，改 act：${navErrMsg}`)
        try {
          await stagehand.act(`打开页面 ${startUrl}`)
          stepCount++
        } catch (e2: any) {
          navFailed = true
          navErrMsg = String(e2?.message || e2).slice(0, 160)
          emitLog('warn', `导航失败：${navErrMsg}`)
        }
      }
      const netPage = await detectStagehandNetworkErrorPage(stagehand, startUrl)
      if (navFailed || netPage.unreachable) {
        const failureType = 'network'
        const pageHint = netPage.url || startUrl
        const titleHint = netPage.title ? `，标题：${netPage.title}` : ''
        const failAnswer = `无法访问目标页面（网络/DNS 或浏览器错误页）${
          navErrMsg ? `：${navErrMsg}` : ''
        }。当前页：${pageHint}${titleHint}`
        emitLog('error', `导航 fail-closed：${failureType} @ ${pageHint}`)
        const output = wrapLobsterOutput(
          {
            traceId,
            task: params.task,
            finalUrl: pageHint,
            plan: planSteps,
            goals: goals || undefined,
            stats: {
              stepCount,
              planSteps: planSteps.length,
              latency_ms: Date.now() - startedAt,
              enginePath: 'playwright_first',
            },
            data: [{ via: 'stagehand+playwright', text: failAnswer, url: pageHint }],
            answer: failAnswer,
            verify: { ok: false, reason: 'network_unreachable' },
            failureType,
          },
          'stagehand',
          { confirmCount, answer: failAnswer, failureType },
        )
        params.emit({ type: 'result', payload: output })
        return output
      }
    }

    // 复杂页可选 observe（LLM）；失败不影响主路径
    const complex = isRecipeComplexPage(params.task, startUrl)
    const preferLlmAct = isStagehandLlmActPreferred()
    if (complex && preferLlmAct) {
      try {
        await stagehand.observe('列出当前页面主要可点击链接与按钮（最多 8 个）')
        stepCount++
      } catch {
        /* skip */
      }
    }

    let lastActNote = ''
    const actionSteps = planSteps.filter((s) => s.op !== 'goto' && s.op !== 'extract')
    const extractStep = planSteps.find((s) => s.op === 'extract')
    let stepIdx = startUrl ? 1 : 0

    for (const step of actionSteps) {
      if (params.signal?.aborted) throw new Error('canceled')
      stepIdx++
      const instruction = stagehandStepInstruction(step, params.task)
      const withHint = [actTpl && step.op === 'click' ? `操作提示：${actTpl}` : '', instruction]
        .filter(Boolean)
        .join('\n')

      if (step.op === 'observe' || step.op === 'wait') {
        emitThinking('step', `${stepIdx}/${planSteps.length} ${step.op}`)
        try {
          if (step.op === 'wait') {
            await new Promise((r) => setTimeout(r, 800))
          } else if (preferLlmAct) {
            await stagehand.observe(withHint)
          }
          stepCount++
        } catch (e: any) {
          emitLog('warn', `${step.op} 跳过：${String(e?.message || e).slice(0, 100)}`)
        }
        continue
      }

      emitThinking('step', `${stepIdx}/${planSteps.length} ${step.op}`)

      // Playwright-first：click/type/submit 不依赖 Stagehand LLM JSON（Qwen 常 Bad Request / 长文解析失败）
      if (step.op === 'click') {
        clickAttempted = true
        let clicked = false
        if (preferLlmAct) {
          try {
            const actResult = await stagehand.act(withHint)
            lastActNote = String((actResult as any)?.message || (actResult as any)?.success || '').slice(0, 200)
            clicked = true
            stepCount++
          } catch (e: any) {
            emitLog('warn', `LLM act 失败，改 Playwright：${String(e?.message || e).slice(0, 100)}`)
          }
        }
        if (!clicked) {
          const pw = await playwrightClickContentLink(stagehand, {
            task: params.task,
            target: String(step.target || ''),
            startUrl,
          })
          if (pw.ok) {
            lastActNote = `点击：${pw.text || ''}`.slice(0, 200)
            stepCount++
            clicked = true
            emitThinking('step', `已点 ${String(pw.text || '').slice(0, 40)}`)
          } else {
            lastClickFailReason = String(pw.reason || 'unknown')
            emitLog('warn', `Playwright click 失败：${lastClickFailReason}`)
            // 扩扫描重试一次（仍按 plan target 排序，非站点补丁）
            const retry = await playwrightClickContentLink(stagehand, {
              task: params.task,
              target: String(step.target || ''),
              startUrl,
              scanLimit: 140,
            })
            if (retry.ok) {
              lastActNote = `点击：${retry.text || ''}`.slice(0, 200)
              stepCount++
              clicked = true
              lastClickFailReason = ''
              emitThinking('step', `重试已点 ${String(retry.text || '').slice(0, 40)}`)
            } else {
              lastClickFailReason = String(retry.reason || lastClickFailReason || 'unknown')
            }
          }
        }
        const urlNow = await readStagehandPageUrl(stagehand, startUrl)
        if (clicked && mustLeave && startUrl && !isStillOnStartUrl(urlNow, startUrl)) {
          leaveStartOk = true
        }
        if (clicked && !mustLeave) leaveStartOk = true
        params.emit({
          type: 'state',
          payload: { phase: 'stagehand_execute', stepCount, pageUrl: urlNow },
        })
        // mustLeave 且仍未离开：停止后续 extract 当成功产物，交 verify / gui-plus
        if (mustLeave && !leaveStartOk) {
          emitLog('warn', `离开首页未完成，跳过后续步骤（${lastClickFailReason || 'still_on_start'}）`)
          break
        }
        continue
      }

      if (step.op === 'type' || step.op === 'submit') {
        const filled = await playwrightFillAndSubmit(stagehand, step)
        if (filled.ok) {
          stepCount++
          lastActNote = `${step.op} ok`
        } else if (preferLlmAct) {
          try {
            const actResult = await stagehand.act(withHint)
            lastActNote = String((actResult as any)?.message || '').slice(0, 200)
            stepCount++
          } catch (e: any) {
            emitLog('warn', `act(${step.op}) 失败：${String(e?.message || e).slice(0, 120)}`)
          }
        } else {
          emitLog('warn', `Playwright ${step.op} 失败：${filled.reason || 'unknown'}`)
        }
        continue
      }

      // 其它 op：可选 LLM act
      if (preferLlmAct) {
        try {
          const actResult = await stagehand.act(withHint)
          lastActNote = String((actResult as any)?.message || (actResult as any)?.success || '').slice(0, 200)
          stepCount++
        } catch (e: any) {
          emitLog('warn', `act(${step.op}) 失败：${String(e?.message || e).slice(0, 120)}`)
        }
      }
    }

    // 若计划无交互步且要求离开首页：补一次 Playwright 点击
    if (actionSteps.length === 0 && mustLeave && !leaveStartOk) {
      clickAttempted = true
      emitThinking('step', 'playwright click')
      const pw = await playwrightClickContentLink(stagehand, {
        task: params.task,
        startUrl,
        scanLimit: 140,
      })
      if (pw.ok) {
        lastActNote = `点击：${pw.text || ''}`.slice(0, 200)
        stepCount++
        const urlNow = await readStagehandPageUrl(stagehand, startUrl)
        if (startUrl && !isStillOnStartUrl(urlNow, startUrl)) leaveStartOk = true
      } else {
        lastClickFailReason = String(pw.reason || 'unknown')
      }
    }

    let finalUrl = await readStagehandPageUrl(stagehand, startUrl)

    // mustLeave 失败：禁止把首页 extract 当成功产物，直接 navigation_unverified → router gui-plus
    if (mustLeave && startUrl && isStillOnStartUrl(finalUrl || startUrl, startUrl)) {
      leaveStartOk = false
      const failureType = 'navigation_unverified'
      const failAnswer = `浏览器任务未完成（${failureType}）：仍停留在起始页${
        lastClickFailReason ? `（click=${lastClickFailReason}）` : clickAttempted ? '' : '（未执行点击）'
      }。当前页：${finalUrl || startUrl}`
      const output = wrapLobsterOutput(
        {
          traceId,
          task: params.task,
          finalUrl: finalUrl || startUrl,
          plan: planSteps,
          goals: goals || undefined,
          stats: {
            stepCount,
            planSteps: planSteps.length,
            latency_ms: Date.now() - startedAt,
            enginePath: 'playwright_first',
          },
          data: [{ via: 'stagehand+playwright', text: failAnswer, url: finalUrl || startUrl }],
          answer: failAnswer,
          verify: { ok: false, reason: failureType },
          failureType,
        },
        'stagehand',
        { confirmCount, answer: failAnswer, failureType },
      )
      emitLog('warn', `verify 失败：${failureType}`)
      params.emit({ type: 'result', payload: output })
      return output
    }

    const basics = await playwrightExtractBasics(stagehand)
    const pageTitle = basics.title || (await readStagehandPageTitle(stagehand))

    let extracted: {
      summary?: string
      title?: string
      url?: string
      items?: Array<{ title?: string; url?: string; text?: string }>
    } | null = null

    // 默认用 Playwright 抽标题；仅显式开启 LLM act 时才走 Stagehand extract
    emitThinking('step', 'extract')
    if (preferLlmAct) {
      const extractTarget =
        extractStep?.target ||
        params.taskSpec?.success_criteria ||
        params.taskSpec?.completion_criteria ||
        '提取与用户任务相关的结构化结果（标题、链接、表单状态等）'
      try {
        extracted = await stagehand.extract(
          `${extractTarget}\n当前URL：${finalUrl}\n页面标题提示：${pageTitle || '未知'}\n任务：${params.task}`,
          z.object({
            summary: z.string(),
            title: z.string().optional(),
            url: z.string().optional(),
            items: z
              .array(
                z.object({
                  title: z.string().optional(),
                  url: z.string().optional(),
                  text: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        stepCount++
      } catch (e: any) {
        emitLog('warn', `LLM extract 跳过：${String(e?.message || e).slice(0, 120)}`)
        extracted = null
      }
    }

    if (!extracted?.summary && !extracted?.title) {
      extracted = {
        summary: basics.summary,
        title: basics.title || pageTitle,
        url: basics.url || finalUrl,
        items: basics.title
          ? [{ title: basics.title, url: basics.url || finalUrl }]
          : [],
      }
      stepCount++
    }

    finalUrl = basics.url || (await readStagehandPageUrl(stagehand, finalUrl)) || finalUrl

    const titleOut =
      String(extracted?.title || extracted?.items?.[0]?.title || pageTitle || '').trim()
    const answerText =
      String(extracted?.summary || '').trim() ||
      (titleOut && finalUrl ? `标题：${titleOut}\n链接：${finalUrl}` : '') ||
      lastActNote ||
      (pageTitle ? `标题：${pageTitle}\n链接：${finalUrl}` : '')

    const rawOutput = wrapLobsterOutput(
      {
        traceId,
        task: params.task,
        finalUrl,
        pageTitle: titleOut || pageTitle || undefined,
        plan: planSteps,
        goals: goals || undefined,
        stats: {
          stepCount,
          planSteps: planSteps.length,
          latency_ms: Date.now() - startedAt,
          enginePath: 'playwright_first',
        },
        data: [
          {
            via: 'stagehand+playwright',
            text: answerText,
            url: finalUrl || undefined,
            items:
              extracted?.items ||
              (titleOut
                ? [{ title: titleOut, url: finalUrl || extracted?.url || undefined }]
                : []),
            summary: extracted?.summary,
          },
        ],
        answer: answerText,
      },
      'stagehand',
      { confirmCount, answer: answerText },
    )

    const verify = verifyLobsterRunResult({
      task: params.task,
      status: 'done',
      result: rawOutput,
    })

    // 显式 goals：须离开起始页却仍停在首页
    let failureType = verify.ok ? undefined : String(verify.failureType || verify.reason || '').trim()
    if (mustLeave && !verify.ok && /navigation_unverified|incomplete_/i.test(String(verify.reason))) {
      failureType = 'navigation_unverified'
    }
    if (mustLeave && verify.ok) {
      // verify 可能因有 answer 放过；若 URL 仍是起始页且要求离开，强制失败
      try {
        const start = new URL(startUrl || finalUrl)
        const cur = new URL(finalUrl || startUrl)
        const same =
          start.hostname.replace(/^www\./, '') === cur.hostname.replace(/^www\./, '') &&
          start.pathname.replace(/\/$/, '') === cur.pathname.replace(/\/$/, '')
        if (same && /(点击|进入|第一个|第一条|教程)/i.test(params.task)) {
          failureType = 'navigation_unverified'
        }
      } catch {
        /* ignore */
      }
    }

    const output = wrapLobsterOutput(
      {
        ...rawOutput,
        verify: { ok: !failureType && verify.ok, reason: failureType || verify.reason },
        failureType,
      },
      'stagehand',
      {
        confirmCount,
        answer: failureType
          ? `浏览器任务未完成（${failureType}）：${verify.hints?.[0] || '请检查是否已进入目标页并提取到标题'}。当前页：${finalUrl || startUrl || ''}`
          : answerText,
        failureType,
      },
    )

    if (failureType) {
      emitLog('error', `verify 失败：${failureType}`)
    } else {
      emitMilestoneLog(`完成 · ${String(titleOut || pageTitle || '').slice(0, 80)}`)
    }

    params.emit({ type: 'result', payload: output })
    return output
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e)
    params.emit({ type: 'error', payload: { message: sanitize(msg), ts: Date.now() } })
    throw e
  } finally {
    try {
      if (storage.savePath) {
        const cookies = await stagehand.context.cookies()
        if (cookies?.length) {
          await persistCookiesStorage(storage.savePath, cookies as Array<Record<string, unknown>>)
        }
      }
    } catch {}
    try {
      await stagehand.close()
    } catch {}
  }
}
