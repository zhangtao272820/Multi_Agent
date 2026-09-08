/**
 * 用户末轮对齐 LLM：编排产出后由模型审查 cap/clauses 是否 grounded 于【用户末轮】。
 * Probe / PU-Stack / 历史 / 经验 仅作 weakHints，不得作为扩写 agent 的依据。
 */
import { z } from 'zod'
import { safeJsonParse } from '../core/shared/llmJson'
import type { LlmInvokeFn } from './taskConstraintsLlm'
import type { TaskOrchestratorBundle } from './taskOrchestrator'
import { bundleFromOrchestratorRaw, type TaskOrchestratorRaw } from './taskOrchestrator'
import { routingDecisionLlmTier } from '../core/shared/modelTier'
import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'
import { buildBlueprintFromPuStackDispatch, buildTopologyBlueprintFromCap } from './planBlueprintLlm'
import {
  rebuildStepDispatchDraftFromClauses,
  stepDispatchDraftFromMeta,
  type StepDispatchDraft
} from '../core/proPuStack'
import type { TaskClause } from '../core/routing/clauses'
import { formatAdminCrawlerDisambiguationPromptCompact, isLlmFirstRouteEnabled } from '../orchestrate/unifiedRouting'
import {
  formatSourceCommitmentPromptRule,
  shouldSkipAdminApiCrawlerRematerialize,
  sourceCommitmentFromRaw
} from '../orchestrate/sourceCommitment'

const EXEC = [
  'db',
  'rag',
  'code',
  'crawler',
  'gui',
  'admin',
  'clean',
  'visualize',
  'report',
  'multimodal',
  'music',
  'video'
] as const

const AlignSchema = z.object({
  allowedAgents: z.array(z.enum(EXEC)).min(1).max(12),
  clauses: z
    .array(
      z.object({
        id: z.string().max(16),
        text: z.string().min(4).max(480),
        agents: z.array(z.enum(EXEC)).max(4).optional()
      })
    )
    .min(1)
    .max(8),
  dataSources: z.array(z.enum(['rag', 'db', 'crawler'])).max(3).default([]),
  isDbAnchored: z.boolean().default(false),
  needsAdmin: z.boolean().default(false),
  needsWeb: z.boolean().default(false),
  rationale: z.string().max(520).default('')
})

/** 空 cap 非法：非闲聊域任务不得清空 allowedAgents（契约校验，非意图正则） */
export function shouldRejectEmptyAlignCap(allowedAgents: readonly string[]): boolean {
  return !Array.isArray(allowedAgents) || allowedAgents.length === 0
}

export function isUserIntentAlignLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isLlmFirstRouteEnabled(env)) return false
  return resolveManagerEnvBool('MANAGER_USER_INTENT_ALIGN_LLM', env)
}

/** 公网锁：Align 不得把 clear+crawler / webFetchKind≠none 改绑为 admin（结构终局，非 prompt 软约束） */
export function enforceWebCommitmentOnAlign(
  bundle: TaskOrchestratorBundle,
  aligned: z.infer<typeof AlignSchema>
): z.infer<typeof AlignSchema> {
  const slice = sourceCommitmentFromRaw(bundle.raw as Record<string, unknown>)
  if (!shouldSkipAdminApiCrawlerRematerialize(slice)) return aligned
  const agents = new Set(aligned.allowedAgents.map(String))
  agents.add('crawler')
  // 公网锁生效时禁止用 admin 顶替 crawler（可另有独立 admin 子句）
  const dataSources = new Set(
    [...(aligned.dataSources ?? []).map(String), 'crawler'].filter((d) => d === 'rag' || d === 'db' || d === 'crawler')
  )
  const alignedHasCrawler = aligned.clauses.some((c) => (c.agents ?? []).map(String).includes('crawler'))
  const bundleCrawlerClauses = bundle.clauses.filter((c) =>
    (c.agents ?? []).map(String).includes('crawler')
  )
  const nextClauses = alignedHasCrawler
    ? aligned.clauses
    : bundleCrawlerClauses.length
      ? bundle.clauses.map((c, i) => ({
          id: String(c.id || `c${i + 1}`),
          text: c.text,
          agents: c.agents
        }))
      : [
          ...aligned.clauses,
          {
            id: 'c_web',
            text: String(bundle.coalescedTask || bundle.routedQuery || '公网检索').slice(0, 480),
            agents: ['crawler' as const]
          }
        ]
  return {
    ...aligned,
    allowedAgents: [...agents] as z.infer<typeof AlignSchema>['allowedAgents'],
    dataSources: [...dataSources] as z.infer<typeof AlignSchema>['dataSources'],
    needsWeb: true,
    clauses: nextClauses as z.infer<typeof AlignSchema>['clauses']
  }
}

function mergeAlignedIntoBundle(
  bundle: TaskOrchestratorBundle,
  alignedIn: z.infer<typeof AlignSchema>,
  lastUser: string,
  priorMeta?: unknown
): { bundle: TaskOrchestratorBundle; stepDispatchDraft: StepDispatchDraft[] } {
  const aligned = enforceWebCommitmentOnAlign(bundle, alignedIn)
  const priorDraft = [
    ...(bundle.stepDispatchDraft ?? []),
    ...stepDispatchDraftFromMeta(priorMeta)
  ]
  const stepDispatchDraft = rebuildStepDispatchDraftFromClauses({
    clauses: aligned.clauses.map((c, i) => ({
      id: String(c.id || `c${i + 1}`),
      text: c.text,
      agents: c.agents?.map(String)
    })),
    allowedAgents: aligned.allowedAgents.map(String),
    priorDraft
  })

  const commitSlice = sourceCommitmentFromRaw(bundle.raw as Record<string, unknown>)
  const raw: TaskOrchestratorRaw = {
    ...bundle.raw,
    // 透传清晰度切片：Align 不得擦掉编排契约
    sourceCommitment: commitSlice.sourceCommitment,
    committedPlanes: commitSlice.committedPlanes,
    webFetchKind: commitSlice.webFetchKind,
    adminCapabilityHints: commitSlice.adminCapabilityHints,
    allowedAgents: aligned.allowedAgents,
    suggestedAgents: aligned.allowedAgents.filter((a) => !['clean', 'code', 'visualize', 'report'].includes(a)),
    clauses: aligned.clauses,
    dataSources: aligned.dataSources,
    isDbAnchored: aligned.isDbAnchored,
    needsAdmin: aligned.needsAdmin,
    needsWeb: aligned.needsWeb,
    routedQuery: String(bundle.routedQuery || lastUser).slice(0, 1200),
    rationale: aligned.rationale || bundle.raw.rationale
  }

  if (stepDispatchDraft.length >= 1) {
    const alignedClauses: TaskClause[] = aligned.clauses.map((c, i) => ({
      id: String(c.id || `c${i + 1}`),
      text: c.text,
      agents: (c.agents ?? []) as TaskClause['agents']
    }))
    const puBp = buildBlueprintFromPuStackDispatch({
      allowedAgents: aligned.allowedAgents.map(String),
      clauses: alignedClauses,
      stepDispatchDraft,
      userTask: lastUser
    })
    if (puBp?.steps?.length) {
      raw.planBlueprint = puBp
    }
  } else if (bundle.planBlueprint?.steps?.length) {
    const cap = new Set(aligned.allowedAgents.map(String))
    const steps = bundle.planBlueprint.steps.filter((s) => cap.has(String(s.agent)))
    raw.planBlueprint = steps.length ? { ...bundle.planBlueprint, steps } : undefined
  }

  if (!raw.planBlueprint?.steps?.length) {
    const alignedClauses: TaskClause[] = aligned.clauses.map((c, i) => ({
      id: String(c.id || `c${i + 1}`),
      text: c.text,
      agents: (c.agents ?? []) as TaskClause['agents']
    }))
    const rebuilt = buildTopologyBlueprintFromCap({
      allowedAgents: aligned.allowedAgents,
      clauses: alignedClauses,
      userTask: lastUser
    })
    if (rebuilt?.steps?.length) raw.planBlueprint = rebuilt
  }

  const merged = bundleFromOrchestratorRaw(raw)
  return {
    bundle: { ...merged, stepDispatchDraft: stepDispatchDraft.length ? stepDispatchDraft : undefined },
    stepDispatchDraft
  }
}

/** 编排 bundle 与用户末轮对齐（模型决策，非正则裁剪） */
export async function alignOrchestratorBundleToUserIntent(input: {
  lastUser: string
  bundle: TaskOrchestratorBundle
  weakHints?: string
  llmInvoke: LlmInvokeFn
  state: unknown
}): Promise<{
  bundle: TaskOrchestratorBundle
  aligned: boolean
  rationale?: string
  stepDispatchDraft?: StepDispatchDraft[]
}> {
  const last = String(input.lastUser || '').trim()
  if (!isUserIntentAlignLlmEnabled() || last.length < 4) {
    return { bundle: input.bundle, aligned: false }
  }

  const commitSlice = sourceCommitmentFromRaw(input.bundle.raw as Record<string, unknown>)
  const webLocked = shouldSkipAdminApiCrawlerRematerialize(commitSlice)
  const proposed = {
    allowedAgents: input.bundle.allowedAgents,
    clauses: input.bundle.clauses.map((c) => ({
      id: c.id,
      text: c.text,
      agents: c.agents
    })),
    dataSources: input.bundle.intentClassify.dataSources ?? [],
    isDbAnchored: input.bundle.intentClassify.isDbAnchored,
    needsAdmin: input.bundle.intentClassify.needsAdmin,
    needsWeb: input.bundle.intentClassify.needsWeb,
    sourceCommitment: commitSlice.sourceCommitment,
    committedPlanes: commitSlice.committedPlanes,
    webFetchKind: commitSlice.webFetchKind
  }

  try {
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        [
          'system',
          [
            '你是「用户末轮对齐审查器」。只读【用户末轮】与【待审查编排】做 delta 修正，勿重写整课路由规则。',
            '【唯一权威】用户末轮；历史/Probe/PU/经验不得扩写末轮未 grounding 的 db/admin/人名。',
            formatSourceCommitmentPromptRule(),
            formatAdminCrawlerDisambiguationPromptCompact(),
            '【服从编排清晰度切片】若 webFetchKind≠none 或 clear+crawler：禁止 crawler→admin，禁止 needsWeb=false。',
            '仅当清晰度未锁公网：未点公网的天气/出行 → admin；已标明知识库/数据库形态禁止同义加 crawler。',
            'structured_query→须含 db；document_retrieval→rag；对照弱参考库存；听起来像「个人情况」≠默认 db。',
            '仅当 db/人名等仅来自历史渗入、与末轮无关时才删除；非闲聊禁止空 allowedAgents。',
            'turnKind=output_followup 或 clarifyKind=output_disambiguation：禁止 needsClarify，cap 不得超出 anchor。',
            '只输出 JSON，无 markdown。'
          ].join('\n')
        ],
        [
          'human',
          [
            input.weakHints ? `【弱参考·不得扩 cap】\n${input.weakHints.slice(0, 800)}` : '',
            `【用户末轮·唯一权威】\n${last.slice(0, 1200)}`,
            `【待审查编排】\n${JSON.stringify(proposed).slice(0, 2400)}`,
            webLocked
              ? '【公网锁·生效】须保留 crawler + needsWeb=true，禁止改 admin。'
              : '',
            'schema: {"allowedAgents":["rag"],"clauses":[{"id":"c1","text":"...","agents":["rag"]}],"dataSources":["rag"],"isDbAnchored":false,"needsAdmin":false,"needsWeb":false,"rationale":"..."}；db 单源时用 allowedAgents=[db]/dataSources=[db]/isDbAnchored=true'
          ]
            .filter(Boolean)
            .join('\n\n')
        ]
      ],
      { tier: routingDecisionLlmTier(input.state), quiet: true, thinkingLabel: '末轮对齐：审查 cap 是否 grounded' }
    )

    const parsed = AlignSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success) return { bundle: input.bundle, aligned: false }
    if (shouldRejectEmptyAlignCap(parsed.data.allowedAgents)) {
      return { bundle: input.bundle, aligned: false }
    }

    const priorMeta = (input.state as { meta?: unknown } | undefined)?.meta
    const { bundle: merged, stepDispatchDraft } = mergeAlignedIntoBundle(
      input.bundle,
      parsed.data,
      last,
      priorMeta
    )
    if (shouldRejectEmptyAlignCap(merged.allowedAgents)) {
      return { bundle: input.bundle, aligned: false }
    }
    return {
      bundle: merged,
      aligned: true,
      rationale: parsed.data.rationale,
      stepDispatchDraft: stepDispatchDraft.length ? stepDispatchDraft : undefined
    }
  } catch {
    return { bundle: input.bundle, aligned: false }
  }
}
