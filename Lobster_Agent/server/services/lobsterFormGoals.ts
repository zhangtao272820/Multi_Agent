/**
 * form_fill goals 钳制（无 LLM / 无 TaskSpec 依赖，避免循环 import）
 */

export type FormFillGoalsLike = {
  must_leave_start?: boolean
  must_extract?: boolean
  must_submit?: boolean
  expected_url_change?: boolean
}

/** 明确要求提交（否定优先；修复「不要点 Submit」被裸 /submit/ 误判） */
export function taskAffirmsSubmit(task: string): boolean {
  const t = String(task || '')
  if (/(不要|别|勿|禁止).{0,12}(提交|submit)/i.test(t)) return false
  if (/不\s*(要|用)?\s*(点|点击)?\s*(提交|submit)/i.test(t)) return false
  return /(并提交|然后提交|点提交|点击提交|提交表单|submit\s*(the\s*)?form|点击\s*Submit)/i.test(t)
}

/** form_fill 不得默认离页；提交意图不得被否定句误触发 */
export function clampFormFillGoals(
  goals: FormFillGoalsLike | null | undefined,
  task: string,
): FormFillGoalsLike {
  const affirms = taskAffirmsSubmit(task)
  const base = goals || {}
  return {
    ...base,
    must_leave_start: false,
    must_submit: affirms,
    expected_url_change: affirms ? base.expected_url_change === true : false,
    must_extract: base.must_extract !== false,
  }
}
