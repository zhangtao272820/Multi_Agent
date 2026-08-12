/**
 * Manager 侧已知 Lobster Workflow Macro 白名单。
 * 未知 id 必须丢弃，禁止 LLM 编造宏导致 lobster_workflow_not_found。
 * 已知宏还须与 task_kind 兼容，禁止 browse 类误挂 form 宏。
 */

/** 与 Lobster_Agent/workflows 磁盘宏对齐的内置清单 */
export const BUILTIN_GUI_WORKFLOW_IDS = [
  'w3school-form-fill',
  'w3school-form-submit',
  'httpbin-form-fill',
  'httpbin-form-submit',
  'runoob-click-extract',
] as const

/** 内置宏允许的 task_kind（未列出的 env 扩展宏：无 kind 约束） */
export const GUI_WORKFLOW_COMPATIBLE_KINDS: Record<string, readonly string[]> = {
  'w3school-form-fill': ['form_fill'],
  'w3school-form-submit': ['form_fill'],
  'httpbin-form-fill': ['form_fill'],
  'httpbin-form-submit': ['form_fill'],
  'runoob-click-extract': ['navigate', 'extract', 'multi_step'],
}

/**
 * 与 Lobster workflows/*.json `args` 对齐的必填键（不含可由任务 URL 补的 startUrl）。
 * 扩展宏未列出 → 不校验 args。
 */
export const GUI_WORKFLOW_REQUIRED_ARGS: Record<string, readonly string[]> = {
  'w3school-form-fill': ['first_name', 'last_name'],
  'w3school-form-submit': ['first_name', 'last_name'],
  'httpbin-form-fill': ['customer_name'],
  'httpbin-form-submit': ['customer_name'],
}

export function listMissingGuiWorkflowArgs(
  workflowId: string,
  args: Record<string, unknown> | null | undefined,
): string[] {
  const required = GUI_WORKFLOW_REQUIRED_ARGS[String(workflowId || '').trim()]
  if (!required?.length) return []
  const src = args && typeof args === 'object' ? args : {}
  return required.filter((k) => !String((src as Record<string, unknown>)[k] ?? '').trim())
}

export type ResolveGuiWorkflowWithArgsResult =
  | { ok: true; id: string }
  | { ok: false; dropped: string; reason?: 'unknown' | 'kind_mismatch' | 'missing_args'; missing?: string[] }

/**
 * 白名单 + task_kind + 必填 args。缺参时丢弃宏（改逐步 GUI），禁止下发不完整宏。
 */
export function resolveGuiWorkflowWithArgs(
  raw: unknown,
  taskKind: string | undefined,
  args: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolveGuiWorkflowWithArgsResult {
  const kindResolved = resolveGuiWorkflowForTaskKind(raw, taskKind, env)
  if (!kindResolved.ok) {
    const viaAllowlist = !sanitizeGuiWorkflowId(kindResolved.dropped, env).ok
    return {
      ok: false,
      dropped: kindResolved.dropped,
      reason: viaAllowlist ? 'unknown' : 'kind_mismatch',
    }
  }
  const missing = listMissingGuiWorkflowArgs(kindResolved.id, args)
  if (missing.length) {
    return { ok: false, dropped: kindResolved.id, reason: 'missing_args', missing }
  }
  return { ok: true, id: kindResolved.id }
}

export function listKnownGuiWorkflowIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = String(env.MANAGER_GUI_WORKFLOW_ALLOWLIST || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const set = new Set<string>([...BUILTIN_GUI_WORKFLOW_IDS, ...fromEnv])
  return [...set].sort()
}

export type SanitizeGuiWorkflowResult =
  | { ok: true; id: string }
  | { ok: false; dropped: string }

/** 仅放行白名单内 id；空串视为无宏 */
export function sanitizeGuiWorkflowId(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SanitizeGuiWorkflowResult {
  const id = String(raw || '').trim()
  if (!id) return { ok: false, dropped: '' }
  const known = listKnownGuiWorkflowIds(env)
  const hit = known.find((k) => k.toLowerCase() === id.toLowerCase())
  if (hit) return { ok: true, id: hit }
  return { ok: false, dropped: id }
}

export function isKnownGuiWorkflowId(raw: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return sanitizeGuiWorkflowId(raw, env).ok
}

/**
 * 白名单通过后，再按 task_kind 兼容性过滤。
 * 无 taskKind / 扩展宏无清单 → 仅白名单；不兼容 → dropped。
 */
export function resolveGuiWorkflowForTaskKind(
  raw: unknown,
  taskKind: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SanitizeGuiWorkflowResult {
  const sanitized = sanitizeGuiWorkflowId(raw, env)
  if (!sanitized.ok) return sanitized
  const kind = String(taskKind || '').trim().toLowerCase()
  if (!kind) return sanitized
  const allowed = GUI_WORKFLOW_COMPATIBLE_KINDS[sanitized.id]
  if (!allowed) return sanitized
  if (allowed.map((k) => k.toLowerCase()).includes(kind)) return sanitized
  return { ok: false, dropped: sanitized.id }
}
