import { buildExperienceReplayForRouting } from '../memory/experienceReplay'
import { interactionModeFromMeta } from '../runtime/modeIsolate'
import { capabilityContextText, capabilityHintsForQuery } from '../agent/capabilities'
import { buildLayeredMemoryRecall, isLayeredMemoryEnabled } from '../layeredMemory'
import { buildLongMemoryRecall } from '../memory/longMemory'
import {
  formatPlannerPatchBlock,
  formatRouterPatchBlock,
  loadActivePromptPatches,
  type PromptPatchSet
} from '../evolution/promptPatches'
import { formatPlannerRulesBlock, loadActivePlannerRules, type PlannerRuleSet } from '../evolution/plannerRules'
import { clipRulesBlock, clipSkillBlock } from '../shared/promptBudget'
import {
  resolveEffectivePlannerRules,
  resolveEffectivePromptPatches,
  type ResolvedPlannerRules,
  type ResolvedPromptPatches
} from '../evolution/artifactCanary'
import { buildEffectiveTaskStackRecall } from '../task/sharedTaskStack'
import { buildUserGoalsRecall } from '../task/userGoals'
import { buildUserProfileRecall } from '../memory/userProfile'
import { formatCapabilityProbeBlock, buildCapabilitySnapshotFromProbe } from '../agent/agentCapabilities'
import { formatReconNotesBlock } from '../probe/reconNotes'
import { getPendingProactiveNudges, formatProactiveBlockForRouter, isProactiveLoopEnabled } from '../task/proactiveLoop'
import { formatToolMemoryBlock, isToolMemoryEnabled, queryToolMemoryTop } from '#agent-shared/toolMemoryStore'
import { formatProcessMemoryBlock, recallProcessMemory } from '#agent-shared/processMemoryStore'
import { formatMcpRegistryBlockForPlanner, isMcpRegistryEnabled, loadMcpToolRegistry } from '#agent-shared/mcpToolRegistry'
import { formatKgBlockForPlanner, isKgMemoryEnabled, recallKgContextForPlanner } from '#agent-shared/kgMemoryStore'
import {
  formatGuiExperienceBlock,
  isGuiExperienceReadEnabled,
  recallGuiExperience
} from '#agent-shared/guiExperienceRetrieve'
import {
  formatLearnedSkillHints,
  recallLearnedSkills,
} from '../../../utils/skills/skillDiscoverIndex'
import type { TaskStackItem } from '../task/taskStack'

export type ManagerContextStage = 'router' | 'planner'

export type ComposeManagerContextInput = {
  stage: ManagerContextStage
  policyDir: string
  sessionId?: string
  userId?: string
  heuristicsText: string
  state: any
  suppressCanary?: boolean
  skipExperienceReplay?: boolean
  /** 单模态媒体任务：不注入会话长期记忆，避免历史 multi 路径带偏 */
  skipLongMemoryForRoute?: boolean
  /** Planner：turn 隔离时不注入分层记忆，避免旧话题污染规划 */
  skipLayeredMemoryForPlanner?: boolean
  routeLastTurnOnly?: string
  routeAttachment?: { filePath?: string; mediaType?: string } | null
  routeMessages?: import('@langchain/core/messages').BaseMessage[]
  /** Router 专用：由调用方在策略/世界模型就绪后注入 */
  prependBlocks?: string[]
  appendBlocks?: string[]
  getPlanQualityHint?: () => Promise<string>
}

export type ComposedManagerContext = {
  blocks: string[]
  metaPatch: Record<string, unknown>
  artifacts: {
    promptPatches: ResolvedPromptPatches
    plannerRules: ResolvedPlannerRules | null
    taskStackRecall: {
      routerText: string
      plannerText: string
      items: TaskStackItem[]
      sharedCount: number
    }
    userGoalsCount: number
    experienceReplayCount: number
    longMemoryItemCount: number
  }
}

function trimBlock(s: unknown): string {
  return String(s ?? '').trim()
}

/** 统一拼装 Router / Planner 的 memory、taskStack、patch 等注入块（唯一入口） */
export async function composeManagerPromptContext(
  input: ComposeManagerContextInput
): Promise<ComposedManagerContext> {
  const {
    stage,
    policyDir,
    sessionId,
    userId,
    heuristicsText,
    state,
    suppressCanary,
    skipExperienceReplay,
    skipLongMemoryForRoute,
    skipLayeredMemoryForPlanner,
    routeLastTurnOnly,
    routeAttachment,
    routeMessages,
    prependBlocks = [],
    appendBlocks = [],
    getPlanQualityHint
  } = input

  const blocks: string[] = []
  const metaPatch: Record<string, unknown> = {}

  const resolvedPrompt =
    policyDir && sessionId
      ? await resolveEffectivePromptPatches(policyDir, sessionId, { suppressCanary }).catch(async () => ({
          patches: await loadActivePromptPatches(policyDir).catch(() => null),
          source: 'active' as const,
          canary: false
        }))
      : { patches: null as PromptPatchSet | null, source: 'none' as const, canary: false }

  const resolvedRules =
    stage === 'planner' && policyDir && sessionId
      ? await resolveEffectivePlannerRules(policyDir, sessionId, { suppressCanary }).catch(async () => ({
          rules: await loadActivePlannerRules(policyDir).catch(() => null),
          source: 'active' as const,
          canary: false
        }))
      : { rules: null as PlannerRuleSet | null, source: 'none' as const, canary: false }

  if (resolvedPrompt.patches) {
    metaPatch.promptPatchSource = resolvedPrompt.source
    metaPatch.promptCanary = resolvedPrompt.canary
    metaPatch.promptPatchVersion = (resolvedPrompt.patches as PromptPatchSet).version
  }
  if (resolvedRules.rules) {
    metaPatch.plannerRulesSource = resolvedRules.source
    metaPatch.plannerRulesCanary = resolvedRules.canary
  }
  if ('bundleCanary' in resolvedPrompt || 'bundleCanary' in resolvedRules) {
    metaPatch.bundleCanary = Boolean(
      (resolvedPrompt as { bundleCanary?: boolean }).bundleCanary ??
        (resolvedRules as { bundleCanary?: boolean }).bundleCanary
    )
    metaPatch.bundleId =
      (resolvedPrompt as { bundleId?: string | null }).bundleId ??
      (resolvedRules as { bundleId?: string | null }).bundleId ??
      null
  }

  let experienceReplayCount = 0
  let longMemoryItemCount = 0
  let userGoalsCount = 0

  if (stage === 'router') {
    if (!skipExperienceReplay) {
      const experienceReplay = await buildExperienceReplayForRouting(policyDir, heuristicsText, {
        lastTurnOnly: routeLastTurnOnly,
        attachment: routeAttachment ?? null,
        messages: routeMessages,
        interactionMode: interactionModeFromMeta(state?.meta),
        meta: state?.meta
      }).catch(() => ({
        text: '',
        count: 0,
        scenarioKey: '',
        negativeText: '',
        negativeCount: 0,
        items: [] as any[]
      }))
      experienceReplayCount = experienceReplay.count
      if (experienceReplay.count > 0) {
        metaPatch.experienceReplayCount = experienceReplay.count
        if (experienceReplay.negativeCount > 0) metaPatch.experienceReplayNegativeCount = experienceReplay.negativeCount
        if (experienceReplay.scenarioKey) metaPatch.experienceReplayScenarioKey = experienceReplay.scenarioKey
        if (experienceReplay.items?.length > 0) metaPatch.experienceReplayItems = experienceReplay.items.slice(0, 3)
        if (experienceReplay.vectorRecall) metaPatch.experienceVectorRecall = true
        metaPatch.memoryRecallExplain = {
          count: experienceReplay.count,
          injected: (experienceReplay.items || []).slice(0, 3).map((it) => ({
            id: it.id,
            type: it.type,
            score: it.score,
            scenarioKey: it.scenarioKey,
            intent: it.intent,
          })),
          negativeCount: experienceReplay.negativeCount || 0,
          vectorRecall: Boolean(experienceReplay.vectorRecall),
        }
      }
      if (experienceReplay.negativeCount > 0 && !metaPatch.experienceReplayNegativeCount) {
        metaPatch.experienceReplayNegativeCount = experienceReplay.negativeCount
      }
      if (trimBlock(experienceReplay.text)) blocks.push(experienceReplay.text)
      if (trimBlock(experienceReplay.negativeText)) blocks.push(experienceReplay.negativeText)
    }

    // 已晋级 skill 可发现检索（弱 hint；不扫脏 skills/）
    if (String(process.env.MGR_LEARNED_SKILL_RECALL ?? '1').trim() !== '0') {
      try {
        const learnedHits = await recallLearnedSkills(heuristicsText || '', { topK: 2 })
        const learnedBlock = formatLearnedSkillHints(learnedHits)
        if (trimBlock(learnedBlock)) {
          blocks.push(learnedBlock)
          metaPatch.learnedSkillRecallCount = learnedHits.length
          metaPatch.learnedSkillIds = learnedHits.map((h) => h.skillId).slice(0, 3)
        }
      } catch {
        /* ignore */
      }
    }

    const longMemory = skipLongMemoryForRoute
      ? { text: '', items: [], counts: { success: 0, failure: 0, similar: 0 } }
      : isLayeredMemoryEnabled()
        ? await buildLayeredMemoryRecall(policyDir, heuristicsText, sessionId, userId).catch(() => ({
            text: '',
            items: [],
            counts: { success: 0, failure: 0, similar: 0 },
            layers: { working: false, semantic: false, experience: false, reflection: false, profile: false }
          }))
        : await buildLongMemoryRecall(policyDir, heuristicsText, sessionId, userId).catch(() => ({
            text: '',
            items: [],
            counts: { success: 0, failure: 0, similar: 0 }
          }))
    if (!skipLongMemoryForRoute) {
    longMemoryItemCount = longMemory.items.length
    if (longMemory.items.length > 0) {
      metaPatch.longMemoryRecallCount = longMemory.items.length
      metaPatch.longMemoryRecallItems = longMemory.items.slice(0, 4)
    }
    if ('layers' in longMemory && longMemory.layers) {
      metaPatch.layeredMemory = longMemory.layers
    }
    if (trimBlock(longMemory.text)) blocks.push(longMemory.text)
    }

    if (policyDir && sessionId) {
      const profile = await buildUserProfileRecall(policyDir, sessionId, userId).catch(() => ({ text: '' }))
      if (trimBlock(profile.text)) blocks.push(profile.text)
    }

    const hints = capabilityHintsForQuery(heuristicsText)
    if (hints.length > 0) metaPatch.capabilityHints = hints
    const capCtx = capabilityContextText()
    if (trimBlock(capCtx)) blocks.push(capCtx)

    if (sessionId && isProactiveLoopEnabled()) {
      const proactive = formatProactiveBlockForRouter(
        await getPendingProactiveNudges(policyDir, sessionId).catch(() => [])
      )
      if (trimBlock(proactive)) blocks.push(proactive)
    }

    const patchText = formatRouterPatchBlock(resolvedPrompt.patches)
    if (trimBlock(patchText)) blocks.push(patchText)

    if (isGuiExperienceReadEnabled()) {
      const guiRows = await recallGuiExperience(heuristicsText, { limit: 3 }).catch(() => [])
      const guiBlock = formatGuiExperienceBlock(guiRows)
      if (trimBlock(guiBlock)) {
        blocks.push(guiBlock)
        metaPatch.guiExperienceRecallCount = guiRows.length
      }
    }
  }

  if (stage === 'planner') {
    const planQualityHint = (await getPlanQualityHint?.().catch(() => '')) || ''
    if (trimBlock(planQualityHint)) blocks.push(planQualityHint)

    if (policyDir && sessionId) {
      const profile = await buildUserProfileRecall(policyDir, sessionId, userId).catch(() => ({ text: '' }))
      if (trimBlock(profile.text)) blocks.push(profile.text)
    }

    const capabilityText = formatCapabilityProbeBlock(buildCapabilitySnapshotFromProbe(state.probe))
    if (trimBlock(capabilityText)) blocks.push(capabilityText)

    const reconBlock = formatReconNotesBlock(state?.meta?.reconNotes)
    if (trimBlock(reconBlock)) {
      blocks.push(reconBlock)
      metaPatch.reconNotesInjected = true
    }

    const patchText = clipSkillBlock(formatPlannerPatchBlock(resolvedPrompt.patches))
    if (trimBlock(patchText)) blocks.push(patchText)

    const rulesText = clipRulesBlock(formatPlannerRulesBlock(resolvedRules.rules))
    if (trimBlock(rulesText)) blocks.push(rulesText)

    if (isToolMemoryEnabled()) {
      const toolRows = await queryToolMemoryTop({ limit: 6 }).catch(() => [])
      const toolBlock = formatToolMemoryBlock(toolRows)
      if (trimBlock(toolBlock)) blocks.push(toolBlock)
    }

    const processRows = await recallProcessMemory(heuristicsText, {
      scenarioKey: String(state?.meta?.scenarioKey || state?.intent || '').trim() || undefined,
      limit: 3
    }).catch(() => [])
    const processBlock = formatProcessMemoryBlock(processRows)
    if (trimBlock(processBlock)) {
      blocks.push(processBlock)
      metaPatch.processMemoryRecallCount = processRows.length
    }

    if (isMcpRegistryEnabled()) {
      const mcpTools = await loadMcpToolRegistry().catch(() => [])
      const mcpBlock = formatMcpRegistryBlockForPlanner(mcpTools)
      if (trimBlock(mcpBlock)) {
        blocks.push(mcpBlock)
        metaPatch.mcpRegistryCount = mcpTools.length
      }
    }

    if (isKgMemoryEnabled()) {
      const tenantId = String(state?.tenantId || state?.meta?.tenantId || '').trim() || undefined
      const kgRows = await recallKgContextForPlanner(heuristicsText, { tenantId, limit: 6 }).catch(() => [])
      const kgBlock = formatKgBlockForPlanner(kgRows)
      if (trimBlock(kgBlock)) {
        blocks.push(kgBlock)
        metaPatch.kgRecallCount = kgRows.length
      }
    }

    if (isGuiExperienceReadEnabled()) {
      const guiRows = await recallGuiExperience(heuristicsText, { limit: 3 }).catch(() => [])
      const guiBlock = formatGuiExperienceBlock(guiRows)
      if (trimBlock(guiBlock)) {
        blocks.push(guiBlock)
        metaPatch.guiExperienceRecallCount = guiRows.length
      }
    }

    if (policyDir && isLayeredMemoryEnabled() && !skipLayeredMemoryForPlanner) {
      const layered = await buildLayeredMemoryRecall(policyDir, heuristicsText, sessionId, userId).catch(() => ({ text: '' }))
      longMemoryItemCount = Array.isArray((layered as any).items) ? (layered as any).items.length : 0
      if (trimBlock(layered.text)) blocks.push(layered.text)
    }
  }

  const userGoalsRecall = policyDir
    ? await buildUserGoalsRecall(policyDir, sessionId, userId).catch(() => ({
        routerText: '',
        plannerText: '',
        goals: [],
        userId: null
      }))
    : { routerText: '', plannerText: '', goals: [], userId: null }
  userGoalsCount = userGoalsRecall.goals.length
  if (userGoalsRecall.goals.length > 0) {
    metaPatch.userGoalCount = userGoalsRecall.goals.length
    if (userGoalsRecall.userId) metaPatch.userId = userGoalsRecall.userId
  }
  const goalsBlock = stage === 'router' ? userGoalsRecall.routerText : userGoalsRecall.plannerText
  if (trimBlock(goalsBlock)) blocks.push(goalsBlock)

  const taskStackRecall = await buildEffectiveTaskStackRecall(policyDir, sessionId, userId, stage).catch(() => ({
    routerText: '',
    plannerText: '',
    items: [] as TaskStackItem[],
    sharedCount: 0
  }))
  if (taskStackRecall.items.length > 0) metaPatch.taskStackCount = taskStackRecall.items.length
  if (taskStackRecall.sharedCount > 0) metaPatch.sharedTaskStackCount = taskStackRecall.sharedCount
  const stackBlock = stage === 'router' ? taskStackRecall.routerText : taskStackRecall.plannerText
  if (trimBlock(stackBlock)) blocks.push(stackBlock)

  const ordered = [...prependBlocks, ...blocks, ...appendBlocks]
    .map(trimBlock)
    .filter(Boolean)

  return {
    blocks: ordered,
    metaPatch,
    artifacts: {
      promptPatches: resolvedPrompt,
      plannerRules: stage === 'planner' ? resolvedRules : null,
      taskStackRecall,
      userGoalsCount,
      experienceReplayCount,
      longMemoryItemCount
    }
  }
}
