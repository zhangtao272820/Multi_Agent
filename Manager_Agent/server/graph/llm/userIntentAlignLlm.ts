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
import { formatAdminCrawlerDisambiguationPrompt, isLlmFirstRouteEnabled } from '../orchestrate/unifiedRouting'

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
  allowedAgents: z.array(z.enum(EXEC)).max(12),
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

export function isUserIntentAlignLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isLlmFirstRouteEnabled(env)) return false
  return resolveManagerEnvBool('MANAGER_USER_INTENT_ALIGN_LLM', env)
}

function mergeAlignedIntoBundle(
  bundle: TaskOrchestratorBundle,
  aligned: z.infer<typeof AlignSchema>,
  lastUser: string,
  priorMeta?: unknown
): { bundle: TaskOrchestratorBundle; stepDispatchDraft: StepDispatchDraft[] } {
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

  const raw: TaskOrchestratorRaw = {
    ...bundle.raw,
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

  const proposed = {
    allowedAgents: input.bundle.allowedAgents,
    clauses: input.bundle.clauses.map((c) => ({
      id: c.id,
      text: c.text,
      agents: c.agents
    })),
    dataSources: input.bundle.intentClassify.dataSources ?? [],
    isDbAnchored: input.bundle.intentClassify.isDbAnchored,
    needsAdmin: input.bundle.intentClassify.needsAdmin
  }

  try {
    const r = await input.llmInvoke(
      'route',
      input.state,
      [
        [
          'system',
          [
            '你是「用户末轮对齐审查器」。只读【用户末轮】原文，审查编排 cap/clauses 是否 grounded。',
            '【唯一权威】用户末轮；相似主题 ≠ 同一任务；历史/Probe/PU/经验不得扩写 db/admin/人名等用户未提内容。',
            formatAdminCrawlerDisambiguationPrompt(),
            '若编排把天气预报/气温子句标为 crawler 或 needsWeb=true，须改为 admin 子句、needsAdmin=true，并从 dataSources 移除 crawler（除非另有明确网页政策/公告子句）。',
            '若编排把地铁/公交/从A到B/多久到等出行子句标为 crawler 或再挂 crawler 镜像，须改为单一 admin（高德），needsWeb=false；「查一下」不等于公网抓取。',
            '用户已标明「知识库查…」「数据库查…」的内容禁止再为同义片段加 crawler；crawler 仅当用户明确要网上/网页/官网/公告正文。',
            '「查天气」不得 needsWeb=true；复合任务中天气须独立 admin 子句与 queryFocus。',
            '若编排含用户未要求的 data-plane agent（如未提数据库却含 db），须从 allowedAgents/clauses 删除。',
            '若用户明确要求的数据面缺失，可补入；禁止凭 probe 或上下文自主加 agent。',
            'pipeline 步（clean/code/visualize/report）仅当用户要对比/出图/报告或多源汇总时保留。',
            'turnKind=output_followup 或 clarifyKind=output_disambiguation：禁止 needsClarify，cap 不得超出 anchor.lastExecutedAgents。',
            '只输出 JSON，无 markdown。'
          ].join('\n')
        ],
        [
          'human',
          [
            input.weakHints ? `【弱参考·不得扩 cap】\n${input.weakHints.slice(0, 800)}` : '',
            `【用户末轮·唯一权威】\n${last.slice(0, 1200)}`,
            `【待审查编排】\n${JSON.stringify(proposed).slice(0, 2400)}`,
            'schema: {"allowedAgents":[],"clauses":[{"id":"c1","text":"...","agents":["rag"]}],"dataSources":["rag"],"isDbAnchored":false,"needsAdmin":false,"needsWeb":false,"rationale":"..."}'
          ]
            .filter(Boolean)
            .join('\n\n')
        ]
      ],
      { tier: routingDecisionLlmTier(input.state), quiet: true }
    )

    const parsed = AlignSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
    if (!parsed.success) return { bundle: input.bundle, aligned: false }

    const priorMeta = (input.state as { meta?: unknown } | undefined)?.meta
    const { bundle: merged, stepDispatchDraft } = mergeAlignedIntoBundle(
      input.bundle,
      parsed.data,
      last,
      priorMeta
    )
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
