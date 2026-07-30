import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { readManagerSession, writeManagerSession } from '../../utils/session/managerSessionStore'
import { buildTaskScopedRagHistory } from '../../graph/core/routing/clauses'
import { loadTaskStack, saveTaskStack } from '../../graph/core/task/taskStack'
import { applyUserTaskStackIngest } from '../../graph/core/task/taskStackIngest'
import { bindSessionToUser, resolveUserId } from '../../graph/core/task/userIdentity'
import { linkSessionToUserGoals } from '../../graph/core/task/userGoals'
import { recordImplicitLearningSignal } from '../../graph/core/evolution/implicitLearning'
import { extractAdminPendingOps } from '../../graph/core/stepIsolation'
import { buildRunObservabilityPayload } from '../../graph/core/runtime/runObservability'
import { buildActionCardsFromHumanConfirm } from '../../graph/core/output/actionCard'
import { effectiveAgentTimeoutMs } from '../../graph/core/shared/llmJson'
import { resolveAgentEndpointsWithPlatform } from '../../utils/platform/agentPlatformSync'
import { RunIdSchema } from './schemas'
import { runMeta, type WsSession } from './runtimeState'

export type { WsSession }
export type Session = WsSession

export function policyDataDir() {
  return path.join(process.cwd(), '.data')
}

export function graphAgentEndpoints(
  agents: Record<string, unknown>,
  resolved: Awaited<ReturnType<typeof resolveAgentEndpointsWithPlatform>>
) {
  return {
    dbAgentWsUrl: resolved.dbAgentWsUrl || String(agents.dbAgentWsUrl || ''),
    dbAgentHttpUrl: resolved.dbAgentHttpUrl || String(agents.dbAgentHttpUrl || ''),
    ragAgentHttpUrl: resolved.ragAgentHttpUrl || String(agents.ragAgentHttpUrl || ''),
    codeAgentWsUrl: resolved.codeAgentWsUrl || String(agents.codeAgentWsUrl || ''),
    crawlerAgentWsUrl: resolved.crawlerAgentWsUrl || String(agents.crawlerAgentWsUrl || ''),
    lobsterAgentWsUrl: resolved.lobsterAgentWsUrl || String(agents.lobsterAgentWsUrl || ''),
    aiAdminAgentWsUrl: resolved.aiAdminAgentWsUrl || String(agents.aiAdminAgentWsUrl || ''),
    multimodalAgentHttpUrl: resolved.multimodalAgentHttpUrl || String(agents.multimodalAgentHttpUrl || ''),
    musicAgentWsUrl: resolved.musicAgentWsUrl || String(agents.musicAgentWsUrl || ''),
    videoAgentWsUrl: resolved.videoAgentWsUrl || String(agents.videoAgentWsUrl || ''),
    timeoutMs: effectiveAgentTimeoutMs(Number(agents.timeoutMs || process.env.AGENT_TIMEOUT_MS || 60_000)),
    platformOffline: resolved.platformOffline
  }
}

export async function emitImplicitLearning(
  runId: string,
  sessionId: string,
  kind: 'user_cancel' | 'new_chat_interrupt' | 'human_reject'
) {
  const meta = runMeta.get(runId)
  const durationMs = meta ? Date.now() - meta.startedAtMs : undefined
  try {
    await recordImplicitLearningSignal(policyDataDir(), {
      runId,
      sessionId: meta?.sessionId || sessionId,
      kind,
      durationMs
    })
  } catch {}
}

export async function ingestTaskStackFromUserMessage(
  sessionId: string,
  userText: string,
  send: (event: string, data: unknown, from?: string, runId?: string) => void,
  runId: string,
  llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string }
) {
  try {
    const r = await applyUserTaskStackIngest(policyDataDir(), sessionId, userText, llm)
    if (!r.applied) return
    send('task_stack', { stack: r.stack }, 'manager', runId)
    const verb =
      r.action === 'add' ? '已自动加入任务栈' : r.action === 'done' ? '已标记任务完成' : '已从任务栈移除'
    send('thinking', `${verb}：${r.title || ''}`, 'manager', runId)
  } catch {}
}

export async function ensureUserBinding(sessionId: string, userId?: string) {
  const dir = policyDataDir()
  const uid = await resolveUserId(dir, sessionId, userId)
  if (uid && userId) await bindSessionToUser(dir, sessionId, userId).catch(() => undefined)
  if (uid) await linkSessionToUserGoals(dir, uid, sessionId).catch(() => undefined)
  return uid
}

export async function clearExperience() {
  const dir = policyDataDir()
  const memJsonlPath = path.join(dir, 'manager-memory.jsonl')
  const memJsonPath = path.join(dir, 'manager-memory.json')
  const policyPath = path.join(dir, 'manager-policy.json')

  let removed = 0
  let kept = 0

  const readJson = async (p: string) => {
    try {
      const t = await fs.readFile(p, 'utf8')
      return t.trim() ? JSON.parse(t) : null
    } catch {
      return null
    }
  }

  const filterLines = (lines: string[]) => {
    const out: string[] = []
    for (const line of lines) {
      const s = String(line || '').trim()
      if (!s) continue
      try {
        const obj = JSON.parse(s)
        if (obj?.type === 'experience') {
          removed += 1
          continue
        }
        kept += 1
        out.push(JSON.stringify(obj))
      } catch {
        kept += 1
        out.push(s)
      }
    }
    return out
  }

  const jsonlText = await fs.readFile(memJsonlPath, 'utf8').catch(() => '')
  if (jsonlText.trim()) {
    const lines = jsonlText.split('\n')
    const next = filterLines(lines)
    await fs.writeFile(memJsonlPath, next.length ? `${next.join('\n')}\n` : '', 'utf8').catch(() => undefined)
  }

  const jsonObj = await readJson(memJsonPath)
  const history = Array.isArray(jsonObj?.history) ? jsonObj.history : null
  if (history) {
    const nextHistory: unknown[] = []
    for (const h of history) {
      if ((h as { type?: string })?.type === 'experience') {
        removed += 1
        continue
      }
      nextHistory.push(h)
    }
    await fs.writeFile(memJsonPath, JSON.stringify({ ...jsonObj, history: nextHistory }, null, 2), 'utf8').catch(() => undefined)
  }

  await fs.unlink(policyPath).catch(() => undefined)
  return { removed, kept }
}

export async function readSession(sessionId: string) {
  return readManagerSession(sessionId)
}

export async function writeSession(sessionId: string, session: WsSession) {
  await writeManagerSession(sessionId, session)
}

export async function appendRunEvent(runId: string, event: { event: string; data?: unknown; from?: string; ts: string }) {
  const rid = String(runId || '').trim()
  if (!rid) return
  try {
    if (!RunIdSchema.safeParse(rid).success) return
    const dir = path.join(process.cwd(), '.data', 'runs')
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    const p = path.join(dir, `${rid}.jsonl`)
    const safeEvent = {
      event: String(event?.event || '').slice(0, 40),
      from: typeof event?.from === 'string' ? event.from.slice(0, 24) : undefined,
      ts: typeof event?.ts === 'string' ? event.ts : new Date().toISOString(),
      data: (() => {
        const d = event?.data
        if (typeof d === 'string') return d.length > 2000 ? `${d.slice(0, 2000)}…` : d
        if (typeof d === 'number' || typeof d === 'boolean' || d === null || d === undefined) return d
        try {
          const json = JSON.stringify(d)
          if (json.length <= 2000) return d
          return { clipped: json.slice(0, 2000) }
        } catch {
          return { clipped: String(d).slice(0, 2000) }
        }
      })()
    }
    await fs.appendFile(p, `${JSON.stringify(safeEvent)}\n`, 'utf8')
    const meta = runMeta.get(rid)
    void import('#agent-shared/runTraceStore')
      .then(({ appendRunTraceEvent }) =>
        appendRunTraceEvent({
          runId: rid,
          sessionId: meta?.sessionId,
          tenantId: meta?.tenantId,
          event: safeEvent.event,
          fromAgent: safeEvent.from,
          payload: safeEvent.data,
          ts: safeEvent.ts
        })
      )
      .catch(() => undefined)
  } catch {}
}

export function sanitizeHistoryText(input: string) {
  let s = String(input ?? '')
  s = s.replace(/Error:\s*Tool\s*`[^`]+`\s*not\s*found\.[^\n\r]*/gi, '')
  s = s.replace(/Tool\s*`[^`]+`\s*not\s*found\.[^\n\r]*/gi, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

export function stripAttachmentSuffix(content: string) {
  return String(content || '')
    .replace(/\n\[附件:[^\]]+\]\s*$/i, '')
    .replace(/^\[附件:[^\]]+\]\s*$/i, '')
    .trim()
}

export function buildUserContent(text: string, mediaAttachment?: { filename?: string; mediaType?: string } | null) {
  const trimmed = String(text ?? '').trim()
  if (trimmed && mediaAttachment?.filename) return `${trimmed}\n[附件: ${mediaAttachment.filename}]`
  if (trimmed && mediaAttachment) return `${trimmed}\n[附件: ${mediaAttachment.mediaType}]`
  if (trimmed) return trimmed
  if (mediaAttachment?.filename) return `[附件: ${mediaAttachment.filename}]`
  return `[附件: ${mediaAttachment?.mediaType || 'file'}]`
}

export function resolveUserMessageSessionIndex(messages: WsSession['messages'], userMessageIndex: number): number {
  if (!Array.isArray(messages) || userMessageIndex < 0) return -1
  let nth = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') {
      if (nth === userMessageIndex) return i
      nth++
    }
  }
  return -1
}

export async function pruneAutoUserTasksOnEditResend(policyDir: string, sessionId: string) {
  try {
    const stack = await loadTaskStack(policyDir, sessionId)
    const kept = stack.items.filter(
      (item) => !(item.source === 'user' && item.note === '用户对话自动入栈' && item.status === 'active')
    )
    if (kept.length === stack.items.length) return stack
    return await saveTaskStack(policyDir, { ...stack, items: kept })
  } catch {
    return null
  }
}

export function buildRagHistoryForRun(session: WsSession, currentUserText: string) {
  const all = session.messages
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: sanitizeHistoryText(m.content) }))
    .filter((m) => String(m.content || '').trim())
  const scoped = buildTaskScopedRagHistory(all, currentUserText)
  if (scoped.length) return scoped
  const last = all.filter((m) => m.role === 'user').slice(-1)
  return last
}

/** 仅认 Admin 写工具的 tool[id]，避免 GUI/synth 文案里任意 ident[n] 误触发 HITL */
const ADMIN_PENDING_TOOL_RE =
  /^(add_event|add_reminder|add_task|add_task_with_due|send_email|delete_event|delete_reminder|delete_task|update_event|update_reminder)$/i

export function extractKnownAdminPendingOps(text: string): string[] {
  return extractAdminPendingOps(text).filter((op) => {
    const name = String(op || '').replace(/\[\d+\]$/, '')
    return ADMIN_PENDING_TOOL_RE.test(name)
  })
}

/**
 * 图后是否应暂停 Admin 写确认。
 * 根因修复：禁止用最终 synth 全文做 extractAdminPendingOps（GUI 成功文案易含 foo[1] 误命中），
 * 且 GUI-only / 无 admin 待确认结构时不得弹「个人事务」卡。
 */
export function shouldPauseForPostGraphAdminConfirm(input: {
  meta?: Record<string, unknown> | null
  finalText?: string
  results?: Record<string, unknown> | null
  intent?: string
  plan?: Array<{ agent?: string }> | null
  evaluation?: { recommendation?: string } | null
}): boolean {
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}
  const results =
    (input.results && typeof input.results === 'object'
      ? input.results
      : (meta as { results?: Record<string, unknown> }).results) || {}
  const adminBlob = String((results as { admin?: string }).admin || '').trim()
  const guiBlob = String((results as { gui?: string }).gui || '').trim()
  const intent = String(input.intent || (meta as { intent?: string }).intent || '').trim()
  const plan = Array.isArray(input.plan)
    ? input.plan
    : Array.isArray((meta as { plan?: unknown }).plan)
      ? ((meta as { plan: Array<{ agent?: string }> }).plan)
      : []
  const planAgents = plan.map((s) => String(s?.agent || '').toLowerCase()).filter(Boolean)
  const guiOnly =
    intent === 'gui' ||
    (planAgents.length > 0 && planAgents.every((a) => a === 'gui')) ||
    (guiBlob && !adminBlob && planAgents.includes('gui') && !planAgents.includes('admin'))

  if (adminWriteAlreadyCompleted(meta, [input.finalText, adminBlob].filter(Boolean).join('\n'))) {
    return false
  }

  if (Boolean(meta.needsHumanConfirm)) {
    // 显式闸门：仍要求不是「纯 GUI 成功却误标」
    if (guiOnly && !adminBlob && !hasStructuralAdminPending(meta, adminBlob)) return false
    return true
  }

  if (hasStructuralAdminPending(meta, adminBlob)) return true

  // 禁止：仅凭 synth finalText / GUI 输出启发式弹 admin 确认
  if (guiOnly) return false

  // 非 GUI：仅当 admin 子输出含【待确认】或已知 tool[id]
  if (/【待确认】/.test(adminBlob)) return true
  if (extractKnownAdminPendingOps(adminBlob).length > 0 && !Boolean(meta.allowRiskyWrites)) return true

  return false
}

function hasStructuralAdminPending(meta: Record<string, unknown>, adminBlob: string): boolean {
  if (Array.isArray(meta.adminPendingOps) && meta.adminPendingOps.length > 0) return true
  const agentResult = meta.agentResult
  if (agentResult && typeof agentResult === 'object') {
    const ar = agentResult as { agent?: string; structured?: Record<string, unknown> }
    const agent = String(ar.agent || '').toLowerCase()
    // meta.agentResult 可能是 gui；只有 admin 的 pending 才算
    if (agent === 'admin' || agent === '') {
      if (ar.structured?.needs_human_confirm === true) return true
      const pending = ar.structured?.pending_actions
      if (Array.isArray(pending) && pending.length > 0) return true
    }
  }
  // evidence 里找 admin agentResult
  const evidence = Array.isArray(meta.evidence) ? meta.evidence : []
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    const row = e as { kind?: string; agentResult?: { structured?: Record<string, unknown> } }
    if (String(row.kind || '').toLowerCase() !== 'admin') continue
    const st = row.agentResult?.structured
    if (st?.needs_human_confirm === true) return true
    if (Array.isArray(st?.pending_actions) && st!.pending_actions!.length > 0) return true
  }
  if (/【待确认】/.test(adminBlob)) return true
  if (extractKnownAdminPendingOps(adminBlob).length > 0) return true
  return false
}

export function isHumanConfirmClarification(meta: Record<string, unknown> | null | undefined, finalText: string) {
  // 兼容旧调用：转为结构化闸门（不再对任意 finalText 做 tool[id] 扫描）
  return shouldPauseForPostGraphAdminConfirm({
    meta,
    finalText,
    results: (meta as { results?: Record<string, unknown> } | null | undefined)?.results
  })
}

/** admin 步骤已成功写入（日程/提醒等），不应再进入写确认闸门 */
export function adminWriteAlreadyCompleted(
  meta: Record<string, unknown> | null | undefined,
  finalText: string
): boolean {
  const records = Array.isArray(meta?.lastStepRecords)
    ? (meta!.lastStepRecords as Array<Record<string, unknown>>)
    : []
  const adminRecs = records.filter((r) => String(r?.agent || '').toLowerCase() === 'admin')
  if (adminRecs.length) {
    const anyPendingClarify = adminRecs.some(
      (r) =>
        r?.needsClarify === true ||
        String(r?.error || '').toLowerCase() === 'needs_clarify' ||
        /needs_clarify|needs_human_confirm/i.test(String(r?.error || ''))
    )
    if (anyPendingClarify) return false
    const allOk = adminRecs.every((r) => {
      const st = String(r?.status || '').toLowerCase()
      return st === 'ok' || st === 'success' || st === 'skipped'
    })
    if (allOk) return true
  }
  const blob = [
    String(finalText || ''),
    String((meta as { results?: { admin?: string } } | undefined)?.results?.admin || '')
  ].join('\n')
  if (/【待确认】/.test(blob)) return false
  if (/已添加日程|已设置提醒|已添加待办|reminder_created|event_id\s*[:=]/i.test(blob)) return true
  const verdict = meta?.verifierVerdict as { outcome?: string; verdict?: string } | undefined
  if (verdict?.outcome === 'completed' && verdict?.verdict === 'pass' && adminRecs.length) return true
  return false
}

export function emitAdminHumanConfirmRequest(
  send: (event: string, data?: unknown, from?: string, runId?: string) => void,
  runId: string,
  message: string,
  opts?: {
    confirmId?: string
    title?: string
    checkpointResume?: boolean
    agent?: string
    screenshotDataUrl?: string
    pageUrl?: string
    failureType?: string
    adminPendingOps?: unknown[]
  }
) {
  const confirmId = String(opts?.confirmId || randomUUID()).trim()
  const agent = String(opts?.agent || 'admin').trim() || 'admin'
  const payload = {
    title: String(opts?.title || (agent === 'gui' ? '浏览器操作待确认' : '个人事务写操作待确认')).trim(),
    message: String(message || '').trim() || '请确认是否继续执行写操作。',
    agent,
    confirmId,
    checkpointResume: opts?.checkpointResume !== false,
    ...(opts?.screenshotDataUrl ? { screenshotDataUrl: opts.screenshotDataUrl } : {}),
    ...(opts?.pageUrl ? { pageUrl: opts.pageUrl } : {}),
    ...(opts?.failureType ? { failureType: opts.failureType } : {})
  }
  send('human_confirm_request', payload, 'manager', runId)
  const actions = buildActionCardsFromHumanConfirm({
    agent,
    title: payload.title,
    message: payload.message,
    confirmId,
    screenshotDataUrl: opts?.screenshotDataUrl,
    pageUrl: opts?.pageUrl,
    failureType: opts?.failureType,
    adminPendingOps: opts?.adminPendingOps
  })
  send(
    'user_facing',
    {
      summary: payload.message,
      outcome: 'needs_human',
      outcomeLabel: '待你确认',
      actions
    },
    'manager',
    runId
  )
  return confirmId
}

export function pauseAdminConfirmMessage(result: { meta?: Record<string, unknown>; results?: Record<string, string> }) {
  const meta = result?.meta ?? {}
  const ops = Array.isArray(meta.adminPendingOps)
    ? meta.adminPendingOps.map((x) => String(x ?? '').trim()).filter(Boolean)
    : extractKnownAdminPendingOps(String(result?.results?.admin || ''))
  return ops.length ? `待执行：${ops.join('、')}` : '个人事务写操作'
}

export async function emitRunObservability(
  send: (event: string, data?: unknown, from?: string, runId?: string) => void,
  runId: string
) {
  try {
    const payload = await buildRunObservabilityPayload(runId)
    if (!payload.phaseTimeline.length && !payload.tokenSummary.totalTokens) return
    send('phase_timeline', payload, 'manager', runId)
    send(
      'run_metrics',
      {
        runId: payload.runId,
        wallClockMs: payload.wallClockMs,
        tokenSummary: payload.tokenSummary
      },
      'manager',
      runId
    )
  } catch {}
}
