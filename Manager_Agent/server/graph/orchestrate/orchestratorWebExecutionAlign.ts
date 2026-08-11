/**
 * 统一编排后对齐 crawler vs gui（与 Router webTaskStructuralLlm 同契约）。
 * 根因：orchestrate 路径跳过 legacy router 的 webExecutionMode 启发，导致「打开/点击」误 cap=crawler。
 * 复合库内+公网：尊重 composite webExecution（serp_summary → search_serp_only），不被 pipeline 绑架。
 */
import type { LlmInvokeFn } from '../llm/taskConstraintsLlm'
import type { ExecutableAgent } from '../core/routing/routeFinalize'
import { applyGuiRouteOverrides, supplementAllowedFromWebStructuralAsync } from '../llm/webTaskStructuralLlm'
import {
  blueprintCoversRequiredAgents,
  buildTopologyBlueprintFromCap,
  type PlanBlueprint,
} from '../llm/planBlueprintLlm'
import type { WebExecutionModeDecision } from '../../utils/search/managerWebExecutionModeLlm'
import type { OrchestratorDecision } from './orchestratorInvariants'
import {
  applyCompositeRouteGuard,
  resolveCompositeRouteGuardByLlm,
  webExecutionModeFromCompositeGuard
} from '../../utils/route/managerCompositeRouteGuardLlm'
import { shouldSkipWebAlignLlm } from './stripUnboundCrawler'

function blueprintNeedsWebRebuild(
  planBlueprint: PlanBlueprint | null | undefined,
  allowedAgents: ExecutableAgent[],
): boolean {
  const bpAgents = (planBlueprint?.steps ?? []).map((s) => s.agent)
  const wantsGui = allowedAgents.includes('gui') && !allowedAgents.includes('crawler')
  if (wantsGui && bpAgents.includes('crawler')) return true
  const mustCover = allowedAgents.filter((a) =>
    ['rag', 'db', 'crawler', 'gui', 'clean', 'code', 'visualize', 'report', 'admin'].includes(String(a)),
  )
  return !blueprintCoversRequiredAgents(planBlueprint, mustCover)
}

/** 同步落盘：已有 webExecutionMode 时修正 cap/intent/蓝图（供 smoke 与 LLM 后处理） */
export function applyOrchestratorWebRoutePatch(input: {
  decision: OrchestratorDecision
  userTask: string
  webExecutionMode: WebExecutionModeDecision | null
}): OrchestratorDecision {
  const compositeDataWebRoute = input.decision.metaPatch?.compositeDataWebRoute === true
  const guiRoute = applyGuiRouteOverrides({
    intent: input.decision.intent,
    allowedAgents: input.decision.allowedAgents as ExecutableAgent[],
    llmNeedsWebSearch: input.decision.needsWebSearch,
    webExecutionMode: input.webExecutionMode,
    compositeDataWebRoute,
  })

  const changed =
    guiRoute.intent !== input.decision.intent ||
    guiRoute.llmNeedsWebSearch !== input.decision.needsWebSearch ||
    guiRoute.allowedAgents.join(',') !== input.decision.allowedAgents.join(',')

  if (!changed && !input.webExecutionMode) return input.decision

  let planBlueprint = input.decision.planBlueprint
  if (blueprintNeedsWebRebuild(planBlueprint, guiRoute.allowedAgents)) {
    planBlueprint =
      buildTopologyBlueprintFromCap({
        allowedAgents: guiRoute.allowedAgents,
        clauses: input.decision.clauses,
        constraints: input.decision.constraints,
        userTask: input.decision.coalescedTask || input.userTask,
      }) ?? planBlueprint
  }

  let classify = { ...input.decision.intentClassify }
  if (guiRoute.allowedAgents.includes('gui') && !guiRoute.allowedAgents.includes('crawler')) {
    classify = {
      ...classify,
      needsWeb: false,
      dataSources: (classify.dataSources ?? []).filter((d) => d !== 'crawler'),
      suggestedAgents: guiRoute.allowedAgents.map(String),
    }
  } else if (guiRoute.allowedAgents.includes('crawler')) {
    classify = {
      ...classify,
      needsWeb: guiRoute.llmNeedsWebSearch,
      suggestedAgents: guiRoute.allowedAgents.map(String),
    }
  }

  return {
    ...input.decision,
    intent: guiRoute.intent,
    allowedAgents: guiRoute.allowedAgents as OrchestratorDecision['allowedAgents'],
    needsWebSearch: guiRoute.llmNeedsWebSearch,
    planBlueprint,
    intentClassify: classify,
    metaPatch: {
      ...input.decision.metaPatch,
      webExecutionMode: input.webExecutionMode ?? input.decision.metaPatch?.webExecutionMode,
      needsWebSearch: guiRoute.llmNeedsWebSearch,
      orchestratorWebAlign: true,
      planBlueprint: planBlueprint ?? undefined,
      intentClassify: classify,
    },
  }
}

export async function alignOrchestratorWebExecutionMode(input: {
  decision: OrchestratorDecision
  userTask: string
  llmInvoke: LlmInvokeFn
  state: unknown
  toolHealth?: { agents?: Array<{ agent: string; status: string }> } | null
}): Promise<OrchestratorDecision> {
  if (
    shouldSkipWebAlignLlm({
      allowedAgents: input.decision.allowedAgents,
      needsWeb: input.decision.intentClassify?.needsWeb,
      needsWebSearch: input.decision.needsWebSearch,
      sourceCommitmentRaw: input.decision.raw as unknown as Record<string, unknown>
    })
  ) {
    return input.decision
  }

  const webSup = await supplementAllowedFromWebStructuralAsync(
    input.decision.allowedAgents as ExecutableAgent[],
    input.userTask,
    {
      llmInvoke: input.llmInvoke,
      state: input.state,
      routeIntent: input.decision.intent,
      llmNeedsWebSearch: input.decision.needsWebSearch,
      toolHealth: input.toolHealth,
    },
  )

  let decision = input.decision
  let webExecutionMode: WebExecutionModeDecision | null = webSup.webExecutionMode

  const compositeGuard = await resolveCompositeRouteGuardByLlm({
    userText: input.userTask,
    routeIntent: decision.intent,
    allowedAgents: decision.allowedAgents as ExecutableAgent[],
    intentClassify: decision.intentClassify,
    llmInvoke: input.llmInvoke,
    state: input.state
  })
  if (compositeGuard?.isCompositeDataWeb) {
    const applied = applyCompositeRouteGuard({
      intent: decision.intent,
      allowedAgents: decision.allowedAgents as ExecutableAgent[],
      llmNeedsWebSearch: decision.needsWebSearch,
      guard: compositeGuard,
      intentClassify: decision.intentClassify
    })
    const fromGuard = webExecutionModeFromCompositeGuard(applied.webExecution, compositeGuard.rationale)
    if (fromGuard) {
      webExecutionMode = fromGuard
      decision = {
        ...decision,
        intent: applied.intent,
        allowedAgents: applied.allowedAgents as OrchestratorDecision['allowedAgents'],
        needsWebSearch: applied.llmNeedsWebSearch,
        metaPatch: {
          ...decision.metaPatch,
          compositeDataWebRoute: true,
          compositeWebExecution: applied.webExecution,
          needsWebSearch: applied.llmNeedsWebSearch
        }
      }
    }
  }

  return applyOrchestratorWebRoutePatch({
    decision,
    userTask: input.userTask,
    webExecutionMode,
  })
}
