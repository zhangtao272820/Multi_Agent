/**
 * 意图清晰度契约：语义推断（可隐晦），非用户原话关键词门禁。
 * clear → 锁定 committedPlanes；ambiguous / 无库存覆盖 → clarify。
 */
import type { TaskOrchestratorRaw } from '../llm/taskOrchestrator/schemas'

export const SOURCE_COMMITMENT_KINDS = ['clear', 'ambiguous', 'none'] as const
export type SourceCommitment = (typeof SOURCE_COMMITMENT_KINDS)[number]

export const WEB_FETCH_KINDS = ['none', 'policy_page', 'general_page'] as const
export type WebFetchKind = (typeof WEB_FETCH_KINDS)[number]

export const ADMIN_CAPABILITY_HINTS = [
  'weather',
  'calendar',
  'map',
  'briefing',
  'mail',
  'files',
  'other'
] as const
export type AdminCapabilityHint = (typeof ADMIN_CAPABILITY_HINTS)[number]

const DATA_PLANES = new Set(['db', 'rag', 'crawler'])

export type SourceCommitmentSlice = {
  sourceCommitment: SourceCommitment
  committedPlanes: string[]
  webFetchKind: WebFetchKind
  adminCapabilityHints: AdminCapabilityHint[]
}

export function coerceSourceCommitment(v: unknown): SourceCommitment {
  const s = String(v ?? 'none').trim().toLowerCase()
  if ((SOURCE_COMMITMENT_KINDS as readonly string[]).includes(s)) return s as SourceCommitment
  return 'none'
}

export function coerceWebFetchKind(v: unknown): WebFetchKind {
  const s = String(v ?? 'none').trim().toLowerCase()
  if ((WEB_FETCH_KINDS as readonly string[]).includes(s)) return s as WebFetchKind
  return 'none'
}

export function coerceCommittedPlanes(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [
    ...new Set(
      v
        .map((x) => String(x || '').trim())
        .filter((a) =>
          [
            'db',
            'rag',
            'crawler',
            'gui',
            'admin',
            'multimodal',
            'music',
            'video',
            'clean',
            'code',
            'visualize',
            'report'
          ].includes(a)
        )
    )
  ]
}

export function coerceAdminCapabilityHints(v: unknown): AdminCapabilityHint[] {
  if (!Array.isArray(v)) return []
  return [
    ...new Set(
      v
        .map((x) => String(x || '').trim().toLowerCase())
        .filter((x) => (ADMIN_CAPABILITY_HINTS as readonly string[]).includes(x))
    )
  ] as AdminCapabilityHint[]
}

/** 从编排 raw / bundle.raw 读取清晰度切片 */
export function sourceCommitmentFromRaw(
  raw: Partial<TaskOrchestratorRaw> | Record<string, unknown> | null | undefined
): SourceCommitmentSlice {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    sourceCommitment: coerceSourceCommitment(r.sourceCommitment),
    committedPlanes: coerceCommittedPlanes(r.committedPlanes),
    webFetchKind: coerceWebFetchKind(r.webFetchKind),
    adminCapabilityHints: coerceAdminCapabilityHints(r.adminCapabilityHints)
  }
}

/** clear 且锁定了 db 或 rag 时，禁止库存翻面 */
export function shouldLockPlaneCoverageFlip(slice: SourceCommitmentSlice): boolean {
  if (slice.sourceCommitment !== 'clear') return false
  return slice.committedPlanes.some((p) => p === 'db' || p === 'rag')
}

/**
 * 用户清晰要公网/爬取时，天气/地图不得把 crawler 重绑为 admin。
 * webFetchKind≠none 或 clear+crawler 均视为清晰公网意图。
 */
export function shouldSkipAdminApiCrawlerRematerialize(slice: SourceCommitmentSlice): boolean {
  if (slice.webFetchKind !== 'none') return true
  if (slice.sourceCommitment === 'clear' && slice.committedPlanes.includes('crawler')) return true
  return false
}

/** 模糊意图：须 clarify（plane） */
export function shouldClarifyForAmbiguousCommitment(slice: SourceCommitmentSlice): boolean {
  return slice.sourceCommitment === 'ambiguous'
}

/**
 * 清晰锁定数据面，但库存显示该面盖不住且另一面也不能充数时 → clarify（缺源）。
 * 调用方在跳过翻面之后使用。
 */
export function shouldClarifyForNoInventoryCoverage(input: {
  slice: SourceCommitmentSlice
  proposedPlane: 'db' | 'rag' | null
  dbCanAnswer?: boolean
  ragCanAnswer?: boolean
}): boolean {
  const { slice, proposedPlane } = input
  if (slice.sourceCommitment !== 'clear' || !proposedPlane) return false
  if (!slice.committedPlanes.includes(proposedPlane)) return false
  if (proposedPlane === 'db' && input.dbCanAnswer === false && input.ragCanAnswer !== true) return true
  if (proposedPlane === 'rag' && input.ragCanAnswer === false && input.dbCanAnswer !== true) return true
  // 清晰锁定本面；另一面能答也不允许静默改道 → 仍 clarify（缺本面覆盖）
  if (proposedPlane === 'db' && input.dbCanAnswer === false) return true
  if (proposedPlane === 'rag' && input.ragCanAnswer === false) return true
  return false
}

/** 确保 clear 的 committedPlanes 出现在 allowedAgents（不扩无关面） */
export function ensureCommittedPlanesInAllowed(
  allowed: readonly string[],
  slice: SourceCommitmentSlice
): string[] {
  if (slice.sourceCommitment !== 'clear' || !slice.committedPlanes.length) return [...allowed]
  const next = new Set(allowed.map(String))
  for (const p of slice.committedPlanes) {
    if (DATA_PLANES.has(p) || p === 'admin' || p === 'gui' || p === 'multimodal') next.add(p)
  }
  return [...next]
}

export function formatSourceCommitmentPromptRule(): string {
  return [
    '【意图清晰度】sourceCommitment=clear|ambiguous|none；committedPlanes 语义锁定（db/rag 不要求字面「库/知识库」）：',
    '- clear：意图明确（可隐晦）→ 锁面；库存盖不住 → clarify，禁静默改道；',
    '- ambiguous：说不清库/文档/公网/办事/附件 → needsClarify+plane，禁赌 Agent；',
    '- none：db/rag 按 taskIntent+catalog 推断（仅此时可单源翻面）；',
    '- **通道固定**：未点公网的天气/出行/日程/邮件 → admin + adminCapabilityHints；清晰联网/爬取/网页正文 → crawler + webFetchKind；打开站点点选登录 → gui；附件 → multimodal；',
    '- 天气/地图：API 通道须填 sourceCommitment/webFetchKind/adminCapabilityHints（weather|map）；「联网搜天气/搜路线政策」须 clear+crawler，勿只写天气词却不填清晰度。'
  ].join('\n')
}
