/**
 * OpenClaw Lobster 对齐 · Workflow Macro schema（确定性管道 + approve）
 */
import { z } from 'zod'

export const LobsterWorkflowStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('goto'),
    url: z.string().min(1),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  }),
  z.object({
    action: z.literal('snapshot'),
    /** 仅观测：把标题/URL 写入 vars */
    assignTo: z.string().optional(),
  }),
  z.object({
    action: z.literal('click'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    /** true：元素缺失时跳过（关登录弹窗等），禁止当成功证据 */
    optional: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('type'),
    selector: z.string().min(1),
    text: z.string(),
    clear: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal('extract'),
    selector: z.string().optional(),
    /** css text / attribute */
    attr: z.string().optional(),
    assignTo: z.string().min(1),
  }),
  z.object({
    action: z.literal('wait'),
    ms: z.number().int().positive().max(120_000),
  }),
  z.object({
    action: z.literal('approve'),
    title: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    action: z.literal('finish'),
    /** 支持 {{var}} 插值 */
    answer: z.string().min(1),
  }),
])

export const LobsterWorkflowDefSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  description: z.string().optional(),
  /** 声明可用参数名；运行时由 workflow_args / 任务默认填入 */
  args: z.array(z.string()).default([]),
  steps: z.array(LobsterWorkflowStepSchema).min(1).max(40),
})

export type LobsterWorkflowStep = z.infer<typeof LobsterWorkflowStepSchema>
export type LobsterWorkflowDef = z.infer<typeof LobsterWorkflowDefSchema>

/** 将 {{key}} 替换为 args 值；未知键保留原样 */
export function interpolateWorkflowText(template: string, vars: Record<string, string>): string {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    const k = String(key || '').trim()
    if (!k) return ''
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? '') : `{{${k}}}`
  })
}

export function parseLobsterWorkflowDef(raw: unknown): LobsterWorkflowDef {
  return LobsterWorkflowDefSchema.parse(raw)
}
