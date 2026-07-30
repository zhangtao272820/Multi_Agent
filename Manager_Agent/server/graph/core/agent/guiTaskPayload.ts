export function extractStartUrlFromTask(task: string): string | undefined {
  const m = String(task || '').match(/https?:\/\/[^\s)\]"']+/i)
  return m?.[0]?.replace(/[.,;:!?)]+$/, '')
}

const ENGINE_HINT_RE = /(?:engine|引擎)\s*[:：]\s*(classic|mcp|stagehand|desktop|browser_use|browser-use)\b/i
const BROWSER_PROFILE_RE = /(?:browser[_\s-]?profile|浏览器\s*profile|profile)\s*[:：]\s*(managed|user)\b/i

const DESKTOP_TASK_RE =
  /(记事本|Notepad|桌面|Windows\s*应用|原生应用|Excel|Word|PowerPoint|设置|控制面板|资源管理器|Explorer|保存到桌面|Win\s*App|UWP|系统设置)/i

/** Windows 原生桌面任务（无 http(s) URL）→ engine=desktop */
export function isDesktopGuiTask(task: string, startUrl?: string): boolean {
  const url = String(startUrl || '').trim()
  if (url && /^https?:\/\//i.test(url)) return false
  return DESKTOP_TASK_RE.test(String(task || '').trim())
}

/**
 * 显式调用方 hint 语法（非意图识别主路径）：
 * - `工作流:httpbin-form-fill` / `customer_name=xxx`
 * - `引擎:classic|mcp|stagehand|desktop`
 * - `profile:managed|user` / `登录态:profile`
 * 语义上的 workflow / task_kind 由 LLM（guiOperateKind）判定；本函数只剥离显式标注。
 */
export function parseGuiTaskHints(task: string): {
  task: string
  engineHint?: string
  storageProfile?: string
  browserProfile?: 'managed' | 'user'
  /** 显式 `工作流:` hint；与 LLM workflow_id 合并时作 overlay */
  workflowId?: string
  workflowArgs?: Record<string, unknown>
} {
  let t = String(task || '').trim()
  let engineHint: string | undefined
  let storageProfile: string | undefined
  let browserProfile: 'managed' | 'user' | undefined
  let workflowId: string | undefined
  const workflowArgs: Record<string, unknown> = {}

  const engineMatch = t.match(ENGINE_HINT_RE)
  if (engineMatch?.[1]) {
    const raw = engineMatch[1].toLowerCase().replace(/-/g, '_')
    if (raw === 'browser_use') engineHint = undefined
    else engineHint = raw
    t = t.replace(ENGINE_HINT_RE, '').trim()
  }

  const profileMatch = t.match(BROWSER_PROFILE_RE)
  if (profileMatch?.[1]) {
    browserProfile = profileMatch[1].toLowerCase() === 'user' ? 'user' : 'managed'
    t = t.replace(BROWSER_PROFILE_RE, '').trim()
  }

  const storageMatch = t.match(/(?:storage[_\s-]?profile|登录态|会话)\s*[:：]\s*([a-zA-Z0-9._-]+)/i)
  if (storageMatch?.[1]) {
    storageProfile = storageMatch[1].trim()
    t = t.replace(storageMatch[0], '').trim()
  }

  // 显式调用方语法（非 regex 意图识别）：仅剥离标注，不据此推断任务语义
  const wfMatch = t.match(/(?:workflow|工作流|宏)\s*[:：]\s*([a-zA-Z0-9_-]+)/i)
  if (wfMatch?.[1]) {
    workflowId = wfMatch[1].trim()
    t = t.replace(wfMatch[0], '').trim()
  }

  const custMatch = t.match(/(?:customer[_\s-]?name|客户名|姓名)\s*[=:：]\s*([^\s,，]+)/i)
  if (custMatch?.[1]) {
    workflowArgs.customer_name = custMatch[1].trim()
    t = t.replace(custMatch[0], '').trim()
  }

  if (!engineHint && isDesktopGuiTask(t)) engineHint = 'desktop'

  return {
    task: t || String(task || '').trim(),
    engineHint,
    storageProfile,
    browserProfile,
    workflowId,
    workflowArgs: Object.keys(workflowArgs).length ? workflowArgs : undefined,
  }
}

function resolveTaskKindFromRaw(raw: Record<string, unknown>, opts?: { taskKind?: string }): string {
  if (opts?.taskKind) return String(opts.taskKind).trim()
  const fromRow = String(raw.task_kind || '').trim()
  if (fromRow) return fromRow
  const spec = raw.taskSpec && typeof raw.taskSpec === 'object' ? (raw.taskSpec as Record<string, unknown>) : null
  return String(spec?.task_kind || '').trim()
}

/**
 * 将 Lobster 原始结果整理成总管可读摘要。
 * form_fill/login：偏「做了什么」操作腔，禁止长文资讯分析。
 */
export function buildGuiResultForManager(
  raw: unknown,
  task: string,
  opts?: { taskKind?: string },
): string {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const agentResult = row.agentResult as { answer?: string; ok?: boolean; needs_clarify?: boolean } | undefined
  const taskKind = resolveTaskKindFromRaw(row, opts)
  const engine = String(row.engine || row.executionEngine || row.actualEngine || '').trim()
  const isOperate =
    taskKind === 'form_fill' ||
    taskKind === 'login' ||
    engine === 'workflow' ||
    Boolean(String(row.workflowId || '').trim())
  const finalUrl = String(row.finalUrl || row.url || '').trim()
  const data = Array.isArray(row.data) ? row.data : []
  const stats = row.stats && typeof row.stats === 'object' ? (row.stats as Record<string, unknown>) : {}
  const answer = String(agentResult?.answer || row.answer || '').trim()
  const workflowId = String(row.workflowId || '').trim()

  if (isOperate) {
    const lines: string[] = ['【浏览器操作】']
    if (taskKind) lines.push(`类型：${taskKind}`)
    if (workflowId) lines.push(`工作流：${workflowId}`)
    if (answer) lines.push(answer.slice(0, 1200))
    lines.push(
      agentResult?.ok === false || agentResult?.needs_clarify
        ? '状态：未完全成功（可能需 HITL / 登录确认）'
        : '状态：已执行操作',
    )
    if (engine) lines.push(`引擎：${engine}`)
    if (finalUrl) lines.push(`页面：${finalUrl}`)
    const stepCount = Number(stats.stepCount || 0)
    if (stepCount > 0) lines.push(`执行步数：${stepCount}`)
    return lines.filter(Boolean).join('\n').trim()
  }

  if (agentResult?.answer) return String(agentResult.answer).trim()

  const lines: string[] = []
  if (answer) lines.push(answer)
  if (engine) lines.push(`执行引擎：${engine}`)
  if (finalUrl) lines.push(`最终页面：${finalUrl}`)
  const stepCount = Number(stats.stepCount || 0)
  if (stepCount > 0) lines.push(`执行步数：${stepCount}`)

  for (const chunk of data.slice(-3)) {
    if (!chunk || typeof chunk !== 'object') continue
    const c = chunk as Record<string, unknown>
    const items = Array.isArray(c.items) ? c.items : null
    if (items?.length) {
      const preview = items
        .slice(0, 6)
        .map((it) => {
          const r = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
          const title = String(r.title || r.text || r.label || '').trim()
          const url = String(r.url || r.href || '').trim()
          return title ? (url ? `- ${title} (${url})` : `- ${title}`) : JSON.stringify(r).slice(0, 200)
        })
        .join('\n')
      if (preview) lines.push(preview)
    } else {
      const text = JSON.stringify(c)
      if (text && text !== '{}') lines.push(text.slice(0, 1500))
    }
  }

  const body = lines.join('\n').trim()
  return body || `GUI 自动化任务已完成：${String(task || '').trim()}`
}

export function guiSourceHitsForEvent(raw: unknown): Array<{ title: string; url: string; source: string }> {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const hits: Array<{ title: string; url: string; source: string }> = []
  const finalUrl = String(row.finalUrl || '').trim()
  if (finalUrl) hits.push({ title: '最终页面', url: finalUrl, source: 'gui' })
  const data = Array.isArray(row.data) ? row.data : []
  for (const chunk of data) {
    if (!chunk || typeof chunk !== 'object') continue
    const items = Array.isArray((chunk as Record<string, unknown>).items)
      ? ((chunk as Record<string, unknown>).items as unknown[])
      : []
    for (const it of items.slice(0, 12)) {
      const r = it && typeof it === 'object' ? (it as Record<string, unknown>) : {}
      const url = String(r.url || r.href || '').trim()
      if (!url) continue
      hits.push({
        title: String(r.title || r.text || url).trim().slice(0, 120),
        url,
        source: 'gui'
      })
    }
  }
  return hits
}
