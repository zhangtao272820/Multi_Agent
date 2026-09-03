import { waitGuiConfirm } from '../gui/guiConfirmBridge'
import {
  assertPostureAllows,
  resolveCollaborationPosture
} from '../platform/collaborationPosture'
import {
  gateCopy,
  resolveRiskExecutionPolicy
} from '../../graph/core/policy/riskExecutionPolicy'
import { mintHitlConfirmToken } from '#agent-shared/agentServiceAuth'

export type CodeEditPreview = {
  files?: string[]
  unified_diff?: string
  diff_stat?: string
  branch?: string
  pending_patch_id?: string
}

export function isCodeEditHitlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // 写路径默认事前 HITL；显式设 0 可关（仅受控环境）
  const raw = String(env.MANAGER_CODE_EDIT_HITL ?? env.CODE_WRITE_REQUIRE_CONFIRM ?? '1').trim()
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off'
}

export function codeEditAutoConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_CODE_EDIT_AUTO_CONFIRM ?? '0').trim() === '1'
}

export function extractCodeEditPreview(input: {
  meta?: Record<string, unknown> | null
  raw?: unknown
}): CodeEditPreview | null {
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}
  const metaPreview =
    meta.edit_preview && typeof meta.edit_preview === 'object'
      ? (meta.edit_preview as CodeEditPreview)
      : null
  const filesFromMeta = Array.isArray(meta.files_touched)
    ? meta.files_touched.map(String).filter(Boolean)
    : []
  const raw =
    input.raw && typeof input.raw === 'object' ? (input.raw as Record<string, unknown>) : null
  const artifacts =
    raw?.artifacts && typeof raw.artifacts === 'object'
      ? (raw.artifacts as Record<string, unknown>)
      : null
  const filesFromArtifacts = Array.isArray(artifacts?.files_changed)
    ? artifacts!.files_changed!.map(String).filter(Boolean)
    : []
  const files = [...new Set([...(metaPreview?.files ?? []), ...filesFromMeta, ...filesFromArtifacts])]
  const pending_patch_id = String(
    meta.pending_patch_id || metaPreview?.pending_patch_id || artifacts?.pending_patch_id || ''
  ).trim()
  if (!files.length && !metaPreview?.unified_diff && !artifacts?.unified_diff && !pending_patch_id) {
    return null
  }
  return {
    files,
    unified_diff: String(
      metaPreview?.unified_diff ?? artifacts?.unified_diff ?? meta.unified_diff ?? '',
    ).trim() || undefined,
    diff_stat: String(metaPreview?.diff_stat ?? artifacts?.diff_stat ?? meta.diff_stat ?? '').trim() || undefined,
    branch: String(metaPreview?.branch ?? artifacts?.branch ?? meta.branch ?? '').trim() || undefined,
    pending_patch_id: pending_patch_id || undefined,
  }
}

export function buildCodeEditConfirmMessage(preview: CodeEditPreview, task: string): {
  title: string
  message: string
} {
  const files = preview.files ?? []
  const diffSnippet = String(preview.unified_diff || preview.diff_stat || '').slice(0, 1800)
  return {
    title: '代码变更需人工确认',
    message: [
      `Code Agent 拟修改 ${files.length || '若干'} 个文件（尚未写盘），请审阅 diff 后确认应用。`,
      files.length ? `文件：${files.slice(0, 6).join(', ')}${files.length > 6 ? '…' : ''}` : '',
      preview.branch ? `分支：${preview.branch}` : '',
      diffSnippet ? `\n\`\`\`diff\n${diffSnippet}\n\`\`\`` : '',
      task ? `任务：${task.slice(0, 240)}` : '',
      '确认 = 写盘应用补丁；取消 = 丢弃 pending（零写盘）。',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

/** 总管 Code edit HITL：审 diff 后确认保留或撤销 */
export async function requestCodeEditHumanConfirm(input: {
  runId?: string
  preview: CodeEditPreview
  task: string
  meta?: unknown
  sendThinking?: (t: string) => void
  sendEvent?: (event: { event: string; data?: unknown; from?: string }) => void
  timeoutMs?: number
}): Promise<boolean> {
  const posture = resolveCollaborationPosture(input.meta)
  const gate = assertPostureAllows(posture, 'code_edit_apply', input.meta)
  if (!gate.ok) {
    input.sendThinking?.(gate.reason)
    return false
  }
  const riskPolicy = resolveRiskExecutionPolicy({
    actionKind: 'code_edit',
    meta: input.meta,
    securityRiskLevel:
      input.meta && typeof input.meta === 'object'
        ? ((input.meta as { security?: { riskLevel?: 'low' | 'medium' | 'high' } }).security?.riskLevel as
            | 'low'
            | 'medium'
            | 'high'
            | undefined)
        : undefined
  })
  if (riskPolicy.preferDryRun || riskPolicy.actionGate === 'dry_run_then_confirm') {
    input.sendThinking?.(`Code Agent：${gateCopy('dry_run')} — 变更预览如下`)
    input.sendEvent?.({
      event: 'dry_run_result',
      data: {
        agent: 'code',
        badge: gateCopy('dry_run'),
        message: `拟写入 ${input.preview.files?.length || 0} 个文件（未写盘）`,
        files: input.preview.files ?? [],
        riskPolicy
      },
      from: 'manager'
    })
  }
  /** 高档策略禁止 Auto；中档 dry-run 后仍须人批 */
  if (codeEditAutoConfirmEnabled() && riskPolicy.allowAutoConfirm) return true
  const runId = String(input.runId || '').trim()
  if (!runId) return true
  const confirmId = crypto.randomUUID()
  const copy = buildCodeEditConfirmMessage(input.preview, input.task)
  const confirmToken = mintHitlConfirmToken(runId, confirmId)
  input.sendThinking?.(
    `Code Agent：${gateCopy('action')}（${riskPolicy.blast_radius.toUpperCase()}），等待您确认…`
  )
  input.sendEvent?.({
    event: 'human_confirm_request',
    data: {
      confirmId,
      confirm_token: confirmToken,
      title: copy.title,
      message: `${gateCopy('action')}\n${copy.message}`,
      agent: 'code',
      failureType: 'code_edit_review',
      files: input.preview.files ?? [],
      diffStat: input.preview.diff_stat,
      unifiedDiff: String(input.preview.unified_diff || '').slice(0, 8000),
      branch: input.preview.branch,
      riskTier: riskPolicy.tier,
      blast_radius: riskPolicy.blast_radius
    },
    from: 'manager',
  })
  return waitGuiConfirm(runId, confirmId, input.timeoutMs ?? 300_000)
}
