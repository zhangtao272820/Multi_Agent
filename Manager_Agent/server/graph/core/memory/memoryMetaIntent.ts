/**
 * Wave 8：元意图（记住 / 保存打法 / 偏好 / 规则）类型与提案契约。
 * finalize 冷路径分发；热路径闸门见 meta_intent_gate + orchestrationThickness。
 */

export type MemoryMetaIntentKind =
  | 'none'
  | 'todo'
  | 'save_answer'
  | 'save_playbook'
  | 'save_preference'
  | 'save_org_rule'

export type MemoryMetaIntentParsed = {
  kind: MemoryMetaIntentKind
  confidence: number
  title?: string
  summary?: string
  preferencePatch?: {
    preferredAgents?: string[]
    refusePreference?: string
    timezone?: string
  }
}

export type MemoryCaptureProposalStatus =
  | 'skipped'
  | 'draft_pending_review'
  | 'acknowledged_pre_ingest'
  | 'applied_shadow'

export type MemoryCaptureProposal = {
  kind: MemoryMetaIntentKind
  status: MemoryCaptureProposalStatus
  source: 'explicit_user_request' | 'positive_feedback_fallback'
  title?: string
  summary?: string
  runId?: string
  skillId?: string
  ruleCandidateId?: string
  experienceCandidateId?: string
  note?: string
  proposedAt: string
}

export function isMemoryMetaIntentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_MEMORY_META_INTENT ?? '1').trim() !== '0'
}

/** 编排前热路径：save_playbook/偏好/规则/答案 → 跳过子 Agent 编排 */
export function isMemoryMetaIntentHotGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_MEMORY_META_INTENT_HOT_GATE ?? '1').trim() !== '0'
}

export function isMemoryMetaIntentLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_MEMORY_META_INTENT_LLM ?? '1').trim() !== '0'
}

export function isRuleCandidateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_RULE_CANDIDATE_ENABLED ?? '1').trim() !== '0'
}

export function memoryMetaIntentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MANAGER_MEMORY_META_INTENT_TIMEOUT_MS ?? 8000)
  return Number.isFinite(n) && n >= 2000 ? Math.min(20_000, Math.floor(n)) : 8000
}

export function buildMemoryCaptureProposal(input: {
  parsed: MemoryMetaIntentParsed
  source: MemoryCaptureProposal['source']
  runId?: string
  dispatch: {
    status: MemoryCaptureProposalStatus
    skillId?: string
    ruleCandidateId?: string
    experienceCandidateId?: string
    note?: string
  }
}): MemoryCaptureProposal | null {
  if (input.parsed.kind === 'none' || input.parsed.confidence < 0.5) return null
  return {
    kind: input.parsed.kind,
    status: input.dispatch.status,
    source: input.source,
    title: input.parsed.title?.trim() || undefined,
    summary: input.parsed.summary?.trim() || undefined,
    runId: input.runId,
    skillId: input.dispatch.skillId,
    ruleCandidateId: input.dispatch.ruleCandidateId,
    experienceCandidateId: input.dispatch.experienceCandidateId,
    note: input.dispatch.note,
    proposedAt: new Date().toISOString(),
  }
}

export function memoryCaptureUserMessage(lastUserText: string, businessQuestion: string): string {
  const last = String(lastUserText || '').trim()
  const biz = String(businessQuestion || '').trim()
  if (!last) return biz
  if (!biz || last === biz) return last
  return `${last}\n[本轮业务问句] ${biz.slice(0, 600)}`
}
