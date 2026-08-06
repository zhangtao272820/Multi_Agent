import { prepareUntrustedForSynth, wrapUntrustedContent, UNTRUSTED_BEGIN } from '#agent-shared/contentTrust'
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
import { collectStaleEvidenceSources, buildStaleEvidenceHint } from '../../core/runtime/evidenceFreshness'
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
import { hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { assembleSynthSystemPrompt } from '../../llm/synthPromptProfiles'
import { promptBudgetSystemChars } from '../../core/shared/promptBudget'
import {
  collectUnifiedSources,
  formatCitationInventoryForSynth,
  resolveReplyTier
} from '../../core/output/userFacingPayload'
import { parseCleanPayload } from '#agent-shared/cleanPayload'
import {
  hasDeterministicReportEvidence,
  shouldPassthroughAdminWriteOnly,
  shouldPassthroughDbOnly,
  shouldPassthroughDeterministicReport,
  shouldPassthroughRagOnly
} from '#agent-shared/deterministicPassthrough'
import { formatAdminWriteUserFacingReply } from '../../core/output/adminWriteUserReply'
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
import {
  formatHandoffsFromEvidence
} from '../../../utils/agents/specialistHandoff'
import { assessCodeDownstreamConsistencyAsync } from '../../../utils/code/managerCodeAuthorityNormalize'
import { isManagerSynthStreamEnabled } from '../../core/runtime/runtime'
import type { LlmInvokeOptions } from '../../core/shared/modelTier'
import { resolveManagerInteractionMode } from '../../../utils/platform/managerInteractionMode'
import { buildCodeFirstBundle } from '#agent-shared/codeFirstAuthority'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { repairCodeAuthorityVisualize } from '../../../utils/code/managerCodeDownstream'
import { canManagerRetryMore, resolveManagerRetryLimits } from '../../core/runtime/retryBudget'
import type { CreateFinalNodesDeps } from './types'
import { CriticVerdictSchema, type CriticVerdict } from './schemas'
import { mergeSynthFinalWithReportBody, appendDeferredReportBlockIfNeeded } from './helpers'

export function buildSynthNodeRun(deps: CreateFinalNodesDeps) {
    const {
      ensureNotAborted,
      opts,
      llmInvoke,
      lastUserText,
      runAlwaysInternalCollaborators,
      extractStructuredPayload,
      sanitizeUntrustedText,
      formatReferences,
      stripLatexMath,
      summarize,
      mergeMeta,
      getEffectivePlanSteps,
      timeLeftMs,
      policyPromise,
      defaultPolicy,
      appendMemory,
      appendNluMetrics,
      maybeUpdateManagerPolicy,
      policyDir,
      readFeedbackForRun,
      clampNumber,
      deriveScenarioKey,
      uncertaintyFromConfidence,
      normalizeFinalUserText,
      redactSecrets,
      safeJsonParse,
      IntentSchema
    } = deps

    return async (state: any) => {
        ensureNotAborted()
        // 审计路径由 emit_user_answer 回放；synth 仅寒暄捷径（跳过审计）对用户开流
        const streamSynthEarly =
          isManagerSynthStreamEnabled() && Boolean(state.meta?.directChitchatSynth)
        if (streamSynthEarly) {
          opts.sendEvent({ event: 'phase', data: 'synth', from: 'manager' })
          opts.sendEvent({ event: 'phase', data: 'synth_stream', from: 'manager' })
          opts.sendEvent({ event: 'stream_start', data: { phase: 'synth' }, from: 'manager' })
        } else {
          opts.sendEvent({ event: 'thinking', data: '正在汇总草稿…', from: 'manager' })
        }

        if (Boolean(state.meta?.directChitchatSynth)) {
          const lastOnly = String(lastUserText(state.messages as any) || '').trim()
          opts.sendEvent({
            event: 'thinking',
            data: 'Synth：寒暄/确认 → 轻量对话回复（不引用历史任务或数据规划）',
            from: 'manager'
          })
          try {
            const r = await llmInvoke(
              'synth',
              state,
              [
                new SystemMessage(
                  [
                    '你是总管助手。用户本轮只是寒暄、致谢、确认或在吗，无任何取数/报告/联网/办公诉求。',
                    '用 1～3 句自然中文回复即可；禁止提及「数据」「事实」「报告」「规划」「检索」「对比」「子 Agent」。',
                    '禁止引用上一轮业务任务；不要像在执行 multi 任务或缺少食材做晚餐这类比喻。',
                    '禁止「您好」「作为助手」；语气友好简短。'
                  ].join('\n')
                ),
                new HumanMessage(lastOnly || '你好')
              ],
              { tier: 'light' }
            )
            const finalText = polishFinalPayload(stripLatexMath(String(r.text ?? '').trim()))
            return {
              final: finalText,
              results: state.results || {},
              evidence: state.evidence || [],
              resources: r.resources ?? state.resources,
              meta: mergeMeta(state, {
                directChitchatSynth: true,
                lowCostMode: true,
                chitchatSynth: true,
                sessionIntentAnchor: null
              })
            }
          } catch {
            return {
              final: '你好！有什么我可以帮你的？',
              results: state.results || {},
              evidence: state.evidence || [],
              resources: state.resources,
              meta: mergeMeta(state, { directChitchatSynth: true, chitchatSynth: true, sessionIntentAnchor: null })
            }
          }
        }

        const question = effectiveUserTask(state.messages as any, state.routedQuery)
        const critique = (state as any).fixQuery ? `\n\n注意：之前的尝试失败了，审计建议如下，请务必在本次修正：\n${(state as any).fixQuery}` : ''

        const effectivePlanSteps = getEffectivePlanSteps(state as any)
        const plannedClean = Array.isArray(effectivePlanSteps) ? effectivePlanSteps.some((s: any) => String(s?.agent || '') === 'clean') : false
        const plannedVisualize = Array.isArray(effectivePlanSteps)
          ? effectivePlanSteps.some((s: any) => String(s?.agent || '') === 'visualize')
          : false
        const plannedReport = Array.isArray(effectivePlanSteps) ? effectivePlanSteps.some((s: any) => String(s?.agent || '') === 'report') : false

        // 续执行场景：如果外部步骤已经跑出了 clean/visualize/report，就不要再跑内部 collab（否则会“从头再想”，浪费 token）。
        const existingResults = state.results || {}
        const hasClean = String(existingResults.clean || '').trim().length > 0
        const hasVisualize = String(existingResults.visualize || '').trim().length > 0
        const hasReport = String(existingResults.report || '').trim().length > 0

        const needInternalCollab =
          state.intent === 'multi' &&
          ((plannedClean && !hasClean) ||
            (plannedVisualize && !hasVisualize) ||
            (plannedReport && !hasReport && !isReportDeferredToSynth(existingResults, state.evidence, {
              meta: state.meta,
              planSteps: effectivePlanSteps
            })))

        const merged = needInternalCollab
          ? await runAlwaysInternalCollaborators(state, question, existingResults, state.evidence || [])
          : { results: existingResults, evidence: state.evidence || [], resources: state.resources, meta: state.meta }
        const synthBlocks: string[] = []
        const results = merged.results || {}
        const evidences = merged.evidence || []

        const serpDirectBlock = buildSerpDirectSynthBlock(merged.meta as Record<string, unknown>)
        const chatWebReply = shouldForceChatWebDirectSynth(merged.meta as Record<string, unknown>)
        const chatWebHint = formatChatWebSynthHint(merged.meta as Record<string, unknown>)
        const multiSourceEarly = isMultiSourceDataPipeline(results)
        if (
          serpDirectBlock &&
          (merged.meta?.webDirectSynth === true || chatWebReply) &&
          !multiSourceEarly &&
          merged.meta?.requiresAgentPipeline !== true
        ) {
          synthBlocks.push(serpDirectBlock)
        }

        if (
          shouldPassthroughDbOnly({
            intent: String(state.intent ?? ''),
            planSteps: effectivePlanSteps,
            results,
            evidence: evidences,
            meta: merged.meta,
            professionalMode: resolveManagerInteractionMode(state.meta) === 'professional'
          })
        ) {
          const dbText = String(results.db || '').trim()
          opts.sendEvent({
            event: 'thinking',
            data: 'Synth：单源 DB 直通（跳过汇总 LLM，保留库内原文）',
            from: 'manager'
          })
          const refs = formatReferences(evidences)
          const finalText = polishFinalPayload(`${dbText}${refs}`)
          return { final: finalText, results, evidence: evidences, resources: merged.resources, meta: merged.meta }
        }

        if (
          shouldPassthroughRagOnly({
            intent: String(state.intent ?? ''),
            planSteps: effectivePlanSteps,
            results,
            evidence: evidences,
            meta: merged.meta,
            professionalMode: resolveManagerInteractionMode(state.meta) === 'professional'
          })
        ) {
          const ragText = String(results.rag || '').trim()
          opts.sendEvent({
            event: 'thinking',
            data: 'Synth：单源 RAG 直通（跳过汇总 LLM，保留知识库原文）',
            from: 'manager'
          })
          const refs = formatReferences(evidences)
          const finalText = polishFinalPayload(`${ragText}${refs}`)
          return { final: finalText, results, evidence: evidences, resources: merged.resources, meta: merged.meta }
        }

        if (
          shouldPassthroughAdminWriteOnly({
            intent: String(state.intent ?? ''),
            planSteps: effectivePlanSteps,
            results,
            evidence: evidences
          })
        ) {
          const rawAdmin = String(results.admin || '').trim()
          const handoffSummary = (() => {
            for (const ev of Array.isArray(evidences) ? evidences : []) {
              if (String((ev as { kind?: string })?.kind || '') !== 'admin') continue
              const h = (ev as { handoff?: { summary?: string } })?.handoff
              const s = String(h?.summary || '').trim()
              if (s) return s
            }
            return ''
          })()
          const cleaned = formatAdminWriteUserFacingReply({
            adminText: rawAdmin,
            handoffSummary
          })
          opts.sendEvent({
            event: 'thinking',
            data: 'Synth：admin 写操作直通（跳过汇总 LLM）',
            from: 'manager'
          })
          const finalText = polishFinalPayload(cleaned)
          return { final: finalText, results, evidence: evidences, resources: merged.resources, meta: merged.meta }
        }

        if (
          shouldPassthroughDeterministicReport({
            planSteps: effectivePlanSteps,
            results,
            evidence: evidences,
            intent: String(state.intent ?? ''),
            question
          })
        ) {
          const directReport = String(results.report || '').trim()
          const body = (extractTaggedBlockFull(directReport, 'REPORT') || directReport)
            .replace(/<!--\/?REPORT-->/gi, '')
            .trim()
          opts.sendEvent({
            event: 'thinking',
            data: 'Synth：单源确定性 report 直通（跳过汇总 LLM）',
            from: 'manager'
          })
          const crawlerBlock = buildCrawlerSourcesTaggedBlock(results.crawler)
          const finalText = polishFinalPayload(`${body}${crawlerBlock ? `\n\n${crawlerBlock}` : ''}`)
          return { final: finalText, results, evidence: evidences, resources: merged.resources, meta: merged.meta }
        }

        const taskHasHeavySteps = Array.isArray(effectivePlanSteps)
          && effectivePlanSteps.some((s: any) => ['clean', 'visualize', 'report'].includes(String(s?.agent || '')))

        const mediaAgents: Array<'multimodal' | 'music' | 'video'> = ['multimodal', 'music', 'video']
        for (const agent of mediaAgents) {
          const val = results[agent]
          if (!val) continue
          const wrapped = prepareUntrustedForSynth(agent, String(val).replace(/\s+/g, ' ').trim(), sanitizeUntrustedText, 1200)
          const label = agent === 'multimodal' ? '多模态' : agent === 'music' ? '音乐' : '视频'
          synthBlocks.push([`### 数据来源：${label}`, wrapped || '（无输出）'].filter(Boolean).join('\n'))
        }

        const agents: Intent[] = ['db', 'rag', 'crawler', 'gui', 'code', 'admin']
        const codeAuthoritative = hasCodeInResults(results)
        const multiSourcePipeline = isMultiSourceDataPipeline(results)
        const synthShape = resolveSynthShapeSignals({
          meta: merged.meta,
          planSteps: effectivePlanSteps,
          results,
          multiSourcePipeline,
          questionLength: question.length,
        })
        const multiSourceSynth = synthShape.multiSourceSynth
        const hasGuiResult = Boolean(String(results.gui || '').trim())
        const hasDbResult = Boolean(String(results.db || '').trim())
        let crawlerTableForFinal = ''

        /** A2：优先消费 evidence 上的 handoff 摘要，避免把专才全文灌进 synth */
        const handoffBlock = formatHandoffsFromEvidence(
          Array.isArray(evidences) ? (evidences as Array<Record<string, unknown>>) : []
        )
        const handoffAgents = new Set<string>()
        if (handoffBlock) {
          synthBlocks.push(handoffBlock)
          for (const ev of Array.isArray(evidences) ? evidences : []) {
            const a = String(
              (ev as { agent?: string })?.agent || (ev as { kind?: string })?.kind || ''
            ).trim()
            if (a && (ev as { handoff?: unknown })?.handoff) handoffAgents.add(a)
          }
        }

        const staleMeta = (Array.isArray(evidences) ? evidences : []).flatMap((ev) => {
          const ar = (ev as { agentResult?: { structured?: Record<string, unknown> } }).agentResult
          const structured = ar?.structured
          const rows = Array.isArray(structured?.citations)
            ? (structured?.citations as Array<Record<string, unknown>>)
            : []
          return rows.map((c) => ({
            source: String(c.source || c.ref || ''),
            ingest_at: String(c.ingest_at || c.ingestAt || ''),
            source_version: String(c.source_version || c.sourceVersion || '')
          }))
        })
        const staleHint = buildStaleEvidenceHint(collectStaleEvidenceSources(staleMeta))
        if (staleHint) synthBlocks.push(`### 证据新鲜度\n${staleHint}`)

        for (const agent of agents) {
          const val = results[agent]
          if (!val) continue
          /** 已有 handoff 的专才：默认跳过全文；db/rag 仍注入原文片段，避免 handoff 截断后丢失配比/档案 */
          if (handoffAgents.has(agent) && agent !== 'crawler' && agent !== 'gui') {
            if (agent === 'db' || agent === 'rag') {
              const raw = String(val).trim()
              if (raw.length >= 8) {
                const clipped = raw.length > 2400 ? `${raw.slice(0, 2400)}…` : raw
                const wrapped = prepareUntrustedForSynth(agent, clipped, sanitizeUntrustedText, 2400)
                if (wrapped) {
                  synthBlocks.push(`[CTX:${agent}]\n${wrapped}\n[/CTX]`)
                }
              }
            }
            continue
          }
          if (agent === 'gui') {
            if (handoffAgents.has('gui')) {
              continue
            }
            const wrapped = prepareUntrustedForSynth(
              'gui',
              String(val).replace(/\s+/g, ' ').trim(),
              sanitizeUntrustedText,
              900
            )
            const guiAr = evidences.find((e) => String(e?.agent || '') === 'gui')?.agentResult as
              | { structured?: { finalUrl?: string; stepCount?: number } }
              | undefined
            const finalUrl = String(guiAr?.structured?.finalUrl || '').trim()
            const stepCount = Number(guiAr?.structured?.stepCount || 0)
            synthBlocks.push(
              [
                '[CTX:gui]',
                wrapped || '（无页面抽取文本）',
                finalUrl ? `最终页面：${finalUrl}` : '',
                stepCount > 0 ? `自动化步数：${stepCount}` : '',
                hasDbResult
                  ? '与 DB 互补：GUI 反映页面可见/交互结果，DB 为库内结构化记录；数字冲突时优先采信 DB，页面独有字段可引用 GUI。'
                  : '汇总时保留页面操作结论与可见字段，勿编造未出现的链接或按钮状态。',
                '[/CTX]'
              ]
                .filter(Boolean)
                .join('\n')
            )
            continue
          }
          if (codeAuthoritative && (agent === 'rag' || agent === 'db') && !multiSourceSynth) {
            synthBlocks.push(
              `### 数据来源：${agent.toUpperCase()}\n（结构化数字已纳入 Code 计算；勿在正文重复引用与 Code 冲突的结余/扣款类数字，说明性字段以 Code facts 为准）`
            )
            continue
          }
          if (agent === 'crawler') {
            const tableMd = resolveCrawlerTableMarkdown(val)
            const obj = parseCrawlerPayload(val)
            let items = extractCrawlerItems(obj)
            if (!items.length && typeof val === 'string') {
              items = extractCrawlerItemsFromText(val).map((x) => ({
                title: x.title,
                url: x.url,
                source: x.source,
                excerpt: x.excerpt
              }))
            }
            const itemCount = items.length || (tableMd ? 1 : 0)
            if (tableMd || itemCount) {
              if (tableMd) crawlerTableForFinal = tableMd
              const excerptLines = items
                .slice(0, 5)
                .map((it) => {
                  const title = String(it.title ?? it.name ?? '').trim()
                  const excerpt = String(it.excerpt ?? '').trim()
                  if (excerpt) return `- ${title || '联网来源'}：${excerpt.slice(0, 320)}`
                  return title ? `- ${title}` : ''
                })
                .filter(Boolean)
              synthBlocks.push(
                [
                  '[CTX:crawler]',
                  wrapUntrustedContent({
                    source: 'crawler',
                    text: [
                      `已获取 ${itemCount || '若干'} 条联网参考（完整来源表由系统渲染，正文须引用摘要中的标准/区间/指南要点并与 DB 数据对照）。`,
                      excerptLines.length ? `联网摘要摘录：\n${excerptLines.join('\n')}` : '',
                      '汇总时必须写清：公开参考标准/区间是什么、受测者 DB 数值如何、是否在参考范围内；禁止只写 DB 字段而忽略联网对照。'
                    ]
                      .filter(Boolean)
                      .join('\n'),
                    maxChars: 2400
                  }),
                  '[/CTX]'
                ]
                  .filter(Boolean)
                  .join('\n')
              )
              continue
            }
          }
          const extracted = extractStructuredPayload(String(val))
          let safeAnswer = sanitizeUntrustedText(String(extracted.answer || '').trim())
          safeAnswer = safeAnswer.replace(/\s+/g, ' ').trim()
          if (safeAnswer.length > 720) safeAnswer = `${safeAnswer.slice(0, 720)}…`
          if (agent === 'admin' || agent === 'crawler' || agent === 'gui') {
            safeAnswer = wrapUntrustedContent({ source: agent, text: safeAnswer, maxChars: 800 }) || safeAnswer
          } else if (safeAnswer && (agent === 'rag' || agent === 'db' || agent === 'code')) {
            // E2：检索/工具/仓库正文一律 untrusted wrap，防注入改 cap
            safeAnswer =
              prepareUntrustedForSynth(agent, safeAnswer, sanitizeUntrustedText, 800) || safeAnswer
          }
          const facts: StructuredFact[] = (Array.isArray(extracted.facts) ? extracted.facts : [])
            .map((f: any) => ({
              key: String(f?.key ?? '').trim(),
              value: f?.value ?? '',
              source: typeof f?.source === 'string' ? f.source : undefined
            }))
            .filter((f) => Boolean(f.key))
          const missing = (Array.isArray(extracted.missingFields) ? extracted.missingFields : [])
            .map((x: any) => String(x ?? '').trim())
            .filter(Boolean)
            .slice(0, 6)
          const factLines = facts.slice(0, 10).map((f) => `- ${f.key}: ${String(f.value ?? '').slice(0, 180)}`).join('\n')
          synthBlocks.push(
            [
              `[CTX:${agent}]`,
              safeAnswer ? `摘要：${safeAnswer}` : '',
              facts.length ? `事实：\n${factLines}` : '事实：无（未抽取到结构化 facts）',
              missing.length ? `缺失字段：${missing.join('、')}` : '',
              '[/CTX]'
            ]
              .filter(Boolean)
              .join('\n')
          )
        }

        const agentResultBlock = formatAgentResultSourcesForSynth(evidences)
        if (agentResultBlock) synthBlocks.push(agentResultBlock)

        const hasVisualizeEvidence = evidences.some((e: any) => String(e?.kind ?? '') === 'visualize')
        const shouldShowCharts = plannedVisualize || hasVisualizeEvidence

        const directReport = String(results.report || '').trim()
        const directVisualizeRaw = String(results.visualize || '').trim()
        const directVisualize = shouldShowCharts ? directVisualizeRaw : ''
        const directClean = String(results.clean || '').trim()
        if (directReport) {
          const reportBody = (extractTaggedBlockFull(directReport, 'REPORT') || directReport)
            .replace(/<!--\/?REPORT-->/gi, '')
            .trim()
          if (reportBody) {
            synthBlocks.push(
              [
                '[CTX:report]',
                reportBody.length > 900 ? `${reportBody.slice(0, 900)}…` : reportBody,
                '[/CTX]'
              ].join('\n')
            )
          }
        }
        if (directClean) {
          const cleanPayload = parseCleanPayload(directClean)
          if (cleanPayload) {
            const src = (cleanPayload.sources || []).map((s) => s.agent).join('+') || 'unknown'
            const webFacts = (cleanPayload.facts || []).filter((f) => String(f.source || '').startsWith('crawler'))
            synthBlocks.push(
              [
                '[CTX:clean]',
                cleanPayload.answer ? `摘要：${cleanPayload.answer.slice(0, 400)}` : '',
                webFacts.length
                  ? `联网参考事实：\n${webFacts
                      .slice(0, 6)
                      .map((f) => `- ${String(f.label ?? f.key)}: ${String(f.value ?? '').slice(0, 200)}`)
                      .join('\n')}`
                  : '',
                `来源：${src}`,
                '[/CTX]'
              ]
                .filter(Boolean)
                .join('\n')
            )
          }
        }
        const canShowAuxOutputs =
          taskHasHeavySteps || Boolean(directReport) || Boolean(directClean) || Boolean(directVisualize)
        const planAgentList = effectivePlanSteps.map((s: any) => String(s?.agent || '')).filter(Boolean)
        const plannedAdmin = planAgentList.includes('admin')
        const hasAdminResult = Boolean(String(results.admin || '').trim())
        const adminSynthContext = plannedAdmin || hasAdminResult
        const mediaPlanAgents = inferMediaPlanAgents(String(state.intent || ''), planAgentList)
        if (isMediaOnlyPlanAgents(mediaPlanAgents)) {
          const composite = buildCompositeMediaFinal(results, mediaPlanAgents)
          if (composite.trim()) {
            const refs = formatReferences(evidences)
            return {
              final: `${composite}${refs}`,
              results,
              evidence: evidences,
              resources: merged.resources,
              meta: merged.meta
            }
          }
        }

        const replyTier = resolveReplyTier({
          intent: String(state.intent || ''),
          results,
          planSteps: effectivePlanSteps,
          meta: merged.meta,
          multiSourceSynth,
          canShowAuxOutputs,
          adminSynthContext,
          chatWebReply,
          hasGuiResult,
          hasDbResult
        })
        const citationSources = collectUnifiedSources({
          evidence: evidences,
          meta: merged.meta,
          max: 12
        })
        const citationInventory = formatCitationInventoryForSynth(citationSources)
        const synthSystemText = assembleSynthSystemPrompt({
          multiSourceSynth,
          canShowAuxOutputs,
          shouldShowCharts,
          adminSynthContext,
          codeAuthoritative,
          hasGuiResult,
          hasDbResult,
          chatWebReply,
          chatWebHint: chatWebHint || '',
          replyTier
        })
        if (synthSystemText.length > promptBudgetSystemChars()) {
          opts.sendEvent({
            event: 'thinking',
            data: `Synth：System prompt 超预算（${synthSystemText.length}>${promptBudgetSystemChars()}，未截断）`,
            from: 'manager'
          })
        }
        const closingHint =
          replyTier === 'lite'
            ? '\n\n【最终指示】只输出给用户看的 2～8 句确认；禁止任何 ### 报告章节、执行摘要、管线 agent 回显。'
            : replyTier === 'report'
              ? '\n\n【最终指示】像 DeepSeek 一样写给用户：首段结论 → ### 关键发现 → ### 详细说明（对照表）→ ### 建议；写完建议即止。严禁「执行摘要 / rag: / db: / agent_result / 逻辑删除」等开发内容。'
              : '\n\n【最终指示】像 DeepSeek 一样对话作答：首段结论 → 按需 ### 分段 → [n] 引用；严禁执行摘要与管线回显。'
        const synthPrompt = [
          new SystemMessage(synthSystemText),
          new HumanMessage(
            `用户任务：${question}${critique}\n\n` +
              `【内部参考·禁止复述进正文】下列 CTX/子步骤仅供你采信事实与数字，严禁改写成「执行摘要」或 rag:/db: 列表：\n` +
              (synthBlocks.length ? synthBlocks.join('\n\n') : '（暂无可用事实数据）') +
              (citationInventory ? `\n\n${citationInventory}` : '') +
              (directVisualize ? '\n\n[附属] 已有可视化 Agent 输出（含图表配置），正文须与之保持一致，勿称图表未生成。' : '') +
              (directReport
                ? replyTier === 'report'
                  ? '\n\n[附属] 已有报告草稿：请用自己的话写成面向用户的 DeepSeek 式正文；勿整段粘贴附录，勿追加执行摘要。'
                  : '\n\n[附属] 已有报告草稿：提炼面向用户的结论写入正文即可，勿整段复述。'
                : plannedReport && replyTier === 'report'
                  ? '\n\n[说明] 报告由你汇总：全部写在面向用户的正文里；写完建议即止。'
                  : '') +
              (hasAdminResult && !handoffAgents.has('admin')
                ? `\n\n[附属] admin 已执行：${prepareUntrustedForSynth(
                    'admin',
                    String(results.admin).replace(/\s+/g, ' ').trim().slice(0, 400),
                    sanitizeUntrustedText,
                    400
                  )}${
                    /未确认，未写入/.test(String(results.admin || ''))
                      ? '\n（写操作未确认，未落库；禁止改写成权限不足或编造已创建。）'
                      : /协议异常/.test(String(results.admin || ''))
                        ? '\n（协议异常，禁止复述能力列表 preamble。）'
                        : ''
                  }`
                : hasAdminResult && handoffAgents.has('admin')
                  ? '\n\n[说明] admin 结果已在 HANDOFF 中；勿复述能力清单、置信度或不可信标记。'
                  : plannedAdmin
                  ? '\n\n[说明] 计划含 admin 步骤，但当前无 admin 子输出；勿编造已创建提醒/日程。'
                  : '\n\n[说明] 本任务计划未含 admin 步骤；禁止声称已创建提醒/日程/会议/待办。') +
              closingHint
          )
        ]

        try {
          // 主路径静默写 final；用户面 delta 由 emit_user_answer 在审计通过后回放
          const r = await llmInvoke('synth', state, synthPrompt, {})
          const synthText = stripSynthPromptLeakage(stripLatexMath(String(r.text ?? '')))
          const extras: string[] = []
          if (canShowAuxOutputs) {
            if (directVisualize) {
              const echartBlock = buildEchartsOptionBlock(directVisualize)
              const tableBlock = extractTaggedBlockFull(directVisualize, 'TABLE_DATA')
              const parts: string[] = []
              if (echartBlock) parts.push(`\n\n${echartBlock}`)
              if (tableBlock) parts.push(`\n\n${tableBlock}`)
              if (parts.length) extras.push(parts.join(''))
            }
            if (directReport) {
              const tagged = extractTaggedBlockFull(directReport, 'REPORT')
              const body = (tagged || directReport).replace(/<!--\/?REPORT-->/gi, '').trim()
              if (body) extras.push(`\n\n${wrapTaggedBlock('REPORT', body)}`)
            }
          }
          const crawlerBlock = buildCrawlerSourcesTaggedBlock(results.crawler)
          const crawlerExtra = crawlerBlock ? `\n\n${crawlerBlock}` : ''
          // 流式 delta 为原始 LLM 正文；此处勿 polish，避免与流式预览不一致（polish 在 finalize 统一一次）
          let mergedText = `${synthText}${extras.join('')}${crawlerExtra}`.trim()
          mergedText = appendDeferredReportBlockIfNeeded({
            body: mergedText,
            synthSource: synthText,
            results,
            evidence: evidences,
            plannedReport,
            shapeCtx: { meta: merged.meta, planSteps: effectivePlanSteps }
          })
          return {
            final: mergedText,
            results,
            evidence: evidences,
            resources: r.resources,
            meta: mergeMeta(merged.meta || state.meta, { synthStreamBody: synthText })
          }
        } catch {
          return { final: '抱歉，报告生成过程中出现异常，请稍后重试。', results, evidence: evidences, resources: merged.resources, meta: mergeMeta(state, { uncertainty: 'high' }) }
        }
      }
}
