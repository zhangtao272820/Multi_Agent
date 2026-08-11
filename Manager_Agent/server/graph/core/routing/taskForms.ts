/**
 * 任务级形态（taskForm）：在不改变 allowedAgents / cap 权威的前提下，
 * 约束 queryFocus 形状与下游工具偏好。LLM + Zod 产出；禁止用户原话 regex 路由。
 */
import { z } from 'zod'

export const TASK_FORMS = [
  // db
  'db_count',
  'db_record',
  'db_profile',
  'db_aggregate',
  // rag
  'rag_standard',
  'rag_policy',
  'rag_manual',
  'rag_excerpt',
  // admin
  'admin_schedule',
  'admin_weather',
  'admin_mail',
  'admin_travel',
  'admin_brief',
  'admin_todo',
  // other planes
  'crawler_page',
  'gui_interact',
  'multimodal_ocr',
  'code_compute',
  'report_synth',
  'visualize_chart',
  'unknown'
] as const

export type TaskForm = (typeof TASK_FORMS)[number]

const TASK_FORM_SET = new Set<string>(TASK_FORMS)

/** taskIntent 值误填到 taskForm 时丢弃（勿当非法 unknown 污染） */
const TASK_INTENT_COLLISIONS = new Set([
  'hybrid',
  'structured_query',
  'document_retrieval',
  'action',
  'chitchat',
  'multi'
])

/** 解析可选 taskForm；非法 → unknown；与 taskIntent 撞名 → undefined */
export function coerceTaskForm(raw: unknown): TaskForm | undefined {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!s) return undefined
  if (TASK_INTENT_COLLISIONS.has(s)) return undefined
  if (TASK_FORM_SET.has(s)) return s as TaskForm
  return 'unknown'
}

/**
 * Zod 字段：宽松接收 LLM 字符串，非法/撞名不导致整包 parse 失败。
 * （根因：模型常把 taskIntent=hybrid 误写入 taskForm）
 */
export const TaskFormFieldSchema = z.preprocess((val) => {
  if (val == null || val === '') return undefined
  return coerceTaskForm(val)
}, z.enum(TASK_FORMS).optional())

/** 结构化时间区间（ISO 优先；由编排 LLM 填，子 Agent 落地） */
export type TimeRangeHint = {
  start?: string
  end?: string
  label?: string
}

export function coerceTimeRangeHint(raw: unknown): TimeRangeHint | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const start = String(o.start ?? o.from ?? '').trim().slice(0, 40)
  const end = String(o.end ?? o.to ?? '').trim().slice(0, 40)
  const label = String(o.label ?? o.text ?? '').trim().slice(0, 80)
  if (!start && !end && !label) return undefined
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(label ? { label } : {})
  }
}

/** taskForm 不得改写 cap：仅作提示文本 */
export function formatTaskFormHint(taskForm?: TaskForm | null): string {
  if (!taskForm || taskForm === 'unknown') return ''
  return `taskForm=${taskForm}（仅约束本步职责形状，禁止据此扩/缩 allowedAgents）`
}
