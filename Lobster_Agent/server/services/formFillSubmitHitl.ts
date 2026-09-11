/**
 * form_fill 提交前字段摘要 HITL（动手 P3）：确定性组装，不调 LLM。
 */
export type FormFillFieldRow = {
  name: string
  value: string
  label?: string
}

export type FormFillSubmitHitlSummary = {
  needsHitl: boolean
  title: string
  fields: FormFillFieldRow[]
  message: string
  allowSubmit: boolean
}

/**
 * 表单填写后、点击提交前：生成可确认摘要。
 * defaultSubmit=false 时强制 HITL；字段为空则不允许提交。
 */
export function buildFormFillSubmitHitlSummary(input: {
  fields?: FormFillFieldRow[] | null
  url?: string
  defaultSubmit?: boolean
}): FormFillSubmitHitlSummary {
  const fields = (Array.isArray(input.fields) ? input.fields : [])
    .map((f) => ({
      name: String(f?.name || '').trim().slice(0, 64),
      value: String(f?.value || '').trim().slice(0, 120),
      ...(f?.label ? { label: String(f.label).trim().slice(0, 64) } : {})
    }))
    .filter((f) => f.name && f.value)
    .slice(0, 20)
  const url = String(input.url || '').trim().slice(0, 200)
  const allowSubmit = fields.length > 0
  const needsHitl = input.defaultSubmit !== true
  const lines = fields.map((f) => `- ${f.label || f.name}: ${f.value}`)
  const message = [
    '提交前请确认以下字段：',
    ...lines,
    url ? `页面：${url}` : '',
    needsHitl ? '确认后才会点击提交；取消则保留已填内容、不提交。' : ''
  ]
    .filter(Boolean)
    .join('\n')
  return {
    needsHitl,
    title: '表单提交确认',
    fields,
    message,
    allowSubmit
  }
}
