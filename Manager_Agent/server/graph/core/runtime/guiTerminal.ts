/**
 * GUI 基建/配置类终态失败：workflow 不存在等 → 禁止 quality_repair / 改道其它 Agent。
 */
import { looksLikeNetworkFailure } from '#agent-shared/lobsterRunVerifyLite'

export const GUI_TERMINAL_ERROR_MARKERS = [
  'lobster_workflow_not_found',
  'gui_workflow_not_found',
  'workflow_not_found'
] as const

function matchesGuiTerminalMarker(raw: string): string | undefined {
  const text = String(raw || '').trim()
  if (!text) return undefined
  const lower = text.toLowerCase()
  for (const marker of GUI_TERMINAL_ERROR_MARKERS) {
    if (lower.includes(marker)) return marker
  }
  return undefined
}

function collectGuiErrorStrings(state: {
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
}): string[] {
  const out: string[] = []
  const meta = state.meta || {}
  if (meta.guiTerminal === true) {
    out.push('gui_terminal')
  }
  const ar = meta.agentResult as { error_code?: string; error?: string } | undefined
  if (ar?.error_code) out.push(String(ar.error_code))
  if (ar?.error) out.push(String(ar.error))

  const records = Array.isArray(meta.lastStepRecords) ? meta.lastStepRecords : []
  for (const row of records) {
    if (!row || typeof row !== 'object') continue
    const r = row as { agent?: string; error?: string; status?: string }
    if (String(r.agent || '').toLowerCase() !== 'gui') continue
    if (r.error) out.push(String(r.error))
  }

  const evidence = Array.isArray(state.evidence) ? state.evidence : []
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    const row = e as {
      kind?: string
      agent?: string
      error?: string
      failed?: boolean
      agentResult?: { error_code?: string; error?: string; ok?: boolean }
    }
    const kind = String(row.kind || row.agent || '').toLowerCase()
    if (kind !== 'gui') continue
    if (row.agentResult?.error_code) out.push(String(row.agentResult.error_code))
    if (row.agentResult?.error) out.push(String(row.agentResult.error))
    if (row.error) out.push(String(row.error))
  }

  const guiOut = String(state.results?.gui || '')
  if (guiOut) out.push(guiOut)

  return out
}

/** 是否存在不应再 repair / 改道其它 Agent 的 GUI 终态失败 */
export function detectGuiTerminalFailure(state: {
  results?: Record<string, unknown>
  evidence?: unknown[]
  meta?: Record<string, unknown>
}): { terminal: boolean; code?: string } {
  const codes = collectGuiErrorStrings(state)
  for (const c of codes) {
    if (c === 'gui_terminal') return { terminal: true, code: 'gui_terminal' }
    const hit = matchesGuiTerminalMarker(c)
    if (hit) return { terminal: true, code: hit }
  }
  return { terminal: false }
}

/** 本轮是否存在失败的 GUI evidence */
export function hasFailedGuiEvidenceInRun(state: {
  evidence?: unknown[]
  results?: Record<string, unknown>
}): boolean {
  const evidence = Array.isArray(state.evidence) ? state.evidence : []
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    const row = e as {
      kind?: string
      agent?: string
      failed?: boolean
      agentResult?: { ok?: boolean }
    }
    const kind = String(row.kind || row.agent || '').toLowerCase()
    if (kind !== 'gui') continue
    if (row.failed === true || row.agentResult?.ok === false) return true
  }
  const guiOut = String(state.results?.gui || '')
  if (/GUI 自动化失败|lobster_workflow_not_found|gui.*failed/i.test(guiOut)) return true
  if (looksLikeNetworkFailure(guiOut)) return true
  return false
}

const INCOMPLETE_GUI_RETRY_RE =
  /navigation_unverified|incomplete_|search_no_results|search_extract_empty|empty_result|仍停留在起始页/i

/** incomplete / navigation_unverified：Lobster 引擎链已尽力，禁止总管 pinGui 整段空转重跑 */
export function shouldSkipGuiGraphRetry(state: {
  evidence?: unknown[]
  results?: Record<string, unknown>
  meta?: Record<string, unknown>
}): boolean {
  if (!hasFailedGuiEvidenceInRun(state)) return false
  const evidence = Array.isArray(state.evidence) ? state.evidence : []
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    const row = e as {
      kind?: string
      agentResult?: { ok?: boolean; error_code?: string; structured?: { failureType?: string } }
      failureType?: string
      error?: string
    }
    if (String(row.kind || '').toLowerCase() !== 'gui') continue
    const code = String(
      row.agentResult?.error_code ||
        row.agentResult?.structured?.failureType ||
        row.failureType ||
        row.error ||
        '',
    )
    if (INCOMPLETE_GUI_RETRY_RE.test(code)) return true
  }
  const guiOut = String(state.results?.gui || '')
  if (INCOMPLETE_GUI_RETRY_RE.test(guiOut)) return true
  if (state.meta?.guiIncompleteNoRetry === true) return true
  return false
}
