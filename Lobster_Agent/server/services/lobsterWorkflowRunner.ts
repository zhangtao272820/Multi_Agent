/**
 * Workflow Macro 执行器：确定性 Playwright 步骤 + approve 闸门
 * 对齐 openclaw/lobster：一步调用可复现流水线，失败不静默降级为 LLM 点选（由调用方决定是否回退）
 */
import { chromium, type Page } from 'playwright'
import type { RunParams } from './lobster/types'
import { buildChromiumLaunchOptions } from '../utils/chromiumLaunch'
import { resolveEffectiveHeadless } from '../utils/lobster_env'
import { ensureLobsterGuiFinalPayload } from './lobsterGuiFinalPayload'
import {
  assertRequiredWorkflowArgs,
  loadLobsterWorkflow,
  resolveWorkflowArgs,
} from './lobsterWorkflowLoader'
import {
  interpolateWorkflowText,
  type LobsterWorkflowDef,
  type LobsterWorkflowStep,
} from './lobsterWorkflowSchema'

function emitLog(params: RunParams, level: 'info' | 'warn' | 'error', message: string) {
  params.emit({
    type: 'log',
    payload: { level, message: String(message || '').slice(0, 2000), ts: Date.now() },
  })
}

function autoApproveEnabled(): boolean {
  return String(process.env.LOBSTER_WORKFLOW_AUTO_APPROVE ?? '0').trim() === '1'
}

/** 拆分 CSS 逗号选择器，逐个定位并回读校验（禁止只 fill 不验） */
export async function workflowFillWithVerify(
  page: Page,
  selector: string,
  text: string,
  opts?: { clear?: boolean; timeoutMs?: number },
): Promise<void> {
  const want = String(text || '')
  const timeoutMs = opts?.timeoutMs || 15_000
  const parts = String(selector || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const candidates = parts.length ? parts : [String(selector || '').trim()].filter(Boolean)
  if (!candidates.length) throw new Error('workflow_fill_no_selector')

  let lastErr = ''
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout: timeoutMs })
      if (opts?.clear === false) await loc.type(want, { timeout: timeoutMs })
      else await loc.fill(want, { timeout: timeoutMs })
      const got = String((await loc.inputValue().catch(() => '')) || '')
      if (got === want) return
      lastErr = `value_mismatch sel=${sel} got=${got.slice(0, 40)}`
    } catch (e: any) {
      lastErr = String(e?.message || e).slice(0, 160)
    }
  }
  throw new Error(`workflow_fill_failed: ${lastErr || selector}`)
}

export async function workflowReadValue(page: Page, selector: string, attr?: string): Promise<string> {
  const parts = String(selector || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const candidates = parts.length ? parts : [String(selector || 'body').trim()]
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first()
      if (attr) {
        if (attr === 'value') {
          const v = await loc.inputValue().catch(async () => String((await loc.getAttribute('value')) || ''))
          if (v != null && String(v).length) return String(v)
        }
        const a = await loc.getAttribute(attr).catch(() => null)
        if (a != null) return String(a)
      } else {
        const t = String((await loc.innerText().catch(() => '')) || '').trim()
        if (t) return t
      }
    } catch {
      /* try next */
    }
  }
  return ''
}

async function emitWorkflowScreenshot(page: Page, params: RunParams) {
  try {
    if (typeof page.screenshot !== 'function') return
    const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false })
    const dataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`
    params.emit({
      type: 'screenshot',
      payload: { dataUrl, pageUrl: page.url(), ts: Date.now() },
    })
  } catch {
    /* 截图失败不挡主路径 */
  }
}

async function runStep(input: {
  page: Page
  step: LobsterWorkflowStep
  vars: Record<string, string>
  params: RunParams
  stepIndex: number
  typedExpected: Array<{ selector: string; text: string }>
}): Promise<{ done?: boolean; answer?: string }> {
  const { page, step, vars, params, stepIndex, typedExpected } = input
  const label = `wf[${stepIndex + 1}/${step.action}]`

  if (step.action === 'goto') {
    const url = interpolateWorkflowText(step.url, vars)
    emitLog(params, 'info', `${label} goto ${url}`)
    await page.goto(url, {
      waitUntil: step.waitUntil || 'domcontentloaded',
      timeout: 60_000,
    })
    vars.pageUrl = page.url()
    await emitWorkflowScreenshot(page, params)
    return {}
  }

  if (step.action === 'snapshot') {
    const title = await page.title().catch(() => '')
    const url = page.url()
    vars.pageTitle = title
    vars.pageUrl = url
    if (step.assignTo) vars[step.assignTo] = `${title} | ${url}`
    emitLog(params, 'info', `${label} title=${title.slice(0, 80)}`)
    params.emit({
      type: 'state',
      payload: {
        phase: 'workflow_snapshot',
        stepCount: stepIndex + 1,
        pageUrl: url,
        pageTitle: title,
        ts: Date.now(),
      } as any,
    })
    await emitWorkflowScreenshot(page, params)
    return {}
  }

  if (step.action === 'click') {
    const sel = interpolateWorkflowText(step.selector, vars)
    const timeoutMs = step.timeoutMs || 15_000
    emitLog(params, 'info', `${label} click ${sel}${step.optional ? ' (optional)' : ''}`)
    try {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean)
      let clicked = false
      let lastErr = ''
      for (const part of parts.length ? parts : [sel]) {
        try {
          await page.locator(part).first().click({ timeout: timeoutMs })
          clicked = true
          break
        } catch (e: any) {
          lastErr = String(e?.message || e).slice(0, 160)
        }
      }
      if (!clicked) throw new Error(lastErr || `click failed: ${sel}`)
    } catch (e: any) {
      if (step.optional) {
        emitLog(params, 'warn', `${label} optional click skipped: ${String(e?.message || e).slice(0, 160)}`)
        return {}
      }
      throw e
    }
    await emitWorkflowScreenshot(page, params)
    return {}
  }

  if (step.action === 'type') {
    const sel = interpolateWorkflowText(step.selector, vars)
    const text = interpolateWorkflowText(step.text, vars)
    emitLog(params, 'info', `${label} type ${sel}`)
    await workflowFillWithVerify(page, sel, text, {
      clear: step.clear !== false,
      timeoutMs: step.timeoutMs || 15_000,
    })
    typedExpected.push({ selector: sel, text })
    params.emit({
      type: 'state',
      payload: {
        phase: 'workflow_type',
        stepCount: stepIndex + 1,
        pageUrl: page.url(),
        ts: Date.now(),
      } as any,
    })
    await emitWorkflowScreenshot(page, params)
    return {}
  }

  if (step.action === 'extract') {
    const sel = step.selector ? interpolateWorkflowText(step.selector, vars) : 'body'
    const value = await workflowReadValue(page, sel, step.attr)
    vars[step.assignTo] = value
    emitLog(params, 'info', `${label} extract ${step.assignTo}=${value.slice(0, 120)}`)
    return {}
  }

  if (step.action === 'wait') {
    emitLog(params, 'info', `${label} wait ${step.ms}ms`)
    await page.waitForTimeout(step.ms)
    return {}
  }

  if (step.action === 'approve') {
    const title = interpolateWorkflowText(step.title, vars)
    const message = interpolateWorkflowText(step.message, vars)
    emitLog(params, 'info', `${label} approve: ${title}`)
    params.emit({
      type: 'state',
      payload: {
        phase: 'workflow_approve',
        stepCount: stepIndex + 1,
        pageUrl: page.url(),
        ts: Date.now(),
      } as any,
    })
    await emitWorkflowScreenshot(page, params)
    if (autoApproveEnabled()) {
      emitLog(params, 'warn', `${label} LOBSTER_WORKFLOW_AUTO_APPROVE=1 · 已自动通过`)
      return {}
    }
    if (!params.human?.waitConfirm) {
      throw new Error('lobster_workflow_approve_requires_human')
    }
    const id = `wf_approve_${stepIndex}_${Date.now()}`
    params.emit({
      type: 'confirm',
      payload: { id, title, message, ts: Date.now() },
    })
    const ok = await params.human.waitConfirm(id, params.signal)
    if (!ok) throw new Error('lobster_workflow_approve_denied')
    params.emit({
      type: 'state',
      payload: {
        phase: 'workflow_approved',
        stepCount: stepIndex + 1,
        pageUrl: page.url(),
        ts: Date.now(),
      } as any,
    })
    return {}
  }

  if (step.action === 'finish') {
    const answer = interpolateWorkflowText(step.answer, vars)
    return { done: true, answer }
  }

  return {}
}

function emitWorkflowInsight(params: RunParams, workflowId: string) {
  const ts = Date.now()
  params.emit({
    type: 'understand',
    payload: {
      ts,
      taskSpec: {
        task_kind: 'form_fill',
        plan_steps: ['goto', 'type', 'approve', 'extract'],
        goals: { must_leave_start: false, must_extract: true, must_submit: false, expected_url_change: false },
        confidence: 1,
        rationale: `workflow_id=${workflowId}`,
        engine_hint: 'auto',
      },
      picked: { engine: 'workflow', source: 'workflow_id', confidence: 1 },
      profile: 'managed',
    },
  })
  params.emit({
    type: 'engine_chain',
    payload: {
      ts,
      chain: ['workflow'],
      activeIndex: 0,
      workflowId,
      picked: {
        engine: 'workflow',
        source: 'workflow_id',
        confidence: 1,
        reason: `workflow_id=${workflowId}`,
      },
    },
  })
  params.emit({
    type: 'engine_active',
    payload: {
      ts,
      engine: 'workflow',
      actualEngine: 'workflow',
      attemptIndex: 0,
      workflowId,
    },
  })
  params.emit({
    type: 'run_meta',
    payload: {
      ts,
      runId: params.runId,
      actualEngine: 'workflow',
      engine: 'workflow',
      workflowId,
      storageProfile: params.storageProfile,
    },
  })
}

/** 确认后回读：已 type 的字段仍须等于期望值，否则 fail-closed */
async function assertTypedValuesStillHold(
  page: Page,
  typedExpected: Array<{ selector: string; text: string }>,
): Promise<Array<{ key: string; value: string }>> {
  const filled: Array<{ key: string; value: string }> = []
  for (const row of typedExpected) {
    const got = await workflowReadValue(page, row.selector, 'value')
    if (got !== row.text) {
      throw new Error(
        `workflow_fill_not_persisted: expected=${row.text.slice(0, 40)} got=${got.slice(0, 40)} sel=${row.selector.slice(0, 80)}`,
      )
    }
    filled.push({ key: row.selector.slice(0, 40), value: row.text })
  }
  return filled
}

export async function runLobsterWorkflowAgent(params: RunParams & { workflowId: string }) {
  const workflowId = String(params.workflowId || '').trim()
  const def: LobsterWorkflowDef = loadLobsterWorkflow(workflowId)
  const vars = resolveWorkflowArgs(def, params.workflowArgs || null, {
    task: params.task,
    startUrl: String(params.startUrl || ''),
  })
  if (params.startUrl && !vars.startUrl) vars.startUrl = params.startUrl
  assertRequiredWorkflowArgs(def, vars)

  emitWorkflowInsight(params, def.id)
  emitLog(params, 'info', `Workflow Macro：${def.id} · ${def.name} · ${def.steps.length} 步`)

  const configHeadless = params.config?.lobster?.headless !== false
  const headless = resolveEffectiveHeadless(configHeadless)
  const launch = buildChromiumLaunchOptions(headless)
  const browser = await chromium.launch({
    headless,
    args: launch.args,
    env: launch.env,
    executablePath: launch.executablePath || undefined,
  })

  let finalAnswer = ''
  let finalUrl = ''
  let pageTitle = ''
  const stepLog: Array<{ i: number; action: string; ok: boolean; detail?: string }> = []
  const typedExpected: Array<{ selector: string; text: string }> = []
  let filledEvidence: Array<{ key: string; value: string }> = []

  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    if (vars.startUrl && !def.steps.some((s) => s.action === 'goto')) {
      await page.goto(vars.startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await emitWorkflowScreenshot(page, params)
    }

    for (let i = 0; i < def.steps.length; i++) {
      if (params.signal.aborted) throw new Error('canceled')
      await params.human?.waitWhilePaused?.(params.signal)
      const step = def.steps[i]
      try {
        const r = await runStep({ page, step, vars, params, stepIndex: i, typedExpected })
        stepLog.push({ i, action: step.action, ok: true })
        if (r.done) {
          finalAnswer = String(r.answer || '').trim()
          break
        }
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e)
        stepLog.push({ i, action: step.action, ok: false, detail: msg.slice(0, 300) })
        throw e
      }
    }

    if (typedExpected.length) {
      filledEvidence = await assertTypedValuesStillHold(page, typedExpected)
    }

    finalUrl = page.url()
    pageTitle = await page.title().catch(() => '')
    if (!finalAnswer) {
      finalAnswer = `工作流 ${def.id} 已执行 ${stepLog.filter((s) => s.ok).length}/${def.steps.length} 步`
      if (pageTitle) finalAnswer += `\n标题：${pageTitle}`
      if (finalUrl) finalAnswer += `\n链接：${finalUrl}`
    }

    await emitWorkflowScreenshot(page, params)

    const verifyOk = true
    params.emit({
      type: 'verify',
      payload: {
        ts: Date.now(),
        engine: 'workflow',
        attemptIndex: 0,
        verify: {
          ok: verifyOk,
          reason: 'workflow_complete',
          failureType: undefined,
          hints: [`工作流 ${def.id} 完成`],
          retryable: false,
        },
      },
    })
    params.emit({
      type: 'state',
      payload: {
        phase: 'workflow_done',
        stepCount: stepLog.length,
        pageUrl: finalUrl,
        pageTitle,
        ts: Date.now(),
      } as any,
    })

    const raw = ensureLobsterGuiFinalPayload(
      {
        ok: true,
        engine: 'workflow',
        actualEngine: 'workflow',
        workflowId: def.id,
        task: params.task,
        answer: finalAnswer,
        finalUrl,
        pageTitle,
        filled: filledEvidence,
        stats: {
          stepCount: stepLog.length,
          planSteps: def.steps.length,
          filledCount: filledEvidence.length,
          enginePath: 'workflow',
        },
        verify: { ok: true, reason: 'workflow_complete' },
        data: [{ items: [{ workflow: def.id, steps: stepLog, filled: filledEvidence }] }],
      },
      params.task,
    )

    params.emit({ type: 'result', payload: raw as any })
    return raw
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e)
    const failureType = /approve_denied|canceled/i.test(msg)
      ? /denied/i.test(msg)
        ? 'denied'
        : 'canceled'
      : /fill_|not_persisted|element/i.test(msg)
        ? 'success_criteria_unmet'
        : 'workflow_error'
    const failAnswer = `工作流 ${def.id} 失败：${msg.slice(0, 240)}`
    params.emit({
      type: 'verify',
      payload: {
        ts: Date.now(),
        engine: 'workflow',
        attemptIndex: 0,
        verify: {
          ok: false,
          reason: failureType,
          failureType,
          hints: [failAnswer],
          retryable: failureType === 'success_criteria_unmet',
        },
      },
    })
    const raw = ensureLobsterGuiFinalPayload(
      {
        ok: false,
        engine: 'workflow',
        actualEngine: 'workflow',
        workflowId: def.id,
        task: params.task,
        answer: failAnswer,
        finalUrl: finalUrl || vars.startUrl || '',
        pageTitle,
        failureType,
        filled: filledEvidence,
        verify: { ok: false, reason: failureType },
        data: [{ items: [{ workflow: def.id, steps: stepLog, error: msg.slice(0, 300) }] }],
      },
      params.task,
    )
    params.emit({ type: 'result', payload: raw as any })
    return raw
  } finally {
    await browser.close().catch(() => {})
  }
}

export function isLobsterWorkflowId(raw: unknown): boolean {
  const s = String(raw || '').trim()
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s)
}
