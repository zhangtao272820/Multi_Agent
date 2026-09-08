import type { Step } from '../../../utils/shared/taskPlan'
import { appendSerpContextToQuery } from '../../../utils/search/managerWebSearch'
import { isAdminReadOnlyOrchestrationStep } from '../db/writeGate'
import {
  ACTION_EXEC_AGENTS,
  DATA_SOURCE_AGENTS,
  MEDIA_EXEC_AGENTS,
  MEDIA_EXEC_GUARDS,
  adminStepNeedsUpstreamData,
  buildAdminStepQuery,
  isUpstreamClarifyNoise,
  sanitizeStepQueryStructured
} from './sanitize'


/** 保留 API；admin 依赖由 Planner LLM 在 dependsOn 中声明 */
export function reconcileAdminPlanDeps(plan: Step[]): Step[] {
  return Array.isArray(plan) ? plan : []
}

export function shouldIncludeUpstreamDepForStep(step: Step, depAgent: Step['agent']): boolean {
  if (!DATA_SOURCE_AGENTS.has(depAgent)) return true
  if (step.agent === 'admin' && !adminStepNeedsUpstreamData(String(step.query || ''))) return false
  if (ACTION_EXEC_AGENTS.has(step.agent) && DATA_SOURCE_AGENTS.has(depAgent)) return false
  return true
}

/** 上游 missing 只给需要数据的事实消费方，不传给 admin 等执行 Agent */
export function shouldPassUpstreamMissing(stepAgent: Step['agent'], depAgent: Step['agent']): boolean {
  if (!DATA_SOURCE_AGENTS.has(depAgent)) return false
  return stepAgent === 'code' || stepAgent === 'visualize' || stepAgent === 'report' || stepAgent === 'clean'
}

export const ADMIN_EXEC_GUARD =
  '【总管约束】只执行本条中的日程/提醒/邮件/待办，或高德路线/周边/地址查询；勿向用户追问知识库/图表/数据库步骤的缺失项；路线须用高德工具结果，勿编造；用户已给出标题与时间则直接创建。'

export const ADMIN_READ_ONLY_ORCH_LINE =
  '【只读编排】禁止创建待办/写文件/设置会话策略/存放临时目录；仅基于「已知信息」用自然语言归纳回复，勿调用高风险写工具。'

export const ADMIN_AUTO_CONFIRM_LINE =
  '（强制）不要等待人工确认/不要要求用户回复“确认/取消”。请直接生成待办/提醒的执行结果与清单输出。'

export type BuildAdminExecMessageOpts = {
  fallbackTask?: string
  /** multi 步骤附加上游 digest；仅当 admin 需要上游数据时才注入 */
  upstreamContext?: string
  autoConfirm?: boolean
  readOnlyOrchestration?: boolean
}

const ADMIN_CONFIRM_PREVIEW_AGENTS = ['db', 'rag', 'code', 'clean', 'visualize', 'crawler'] as const

/** admin 写操作待确认时：展示已完成的上游结果，避免重复 synth 澄清文案 */
export function buildAdminConfirmPauseFinal(
  results: Record<string, string>,
  pendingOps: string[]
): string {
  const parts: string[] = []
  for (const key of ADMIN_CONFIRM_PREVIEW_AGENTS) {
    const v = String(results[key] || '').trim()
    if (v) parts.push(v)
  }
  const opLine = pendingOps.length ? pendingOps.join('、') : '个人事务写操作'
  parts.push(
    `\n\n---\n\n以上数据分析已完成。**${opLine}** 将在您点击上方「确认继续」后执行；不会重新查数或生成图表。`
  )
  return parts.join('\n\n').trim()
}

/**
 * 执行阶段 admin 入参唯一拼装口：净化子任务 + 可选上游上下文 + 总管约束 + 自动确认。
 */
export function buildAdminExecMessage(stepQuery: string, opts?: BuildAdminExecMessageOpts): string {
  const core = buildAdminStepQuery(
    String(stepQuery || '').trim() || String(opts?.fallbackTask || '').trim()
  )
  const parts: string[] = [core]
  const ctx = String(opts?.upstreamContext || '').trim()
  if (ctx && adminStepNeedsUpstreamData(core)) {
    parts.push('', '已知信息（来自上游步骤，仅供事实参考）：', ctx)
  }
  parts.push('', ADMIN_EXEC_GUARD)
  if (opts?.readOnlyOrchestration) parts.push('', ADMIN_READ_ONLY_ORCH_LINE)
  if (opts?.autoConfirm) parts.push('', ADMIN_AUTO_CONFIRM_LINE)
  return parts.join('\n')
}

/** multi 执行：为 admin 步骤生成 effQuery（含 guard，不含重复拼接） */
export function buildAdminEffectiveQuery(
  stepQuery: string,
  userTask: string,
  upstreamContext: string,
  autoConfirm?: boolean,
  readOnlyOrchestration?: boolean
): string {
  const q = String(stepQuery || '').trim()
  const ctx = adminStepNeedsUpstreamData(q || userTask) ? String(upstreamContext || '').trim() : ''
  return buildAdminExecMessage(q || userTask, {
    fallbackTask: userTask,
    upstreamContext: ctx,
    autoConfirm,
    readOnlyOrchestration
  })
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9')
}

function isDigitChar(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isSpaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** 从 admin 返回文本中提取待确认操作（仅 tool[id] 形态；禁止匹配裸 add_*，以免成功文案/计划 query 误判） */
export function extractAdminPendingOps(text: string): string[] {
  const s = String(text || '')
  const out: string[] = []
  const seen = new Set<string>()
  let i = 0
  while (i < s.length) {
    if (!isIdentStart(s[i]!)) {
      i++
      continue
    }
    let j = i + 1
    while (j < s.length && isIdentPart(s[j]!)) j++
    const name = s.slice(i, j)
    let k = j
    while (k < s.length && isSpaceChar(s[k]!)) k++
    if (s[k] === '[') {
      k++
      while (k < s.length && isSpaceChar(s[k]!)) k++
      const numStart = k
      while (k < s.length && isDigitChar(s[k]!)) k++
      if (k > numStart && s[k] === ']') {
        const op = `${name}[${s.slice(numStart, k)}]`
        if (!seen.has(op)) {
          seen.add(op)
          out.push(op)
        }
        i = k + 1
        continue
      }
    }
    i = j
  }
  return out.slice(0, 8)
}

/** admin 输出是否仍含待确认/澄清信号（用于观测，multi 默认不阻断） */
export function adminResponseSignalsPendingConfirm(text: string, agentResult?: { structured?: Record<string, unknown> } | null): boolean {
  const s = String(text || '').trim()
  if (!s) return false
  if (agentResult?.structured?.needs_human_confirm === true) return true
  const pending = agentResult?.structured?.pending_actions
  if (Array.isArray(pending) && pending.length > 0) return true
  if (isUpstreamClarifyNoise(s)) return true
  return extractAdminPendingOps(s).length > 0
}

export type AdminPendingActionRow = { id: number; tool?: string; title?: string; time?: string | null }

export function extractAdminPendingActions(agentResult?: { structured?: Record<string, unknown> } | null): AdminPendingActionRow[] {
  const raw = agentResult?.structured?.pending_actions
  if (!Array.isArray(raw)) return []
  const out: AdminPendingActionRow[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const id = Number((row as { id?: unknown }).id)
    if (!Number.isFinite(id) || id <= 0) continue
    out.push({
      id: Math.floor(id),
      tool: String((row as { tool?: unknown }).tool || '').trim() || undefined,
      title: String((row as { title?: unknown }).title || '').trim() || undefined,
      time: String((row as { time?: unknown }).time || '').trim() || null,
    })
  }
  return out.slice(0, 4)
}

export function buildMediaExecMessage(
  agent: 'multimodal' | 'music' | 'video',
  stepQuery: string,
  fallbackTask?: string,
  meta?: Record<string, unknown> | null
): string {
  const raw = String(stepQuery || '').trim() || String(fallbackTask || '').trim()
  const cleaned = sanitizeStepQueryStructured({ id: '', agent, query: raw }, agent)
  const guard = MEDIA_EXEC_GUARDS[agent]
  const base = guard ? `${cleaned}\n\n${guard}` : cleaned
  return appendSerpContextToQuery(base, meta, agent)
}

/** 无上游步骤时，用路由预读 caption 接地 db/rag query */
function captionContextFromMeta(meta?: Record<string, unknown> | null): string {
  if (!meta || typeof meta !== 'object') return ''
  const cap = String(meta.routeImageCaption || '').trim()
  if (!cap) {
    const att = meta.mediaAttachment
    if (att && typeof att === 'object' && !Array.isArray(att)) {
      const fromAtt = String((att as { caption?: string }).caption || '').trim()
      if (!fromAtt) return ''
      const ocrAtt = String((att as { ocrSnippet?: string }).ocrSnippet || '').trim()
      const lines = [`【附件画面摘要】${fromAtt}`]
      if (ocrAtt) lines.push(`【画面文字】${ocrAtt.slice(0, 80)}`)
      return lines.join('\n')
    }
    return ''
  }
  const ocr = String(meta.routeImageOcr || '').trim()
  const lines = [`【附件画面摘要】${cap}`]
  if (ocr) lines.push(`【画面文字】${ocr.slice(0, 80)}`)
  return lines.join('\n')
}

/**
 * multi / 单步执行：按 agent 类型生成 effQuery（执行类收口，其它 agent 保留通用上下文拼接）。
 */
export function buildActionExecEffectiveQuery(
  step: Step,
  userTask: string,
  upstreamContext: string,
  autoConfirm?: boolean,
  meta?: Record<string, unknown> | null
): string {
  const base = String(step.query || '').trim() || userTask
  const ctx = String(upstreamContext || '').trim()
  const captionCtx = !ctx ? captionContextFromMeta(meta) : ''

  if (step.agent === 'admin') {
    const readOnly = isAdminReadOnlyOrchestrationStep(base)
    return buildAdminEffectiveQuery(base, userTask, ctx || captionCtx, autoConfirm, readOnly)
  }
  if (MEDIA_EXEC_AGENTS.has(step.agent)) {
    const mediaBase = buildMediaExecMessage(step.agent as 'multimodal' | 'music' | 'video', base, userTask, meta)
    if (ctx && (step.agent === 'music' || step.agent === 'video')) {
      return `${mediaBase}\n\n【上游多模态分析结果（生成时须参考风格与氛围）】\n${ctx}`
    }
    return mediaBase
  }
  const factCtx = ctx || captionCtx
  if (factCtx && !isActionExecAgent(step.agent)) {
    return `${base}\n\n已知信息（来自上游步骤，仅供事实参考）：\n${factCtx}`
  }
  return base
}

export function isActionExecAgent(agent: Step['agent']): boolean {
  return ACTION_EXEC_AGENTS.has(agent)
}

export function isMediaExecAgent(agent: Step['agent']): boolean {
  return MEDIA_EXEC_AGENTS.has(agent)
}

