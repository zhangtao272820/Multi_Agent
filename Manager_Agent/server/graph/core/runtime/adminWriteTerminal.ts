/**
 * Admin 写操作终态失败：取消 / 协议垃圾 / 明确写失败 → 禁止 quality_repair 复读。
 */

export const ADMIN_WRITE_TERMINAL_ERROR_CODES = new Set([
  'user_cancelled_admin_write',
  'confirm_timeout',
  'admin_protocol_garbage',
  'admin_write_failed'
])

function collectErrorCodes(state: {
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
}): string[] {
  const out: string[] = []
  const meta = state.meta || {}
  if (meta.adminWriteTerminal === true) {
    out.push('admin_write_terminal')
  }
  const ar = meta.agentResult as { error_code?: string } | undefined
  if (ar?.error_code) out.push(String(ar.error_code))

  const records = Array.isArray(meta.lastStepRecords) ? meta.lastStepRecords : []
  for (const row of records) {
    if (!row || typeof row !== 'object') continue
    const r = row as { agent?: string; error?: string; status?: string }
    if (String(r.agent || '').toLowerCase() !== 'admin') continue
    if (r.error) out.push(String(r.error))
  }

  const evidence = Array.isArray(state.evidence) ? state.evidence : []
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    const row = e as { kind?: string; agentResult?: { error_code?: string; ok?: boolean } }
    if (String(row.kind || '') !== 'admin') continue
    if (row.agentResult?.error_code) out.push(String(row.agentResult.error_code))
  }

  const adminOut = String(state.results?.admin || '')
  if (/未确认，未写入/.test(adminOut)) out.push('user_cancelled_admin_write')
  if (/协议异常：未返回可执行结果/.test(adminOut)) out.push('admin_protocol_garbage')
  if (/仅处理下列个人助理能力/.test(adminOut)) out.push('admin_protocol_garbage')

  return out
}

/** 是否存在不应再 quality_repair 的 Admin 写终态失败 */
export function detectAdminWriteTerminalFailure(state: {
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
}): { terminal: boolean; code?: string } {
  const codes = collectErrorCodes(state)
  for (const c of codes) {
    if (ADMIN_WRITE_TERMINAL_ERROR_CODES.has(c) || c === 'admin_write_terminal') {
      return { terminal: true, code: c }
    }
  }
  return { terminal: false }
}
