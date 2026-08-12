/**
 * form_fill 字段抽取（LLM 结构化；非 Stagehand act schema）
 */
import { z } from 'zod'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { createQwenChatModel } from './lobster/model'
import type { AgentConfig } from './lobster/types'
import { taskAffirmsSubmit } from './lobsterFormGoals'
import { matchSiteRecipe, type SiteFormField } from './siteRecipes'

export const FormFieldsExtractSchema = z.object({
  fields: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        value: z.string().max(200),
      }),
    )
    .max(12)
    .default([]),
  must_submit: z.boolean().default(false),
})

export type FormFieldValue = { key: string; value: string }

/** 标签锚定抽取（非意图路由）：First name 填X / last_name=Y */
export function extractFormFieldsHeuristic(task: string): FormFieldValue[] {
  const t = String(task || '')
  const out: FormFieldValue[] = []
  const push = (key: string, value: string) => {
    const v = String(value || '').trim()
    if (!v || out.some((x) => x.key === key)) return
    out.push({ key, value: v })
  }
  const m1 = t.match(/(?:first[_\s-]?name|fname)\s*(?:填|=|：|:)\s*([^\s，,。；;]+)/i)
  if (m1?.[1]) push('first_name', m1[1])
  const m2 = t.match(/(?:last[_\s-]?name|lname)\s*(?:填|=|：|:)\s*([^\s，,。；;]+)/i)
  if (m2?.[1]) push('last_name', m2[1])
  const m3 = t.match(/(?:customer[_\s-]?name|custname|客户名)\s*(?:填|=|：|:)\s*([^\s，,。；;]+)/i)
  if (m3?.[1]) push('customer_name', m3[1])
  return out
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const s = String(text || '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1))
          return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** LLM 结构化抽取表单字段值（避免 Stagehand act JSON schema 在 Qwen 下失败） */
export async function extractFormFieldsFromTask(input: {
  task: string
  startUrl?: string
  recipeFields?: SiteFormField[]
  config?: AgentConfig
  signal?: AbortSignal
}): Promise<{ fields: FormFieldValue[]; must_submit: boolean }> {
  const task = String(input.task || '').trim()
  if (!task) return { fields: [], must_submit: false }
  const keys =
    input.recipeFields?.map((f) => f.key).filter(Boolean) ||
    ['first_name', 'last_name', 'customer_name', 'fname', 'lname', 'custname']
  const heuristic = extractFormFieldsHeuristic(task)
  try {
    const model = createQwenChatModel(input.config || ({} as AgentConfig), 'decision')
    if (!model) {
      return { fields: heuristic, must_submit: taskAffirmsSubmit(task) }
    }
    const res = await model.invoke(
      [
        new SystemMessage(
          [
            '从用户浏览器填表任务中抽取字段键值，只输出 JSON。',
            `已知字段 key（优先使用）：${keys.join(', ')}`,
            'First name / 名 → first_name；Last name / 姓 → last_name；Customer name → customer_name。',
            '若用户明确不要提交，must_submit=false。',
            'schema: {"fields":[{"key":"first_name","value":"张三"}],"must_submit":false}',
          ].join('\n'),
        ),
        new HumanMessage(
          `任务：${task.slice(0, 1200)}${input.startUrl ? `\n起始URL：${input.startUrl}` : ''}`,
        ),
      ],
      input.signal ? { signal: input.signal } : undefined,
    )
    const raw = extractFirstJsonObject(String((res as any)?.content ?? res ?? ''))
    const parsed = FormFieldsExtractSchema.safeParse(raw)
    if (!parsed.success) {
      return { fields: heuristic, must_submit: taskAffirmsSubmit(task) }
    }
    const fields = parsed.data.fields
      .map((f) => ({ key: String(f.key || '').trim(), value: String(f.value || '').trim() }))
      .filter((f) => f.key && f.value)
    return {
      fields: fields.length ? fields : heuristic,
      must_submit: taskAffirmsSubmit(task),
    }
  } catch {
    return { fields: heuristic, must_submit: taskAffirmsSubmit(task) }
  }
}

export function resolveRecipeFormFields(task: string, startUrl?: string): SiteFormField[] {
  return matchSiteRecipe(task, startUrl)?.formFields || []
}

export { taskAffirmsSubmit, clampFormFillGoals } from './lobsterFormGoals'
