/**
 * Manager 侧已知 Lobster Workflow Macro 白名单。
 * 未知 id 必须丢弃，禁止 LLM 编造宏导致 lobster_workflow_not_found。
 */

/** 与 Lobster_Agent/workflows 磁盘宏对齐的内置清单 */
export const BUILTIN_GUI_WORKFLOW_IDS = ['httpbin-form-fill'] as const

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
