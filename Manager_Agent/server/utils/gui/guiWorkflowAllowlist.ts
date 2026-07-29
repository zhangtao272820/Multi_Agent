/**
 * Manager 侧已知 Lobster Workflow Macro 白名单。
 * 未知 id 必须丢弃，禁止 LLM 编造宏导致 lobster_workflow_not_found。
 * 已知宏还须与 task_kind 兼容，禁止 browse 类误挂 form 宏。
 */

/** 与 Lobster_Agent/workflows 磁盘宏对齐的内置清单 */
export const BUILTIN_GUI_WORKFLOW_IDS = ['httpbin-form-fill'] as const

/** 内置宏允许的 task_kind（未列出的 env 扩展宏：无 kind 约束） */
export const GUI_WORKFLOW_COMPATIBLE_KINDS: Record<string, readonly string[]> = {
  'httpbin-form-fill': ['form_fill'],
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
