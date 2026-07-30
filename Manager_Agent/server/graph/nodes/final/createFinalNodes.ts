import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { effectiveUserTask } from '../../core/text'
import { z } from 'zod'
import type { Intent } from '../../../utils/shared/taskPlan'
import {
  buildCompositeMediaFinal,
  inferMediaPlanAgents,
  isMediaOnlyPlanAgents,
  textHasPlayableMediaUrl,
  isSynthRejectingMedia,
  mediaAgentsInPlan,
  pickPrimaryResultText,
  type StructuredFact
} from '../../core/shared'
import { recordPolicyRolloutBaseline } from '../../core/evolution/policyRollout'
import { buildGovernanceSnapshot, writeGovernanceSnapshot } from '../../core/evolution/governance'
import { isExperienceReplayEnabled } from '../../core/memory/experienceReplay'
import { indexMemoryEntry, isVectorMemoryEnabled } from '../../core/memory/vectorMemory'
import { runEvolutionExperimentCycle } from '../../core/evolution/evolutionExperiments'
import { updateUserProfileFromRun } from '../../core/memory/userProfile'
import { recordLayeredMemoryFromRun } from '../../core/layeredMemory'
import { recordUnifiedLearningFromRun } from '../../core/unifiedLearning'
import { interactionModeFromMeta } from '../../core/runtime/modeIsolate'
import { inferManagerRouteMatrixPass } from '#agent-shared/evolutionConvergence'
import { recordToolMemoryEvent } from '#agent-shared/toolMemoryStore'
import { isAgentToolSuccess, isSkillDraftEligible } from '#agent-shared/agentOutcomePolicy'
import { syncDbExperienceFromManagerRun } from '#agent-shared/dbExperienceBridge'
import { syncRagExperienceFromManagerRun } from '#agent-shared/ragExperienceBridge'
import { syncAdminExperienceFromManagerRun } from '#agent-shared/adminExperienceBridge'
import { syncCodeExperienceFromManagerRun } from '#agent-shared/codeExperienceBridge'
import { syncCrawlerExperienceFromManagerRun } from '#agent-shared/crawlerExperienceBridge'
import { syncGuiExperienceFromManagerRun } from '#agent-shared/guiExperienceBridge'
import { captureRunArtifactsFromState } from '#agent-shared/artifactRunCapture'
import { saveShadowRunArtifacts } from '#agent-shared/artifactFeedbackOrchestrator'
import { hashSql } from '#agent-shared/artifactStore'
import { isFederationFeedbackGated } from '#agent-shared/artifactFeedbackPolicy'
import { upsertProcessMemory } from '#agent-shared/processMemoryStore'
import { upsertKgFromManagerRun } from '#agent-shared/kgMemoryStore'
import { maybeAutoDraftSkillFromSuccess } from '../../../utils/skills/skillDraftAuto'
import {
  qualifiesSkillAutoDraft,
  refineExperienceWrite,
  isStrictExperienceWriteEnabled,
  shouldIndexExperienceMemory
} from '../../core/memory/experienceWritePolicy'
import { extractSearchRunMetrics, searchMetricsForLearning } from '../../../utils/search/managerSearchMetrics'
import { buildSerpDirectSynthBlock } from '../../../utils/search/managerWebDirectSynth'
import { formatChatWebSynthHint, shouldForceChatWebDirectSynth } from '../../../utils/chat/managerChatWeb'
import { buildEchartsOptionBlock, ensureVisualizeBlocksInFinal } from '../../core/output/finalOutputBlocks'
import { extractTaggedBlockFull, wrapTaggedBlock } from '../../../utils/shared/outputMarkers'
import { CODE_AUTHORITY_CRITIC_RULE, CODE_AUTHORITY_SYNTH_RULE, REPORT_SYNTH_ALIGNMENT_CRITIC_RULE, REPORT_SYNTH_ALIGNMENT_SYNTH_RULE, hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { parseCleanPayload } from '#agent-shared/cleanPayload'
import {
  hasDeterministicReportEvidence,
  shouldPassthroughDbOnly,
  shouldPassthroughDeterministicReport
} from '#agent-shared/deterministicPassthrough'
import { isMultiSourceDataPipeline } from '#agent-shared/dbPipelineDeterministic'
import { resolveSynthShapeSignals } from '#agent-shared/synthShapePolicy'
import { buildDeferredReportFromSynth } from '#agent-shared/deferredReportBlock'
import { maybeCompleteTaskStackFromRun } from '../../core/task/taskStackFinalize'
import {
  assessEvidenceGate,
  hasDbEvidenceInRun
} from '../../core/db/evidenceGate'
import {
  criticRetryContradictsRunEvidence,
  formatEvaluatorForCriticAudit,
  formatEvidenceForCriticAudit
} from '../../core/output/criticEvidence'
import { shouldSkipCriticLlm } from '../../core/output/criticPolicy'
import { loadTaskStack } from '../../core/task/taskStack'
import { extractAndUpsertTasksFromAssistantText, isTaskStackFinalizeLlmExtractEnabled } from '../../core/task/taskStackLlmExtract'
import {
  extractCrawlerItems,
  extractCrawlerTableMarkdown,
  parseCrawlerPayload,
} from '../../../utils/crawler/managerCrawlerTaskPayload'
import { buildCrawlerSourcesTaggedBlock, resolveCrawlerTableMarkdown, extractCrawlerItemsFromText } from '../../../utils/crawler/crawlerItemsParse'
import { pickRicherNarrativeWithAuxBlocks, extractAuxBlocksStructural } from '#agent-shared/auxBlocks'
import { polishFinalPayload } from '../../core/output/replyPolish'
import { isReportDeferredToSynth } from '#agent-shared/reportSynthDefer'
import { stripSynthPromptLeakage } from '#agent-shared/synthOutputSanitize'
import { sanitizeVisionAnswer } from '../../../utils/media/managerVisionSanitize'
import { formatAgentResultSourcesForSynth } from '../../../utils/agents/agentResult'
import { assessCodeDownstreamConsistencyAsync } from '../../../utils/code/managerCodeAuthorityNormalize'
import { isManagerSynthStreamEnabled } from '../../core/runtime/runtime'
import type { LlmInvokeOptions } from '../../core/shared/modelTier'
import { resolveManagerInteractionMode } from '../../../utils/platform/managerInteractionMode'
import { buildCodeFirstBundle } from '#agent-shared/codeFirstAuthority'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { repairCodeAuthorityVisualize } from '../../../utils/code/managerCodeDownstream'
import { canManagerRetryMore, resolveManagerRetryLimits } from '../../core/runtime/retryBudget'
import type { CreateFinalNodesDeps } from './types'
import { buildSynthNode } from './synthNode'
import { buildCriticNode } from './criticNode'
import { buildVerifierNode } from './verifierNode'
import { buildFinalizeNode } from './finalizeNode'
import { buildEmitUserAnswerNode } from './emitUserAnswerNode'

export type { CreateFinalNodesDeps } from './types'

export function createFinalNodes(deps: CreateFinalNodesDeps) {
  return {
    synthNode: buildSynthNode(deps),
    criticNode: buildCriticNode(deps),
    verifierNode: buildVerifierNode(deps),
    finalizeNode: buildFinalizeNode(deps),
    emitUserAnswerNode: buildEmitUserAnswerNode(deps)
  }
}
