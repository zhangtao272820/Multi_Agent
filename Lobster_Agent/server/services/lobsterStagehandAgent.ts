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
  STAGEHAND_PLAN_MAX_STEPS,
  stagehandStepInstruction
} from './stagehandPlanLoop'
import {
  isStillOnStartUrl,
  playwrightClickContentLink,
  playwrightExtractBasics,
  playwrightFillAndSubmit,
  playwrightFillFormFields,
  playwrightPerformSearch,
  isInstructionalFillTarget,
  captureStagehandScreenshot,
  getStagehandPage,
  buildFormFillClarifyMessage,
} from './stagehandPlaywrightBridge'
import {
  extractFormFieldsFromTask,
  redactFormFieldsForLog,
  resolveRecipeFormFields,
} from './lobsterFormFill'
import {
  evaluateSuccessCriteria,
  normalizeWebFailureCode,
  resolveStructuredSuccessCriteria,
} from './lobsterSuccessCriteria'
import { savePlaybookEvolved } from './lobsterPlaybookEvolution'
import { guiScreenshotFingerprint } from '#agent-shared/lobsterGuiProgressContract'
import { resolveLobsterVncLiveView } from '../utils/lobsterVnc'
import {
  classifyLeanBrowseKind,
  extractSearchQueryFromTask,
  resolveLeanSearchLandingUrl,
} from './lobsterAgent/leanBrowsePolicy'
import { baiduNeedsDirectSearch, baiduSearchUrl, isBaiduHost } from './lobsterAgent/taskLoginIntent'

const RISKY_TASK_PATTERN =
  /(支付|下单|购买|删除|注销|上传|投稿|checkout|pay\b|delete|remove|upload|purchase)/i

/** Stagehand 结束后交给 router / gui-plus 同会话急救；由调用方 close */
export type LobsterBrowserSessionHandoff = {
  page?: any
  close?: () => Promise<void>
}

export async function probeStagehandReady(): Promise<{ ok: boolean; error?: string }> {
  if (!isStagehandEnabled()) return { ok: false, error: 'disabled' }
  try {
    if (!Stagehand) return { ok: false, error: 'import_failed' }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ? String(e.message) : String(e) }
  }
}

export async function runLobsterStagehandAgent(
  params: RunParams,
  opts?: { sessionHandoff?: LobsterBrowserSessionHandoff },
) {
  if (!isStagehandEnabled()) throw new Error('lobster_stagehand_disabled')

  const traceId = String(params.runId || crypto.randomUUID()).trim()
  const startedAt = Date.now()
  let confirmCount = 0
  let stepCount = 0

  let milestoneCount = 0
  const MAX_MILESTONES = 10
  let lastShotFp = ''
  let lastScreenshotDataUrl = ''
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
  const emitLiveView = () => {
    const live = resolveLobsterVncLiveView()
    if (!live.vncUrl && !live.hint) return
    params.emit({
      type: 'live_view',
      payload: {
        vncUrl: live.vncUrl || '',
        ...(live.hint ? { hint: live.hint } : {}),
        ts: Date.now(),
      },
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

  let startUrl =
    sanitizeExtractedHttpUrl(String(params.startUrl || '').trim()) ||
    sanitizeExtractedHttpUrl(String(params.taskSpec?.start_url || '').trim()) ||
    extractFirstHttpUrl(params.task) ||
    ''
  const searchQuery =
    String((params.taskSpec?.goals as { searchQuery?: string } | undefined)?.searchQuery || '').trim() ||
    extractSearchQueryFromTask(params.task)
  const leanKind = classifyLeanBrowseKind({
    task: params.task,
    goals: (params.taskSpec?.goals || null) as Record<string, unknown> | null,
    taskKind: params.taskSpec?.task_kind,
  })
  const searchLanding = resolveLeanSearchLandingUrl({
    startUrl,
    searchQuery,
    kind: leanKind,
  })
  if (searchLanding) {
    startUrl = searchLanding
  }
  const planResolved = resolveStagehandPlanSteps({
    task: params.task,
    startUrl,
    taskSpec: params.taskSpec,
  })
  const planSteps = planResolved.steps
  const playbookKey = planResolved.playbookKey
  const goals = params.taskSpec?.goals
  let mustLeave = goalsNeedLeaveStart(goals, params.task, params.taskSpec?.task_kind)
  const structuredCriteria = resolveStructuredSuccessCriteria({
    taskSpec: params.taskSpec,
    task: params.task,
    startUrl,
  })
  let leaveStartOk = !mustLeave
  // 百度等已直达结果页：search_extract 不再要求离页；search_open 须再点进详情
  if (searchLanding && searchQuery) {
    if (leanKind === 'search_open') {
      leaveStartOk = false
    } else {
      mustLeave = false
      leaveStartOk = true
    }
  }
  let clickAttempted = false
  let lastClickFailReason = ''
  let stepBudgetExceeded = false
  /** form_fill 已校验 value 的字段证据 */
  let formFilledEvidence: Array<{ key: string; value: string }> = []
  /** 交互步预算（不含 init）；超顶截断并带 step_budget_exceeded */
  const mgrBudget = Number(params.taskSpec?.max_interaction_steps)
  const actionBudget =
    Number.isFinite(mgrBudget) && mgrBudget > 0
      ? Math.min(STAGEHAND_PLAN_MAX_STEPS, Math.floor(mgrBudget))
      : STAGEHAND_PLAN_MAX_STEPS
  let actionStepsUsed = 0

  const emitScreenshot = async (force = false) => {
    try {
      const shot = await captureStagehandScreenshot(stagehand)
      if (!shot?.dataUrl) return
      const pageUrl =
        shot.pageUrl || (await readStagehandPageUrl(stagehand, startUrl).catch(() => '')) || ''
      const fp = guiScreenshotFingerprint(shot.dataUrl, pageUrl)
      if (!force && fp === lastShotFp) return
      lastShotFp = fp
      lastScreenshotDataUrl = shot.dataUrl
      params.emit({
        type: 'screenshot',
        payload: { dataUrl: shot.dataUrl, pageUrl: pageUrl || undefined, ts: Date.now() },
      })
    } catch {
      /* 截图失败不挡主路径 */
    }
  }
  const withShot = <T extends Record<string, unknown>>(row: T): T => {
    if (!lastScreenshotDataUrl) return row
    return {
      ...row,
      screenshotDataUrl: lastScreenshotDataUrl,
      hasScreenshot: true,
    }
  }

  try {
    emitMilestoneLog(
      playbookKey
        ? `Stagehand：初始化（剧本命中 ${playbookKey.slice(0, 8)}…）`
        : 'Stagehand：初始化…',
    )
    params.emit({ type: 'state', payload: { phase: 'stagehand_init', stepCount: 0, pageUrl: startUrl || '' } })
    await stagehand.init()
    stepCount++
    emitLiveView()

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
        await emitScreenshot()
      } catch (e: any) {
        navErrMsg = String(e?.message || e).slice(0, 160)
        emitLog('warn', `goto 失败，改 act：${navErrMsg}`)
        try {
          await stagehand.act(`打开页面 ${startUrl}`)
          stepCount++
          await emitScreenshot()
        } catch (e2: any) {
          navFailed = true
          navErrMsg = String(e2?.message || e2).slice(0, 160)
          emitLog('warn', `导航失败：${navErrMsg}`)
        }
      }
      const netPage = await detectStagehandNetworkErrorPage(stagehand, startUrl)
      if (navFailed || netPage.unreachable) {
        const failureType = normalizeWebFailureCode('network')
        const pageHint = netPage.url || startUrl
        const titleHint = netPage.title ? `，标题：${netPage.title}` : ''
        const failAnswer = `无法访问目标页面（网络/DNS 或浏览器错误页）${
          navErrMsg ? `：${navErrMsg}` : ''
        }。当前页：${pageHint}${titleHint}`
        emitLog('error', `导航 fail-closed：${failureType} @ ${pageHint}`)
        await emitScreenshot(true)
        const output = wrapLobsterOutput(
          withShot({
            traceId,
            task: params.task,
            finalUrl: pageHint,
            plan: planSteps,
            goals: goals || undefined,
            successCriteria: structuredCriteria,
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
          }),
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
      if (actionStepsUsed >= actionBudget) {
        stepBudgetExceeded = true
        emitLog('warn', `步数预算耗尽（${actionBudget}），截断后续步骤`)
        break
      }
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
          actionStepsUsed++
        } catch (e: any) {
          emitLog('warn', `${step.op} 跳过：${String(e?.message || e).slice(0, 100)}`)
        }
        continue
      }

      emitThinking('step', `${stepIdx}/${planSteps.length} ${step.op}`)
      actionStepsUsed++

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
        if (clicked) await emitScreenshot()
        // mustLeave 且仍未离开：停止后续 extract 当成功产物，交 verify / gui-plus
        if (mustLeave && !leaveStartOk) {
          emitLog('warn', `离开首页未完成，跳过后续步骤（${lastClickFailReason || 'still_on_start'}）`)
          break
        }
        continue
      }

      if (step.op === 'type' || step.op === 'submit') {
        const taskKind = String(params.taskSpec?.task_kind || '').trim()
        const formOperate = taskKind === 'form_fill' || taskKind === 'login'
        const mustSubmit = params.taskSpec?.goals?.must_submit === true
        const isSearchOperate =
          taskKind === 'search' || leanKind === 'search_extract' || leanKind === 'search_open'

        // 搜索：百度直达或 Playwright 填 searchbox；禁止把「在搜索框输入…」丢给 Stagehand act（会空转卡住）
        if (isSearchOperate && step.op === 'type') {
          const pageUrlNow = await readStagehandPageUrl(stagehand, startUrl)
          const q = searchQuery || extractSearchQueryFromTask(params.task)
          if (!q) {
            emitLog('warn', 'search type 无关键词，跳过')
            continue
          }
          if (isBaiduHost(pageUrlNow) && !baiduNeedsDirectSearch(pageUrlNow)) {
            leaveStartOk = true
            emitThinking('step', '已在搜索结果页，跳过 type')
            continue
          }
          if (isBaiduHost(pageUrlNow || startUrl) && baiduNeedsDirectSearch(pageUrlNow || startUrl)) {
            const dest = baiduSearchUrl(q)
            try {
              await gotoStagehandUrl(stagehand, dest)
              stepCount++
              leaveStartOk = true
              lastActNote = `baidu_direct:${q}`
              emitThinking('step', `百度直达搜索：${q.slice(0, 40)}`)
              await emitScreenshot()
            } catch (e: any) {
              emitLog('warn', `百度直达失败：${String(e?.message || e).slice(0, 120)}`)
            }
            continue
          }
          const sr = await playwrightPerformSearch(stagehand, { query: q })
          if (sr.ok) {
            stepCount++
            leaveStartOk = true
            lastActNote = `search:${q}`
            emitThinking('step', `已搜索 ${q.slice(0, 40)}`)
            await emitScreenshot()
          } else {
            emitLog('warn', `Playwright search 失败：${sr.reason || 'unknown'}`)
          }
          continue
        }

        // form_fill：确定性 recipe 填表，禁止依赖 Stagehand act JSON schema（Qwen 常失败）
        if (formOperate && step.op === 'type') {
          const recipeFields = resolveRecipeFormFields(params.task, startUrl)
          const extracted = await extractFormFieldsFromTask({
            task: params.task,
            startUrl,
            recipeFields,
            config: params.config,
            signal: params.signal,
          })
          if (!extracted.fields.length) {
            const pageUrl = (await readStagehandPageUrl(stagehand, startUrl)) || startUrl
            const failAnswer = buildFormFillClarifyMessage({
              reason: 'no_fields',
              requestedKeys: (recipeFields || []).map((r) => r.key),
              filledKeys: [],
              pageUrl,
            })
            const failureType = normalizeWebFailureCode('success_criteria_unmet')
            await emitScreenshot(true)
            const output = wrapLobsterOutput(
              withShot({
                traceId,
                task: params.task,
                finalUrl: pageUrl,
                plan: planSteps,
                goals: goals || undefined,
                successCriteria: structuredCriteria,
                stats: {
                  stepCount,
                  planSteps: planSteps.length,
                  latency_ms: Date.now() - startedAt,
                  enginePath: 'playwright_form',
                },
                data: [{ via: 'stagehand+playwright', text: failAnswer, url: startUrl }],
                answer: failAnswer,
                verify: { ok: false, reason: failureType },
                failureType,
                needs_clarification: true,
                clarification_questions: ['请补充要填写的字段名与取值'],
              }),
              'stagehand',
              { confirmCount, answer: failAnswer, failureType },
            )
            params.emit({ type: 'result', payload: output })
            return output
          }
          const pwForm = await playwrightFillFormFields(stagehand, {
            fields: extracted.fields,
            recipeFields,
          })
          if (pwForm.ok) {
            stepCount++
            formFilledEvidence = pwForm.filled
            const safeFilled = redactFormFieldsForLog(pwForm.filled)
            lastActNote = `form_fill:${safeFilled.map((f) => `${f.key}=${f.value}`).join(',')}`
            emitThinking('step', `已填 ${pwForm.filled.length} 字段`)
            await emitScreenshot()
          } else {
            emitLog('warn', `Playwright form_fill 失败：${pwForm.reason || 'unknown'}`)
            // fail-closed：填表失败不得假装成功继续 submit
            const failureType = normalizeWebFailureCode(
              /element_not_found/i.test(String(pwForm.reason || ''))
                ? 'element_not_found'
                : 'success_criteria_unmet',
            )
            const pageUrl = (await readStagehandPageUrl(stagehand, startUrl)) || startUrl
            const failAnswer = buildFormFillClarifyMessage({
              reason: pwForm.reason || 'no_fields',
              requestedKeys: extracted.fields.map((f) => f.key),
              filledKeys: (pwForm.filled || []).map((f) => f.key),
              pageUrl,
            })
            await emitScreenshot(true)
            const output = wrapLobsterOutput(
              withShot({
                traceId,
                task: params.task,
                finalUrl: pageUrl,
                plan: planSteps,
                goals: goals || undefined,
                successCriteria: structuredCriteria,
                stats: {
                  stepCount,
                  planSteps: planSteps.length,
                  latency_ms: Date.now() - startedAt,
                  enginePath: 'playwright_form',
                },
                data: [{ via: 'stagehand+playwright', text: failAnswer, url: startUrl }],
                answer: failAnswer,
                verify: { ok: false, reason: failureType },
                failureType,
                needs_clarification: true,
                clarification_questions: ['请确认字段名/取值，或改用工作流宏 httpbin-form-fill / w3school-form-fill'],
              }),
              'stagehand',
              { confirmCount, answer: failAnswer, failureType },
            )
            params.emit({ type: 'result', payload: output })
            return output
          }
          continue
        }

        if (formOperate && step.op === 'submit' && !mustSubmit) {
          emitLog('info', '跳过 submit（用户未要求提交）')
          continue
        }

        const instructional = isInstructionalFillTarget(String(step.target || ''))
        let filled: { ok: boolean; reason?: string } = { ok: false }
        if (!formOperate && !instructional) {
          filled = await playwrightFillAndSubmit(stagehand, step)
        } else if (!formOperate && instructional) {
          filled = { ok: false, reason: 'instructional_target' }
        }
        if (filled.ok) {
          stepCount++
          lastActNote = `${step.op} ok`
          await emitScreenshot()
        } else if (!formOperate && instructional && preferLlmAct) {
          // 仅显式开启 LLM act 时才走 Stagehand act；否则说明性 type 会空转卡住
          try {
            const actResult = await stagehand.act(withHint)
            lastActNote = String((actResult as any)?.message || '').slice(0, 200)
            stepCount++
            await emitScreenshot()
          } catch (e: any) {
            emitLog('warn', `act(${step.op}) 失败：${String(e?.message || e).slice(0, 120)}`)
          }
        } else if (!formOperate && instructional && !preferLlmAct) {
          emitLog('warn', `跳过说明性 ${step.op}（LLM act 关闭）：${String(step.target || '').slice(0, 60)}`)
        } else if (formOperate && step.op === 'submit' && mustSubmit) {
          const urlBeforeSubmit = await readStagehandPageUrl(stagehand, startUrl)
          const submitted = await playwrightFillAndSubmit(stagehand, step)
          if (submitted.ok) {
            stepCount++
              const urlAfter = await readStagehandPageUrl(stagehand, urlBeforeSubmit || startUrl)
              const isLogin = taskKind === 'login'
              if (isLogin && urlBeforeSubmit && urlAfter && isStillOnStartUrl(urlAfter, urlBeforeSubmit)) {
              // 登录提交后仍停在登录页：常见为验证码/密码错误 → HITL，不烧 gui-plus
              let captchaHint = false
              try {
                captchaHint = /captcha|wappass|verify|challenge/i.test(String(urlAfter || ''))
              } catch {
                /* ignore */
              }
              const failureType = normalizeWebFailureCode(captchaHint ? 'captcha' : 'login_wall')
              const failAnswer = `登录未完成（${failureType}）：提交后仍停留在登录页。请在浏览器画面人工完成验证码/二次确认，或导入已登录 Cookie（POST /api/lobster/session/import）。当前页：${urlAfter}`
              emitLog('warn', failAnswer.slice(0, 200))
              await emitScreenshot(true)
              const output = wrapLobsterOutput(
                withShot({
                  traceId,
                  task: params.task,
                  finalUrl: urlAfter,
                  plan: planSteps,
                  goals: goals || undefined,
                  successCriteria: structuredCriteria,
                  task_kind: 'login',
                  filled: redactFormFieldsForLog(formFilledEvidence),
                  stats: {
                    stepCount,
                    planSteps: planSteps.length,
                    latency_ms: Date.now() - startedAt,
                    enginePath: 'playwright_form',
                    filledCount: formFilledEvidence.length,
                  },
                  data: [{ via: 'stagehand+playwright', text: failAnswer, url: urlAfter }],
                  answer: failAnswer,
                  verify: { ok: false, reason: failureType },
                  failureType,
                  need_login: failureType === 'login_wall',
                }),
                'stagehand',
                { confirmCount, answer: failAnswer, failureType },
              )
              params.emit({ type: 'result', payload: output })
              return output
            }
            if (isLogin && urlAfter && urlBeforeSubmit && !isStillOnStartUrl(urlAfter, urlBeforeSubmit)) {
              leaveStartOk = true
            }
            lastActNote = isLogin ? 'login submit ok' : 'submit ok'
            await emitScreenshot()
          } else {
            emitLog('warn', `Playwright submit 失败：${submitted.reason || 'unknown'}`)
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
      const failureType = normalizeWebFailureCode(
        stepBudgetExceeded
          ? 'step_budget_exceeded'
          : lastClickFailReason && /no_candidates|not_found|click_fail/i.test(lastClickFailReason)
            ? 'element_not_found'
            : 'navigation_unverified',
      )
      const failAnswer = `浏览器任务未完成（${failureType}）：仍停留在起始页${
        lastClickFailReason ? `（click=${lastClickFailReason}）` : clickAttempted ? '' : '（未执行点击）'
      }。当前页：${finalUrl || startUrl}`
      await emitScreenshot(true)
      const output = wrapLobsterOutput(
        withShot({
          traceId,
          task: params.task,
          finalUrl: finalUrl || startUrl,
          plan: planSteps,
          goals: goals || undefined,
          successCriteria: structuredCriteria,
          task_kind: params.taskSpec?.task_kind,
          filled: formFilledEvidence,
          stats: {
            stepCount,
            planSteps: planSteps.length,
            latency_ms: Date.now() - startedAt,
            enginePath: 'playwright_first',
            filledCount: formFilledEvidence.length,
          },
          data: [{ via: 'stagehand+playwright', text: failAnswer, url: finalUrl || startUrl }],
          answer: failAnswer,
          verify: { ok: false, reason: failureType },
          failureType,
        }),
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

    const formOperateDone =
      String(params.taskSpec?.task_kind || '').trim() === 'form_fill' ||
      String(params.taskSpec?.task_kind || '').trim() === 'login'
    const filledSummary =
      formFilledEvidence.length > 0
        ? `已填 ${redactFormFieldsForLog(formFilledEvidence)
            .map((f) => `${f.key}=${f.value}`)
            .join('；')}`
        : ''

    const titleOut =
      String(extracted?.title || extracted?.items?.[0]?.title || pageTitle || '').trim()
    const answerText = formOperateDone && filledSummary
      ? `${filledSummary}${
          params.taskSpec?.goals?.must_submit ? '' : '（未提交）'
        }\n页面：${finalUrl || startUrl || ''}`
      : String(extracted?.summary || '').trim() ||
        (titleOut && finalUrl ? `标题：${titleOut}\n链接：${finalUrl}` : '') ||
        lastActNote ||
        (pageTitle ? `标题：${pageTitle}\n链接：${finalUrl}` : '')

    const extractCount = Math.max(
      titleOut ? 1 : 0,
      Array.isArray(extracted?.items) ? extracted!.items!.filter((it) => it?.title || it?.text || it?.url).length : 0,
      answerText ? 1 : 0,
    )
    const criteriaEval = evaluateSuccessCriteria({
      url: finalUrl || startUrl || '',
      title: titleOut || pageTitle,
      extractCount: formOperateDone ? 0 : extractCount,
      filledCount: formFilledEvidence.length,
      criteria: structuredCriteria,
    })

    await emitScreenshot(true)

    const safeFilledOut = redactFormFieldsForLog(formFilledEvidence)
    const rawOutput = wrapLobsterOutput(
      withShot({
        traceId,
        task: params.task,
        finalUrl,
        pageTitle: titleOut || pageTitle || undefined,
        plan: planSteps,
        goals: goals || undefined,
        successCriteria: structuredCriteria,
        task_kind: params.taskSpec?.task_kind,
        filled: safeFilledOut,
        stats: {
          stepCount,
          planSteps: planSteps.length,
          latency_ms: Date.now() - startedAt,
          enginePath: formOperateDone ? 'playwright_form' : 'playwright_first',
          actionStepsUsed,
          filledCount: formFilledEvidence.length,
        },
        data: [
          {
            via: formOperateDone ? 'playwright_form' : 'stagehand+playwright',
            text: answerText,
            url: finalUrl || undefined,
            filled: safeFilledOut,
            items:
              formFilledEvidence.length > 0
                ? formFilledEvidence.map((f) => ({ title: f.key, text: f.value }))
                : extracted?.items ||
                  (titleOut
                    ? [{ title: titleOut, url: finalUrl || extracted?.url || undefined }]
                    : []),
            summary: filledSummary || extracted?.summary,
          },
        ],
        answer: answerText,
      }),
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
    if (!failureType && stepBudgetExceeded) {
      failureType = 'step_budget_exceeded'
    }
    if (!failureType && !criteriaEval.ok) {
      failureType = 'success_criteria_unmet'
    }
    if (failureType) {
      failureType = normalizeWebFailureCode(failureType)
    }

    const failDetail =
      failureType === 'success_criteria_unmet'
        ? criteriaEval.missing.join(';') || criteriaEval.reason
        : verify.hints?.[0] || '请检查是否已进入目标页并提取到标题'

    const output = wrapLobsterOutput(
      {
        ...rawOutput,
        verify: {
          ok: !failureType && verify.ok,
          reason: failureType || verify.reason,
          ...(failureType === 'success_criteria_unmet'
            ? { missing: criteriaEval.missing }
            : {}),
        },
        failureType,
      },
      'stagehand',
      {
        confirmCount,
        answer: failureType
          ? `浏览器任务未完成（${failureType}）：${failDetail}。当前页：${finalUrl || startUrl || ''}`
          : answerText,
        failureType,
      },
    )

    if (failureType) {
      emitLog('error', `verify 失败：${failureType}`)
    } else {
      emitMilestoneLog(`完成 · ${String(titleOut || pageTitle || '').slice(0, 80)}`)
      try {
        savePlaybookEvolved({
          startUrl: startUrl || finalUrl,
          taskKind: params.taskSpec?.task_kind,
          goals: params.taskSpec?.goals,
          plan_steps: planSteps,
          runId: params.runId,
          sessionId: params.sessionId,
        })
      } catch {
        /* playbook 写入失败不影响主路径 */
      }
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
    if (opts?.sessionHandoff) {
      try {
        const page = getStagehandPage(stagehand)
        const sh = stagehand
        opts.sessionHandoff.page = page || undefined
        opts.sessionHandoff.close = async () => {
          try {
            await sh.close()
          } catch {
            /* ignore */
          }
        }
      } catch {
        try {
          await stagehand.close()
        } catch {}
      }
    } else {
      try {
        await stagehand.close()
      } catch {}
    }
  }
}
