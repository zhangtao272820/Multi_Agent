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
import { CODE_AUTHORITY_CRITIC_RULE, CODE_AUTHORITY_SYNTH_RULE, REPORT_SYNTH_ALIGNMENT_CRITIC_RULE, REPORT_SYNTH_ALIGNMENT_SYNTH_RULE, hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { parseCleanPayload } from '#agent-shared/cleanPayload'
import {
  hasDeterministicReportEvidence,
  shouldPassthroughAdminWriteOnly,
  shouldPassthroughDbOnly,
  shouldPassthroughDeterministicReport
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
import { shouldEmitUserSynthStream } from '../../core/runtime/streamEvents'
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
        opts.sendEvent({ event: 'phase', data: 'synth', from: 'manager' })
        const streamSynthEarly =
          isManagerSynthStreamEnabled() && shouldEmitUserSynthStream(state)
        if (streamSynthEarly) {
          opts.sendEvent({ event: 'phase', data: 'synth_stream', from: 'manager' })
          opts.sendEvent({ event: 'stream_start', data: { phase: 'synth' }, from: 'manager' })
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
          /** 已有 handoff 的专才：跳过全文 CTX，仅保留 crawler 表等特殊渲染钩子 */
          if (handoffAgents.has(agent) && agent !== 'crawler' && agent !== 'gui') {
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

        const synthPrompt = [
          new SystemMessage(
            [
              '你是总管 Agent 的对话式汇总助手。用中文像正式产品助手一样回复：先给结论，再按需要补充要点；说清事实与结果，不要空话套话。',
              '纪律：专业、克制；禁止「您好」「作为助手」「根据您的要求」「别担心」等客套；禁止贴 JSON/日志/内部章节名。',
              '纪律：禁止复述输入中的 [CTX:…]…[/CTX]、数据来源、RAG 检索事实、[事实N] 等内部参考块；只输出面向用户的自然语言。',
              '纪律：禁止输出「执行摘要 / 已执行步骤 / 证据 / 目标·结果·判定 / 后续建议」等内部审计章节，以及 rag:/clean:/s2 (clean):/facts(N): 等管线回显。',
              chatWebHint || '',
              '',
              canShowAuxOutputs && shouldShowCharts
                ? adminSynthContext
                  ? '本任务含图表与 admin 等多步：正文 800～1200 字，须完整展开。写清：①关键数字与来源口径；②计算或对比结论；③图表在说明什么；④admin 日程/提醒/待办的实际执行结果。附属图表/报告块仅作补充，正文不得因「另有报告」而缩短。'
                  : '本任务含图表/报告等附属输出：正文 800～1200 字，须完整展开。写清关键数字、对比结论与图表含义；附属块仅作补充，正文不得缩短为摘要。'
                : canShowAuxOutputs
                  ? '本任务含报告等附属输出：正文 800～1200 字，须完整展开分析；勿只写一两句摘要把细节留给附属块。'
                  : multiSourceSynth
                    ? '多源任务：正文 700～1000 字，分段说明各源结论与采信口径。'
                    : adminSynthContext && !canShowAuxOutputs && !multiSourceSynth
                      ? [
                          '本任务为个人助理写操作确认：',
                          '· 用 1～3 句说清「做了什么」：事项标题、时间、是否已设提醒/是否已写入。',
                          '· 语气正式简短，像系统回执；不要展开背景、不要安慰话、不要主动推销下一步。',
                          '· 禁止 ### 小标题、**小结**、数据来源说明、后续建议、执行摘要、置信度、能力清单。'
                        ].join('\n')
                      : '总字数 500～800 字；单源查数也要给出解读与建议，勿只报数字。',
              '',
              '格式：',
              adminSynthContext && !canShowAuxOutputs && !multiSourceSynth
                ? '- 写操作成功：直接确认结果即可；缺信息时一句说明缺口，勿编造。'
                : '- 禁止报告体大章节名（不要出现「核心结论」「要点摘要」「计算口径」「风险与建议」「参考来源」等标题）。',
              adminSynthContext && !canShowAuxOutputs && !multiSourceSynth
                ? '- 禁止输出置信度、不可信外部数据、能力清单、agent_result、[HANDOFF]、[CTX]。'
                : '- 推荐结构：首段直接结论 → ### 分段展开（每段 2～5 条 - 列表）→ 末段 **小结**（1～2 句；仅在用户明确需要时给一句可执行建议）。',
              adminSynthContext && !canShowAuxOutputs && !multiSourceSynth
                ? '- 可用 **加粗** 强调标题或时间；不要用列表堆砌能力说明。'
                : '- 可用 **加粗** 强调数字与结论；列表每条独立一行，以 - 开头。',
              '- 禁止在正文粘贴 http/https 链接、「| 排名 |」类抓取表格、[查看](url) 链接墙。',
              chatWebReply
                ? '- 联网问答：对比/推荐类任务优先用 Markdown 表格（| 列 | 列 |）；正文用 [1][2] 角标引用来源，系统会在下方展示链接；信息不足时说明缺口。'
                : '',
              '- 数字带单位；有公式时用一行 inline 说明即可，不要单独开「计算口径」段。',
              codeAuthoritative && !multiSourceSynth
                ? '- 有 Code 时：正文与图表的数字**仅**来自 Code 的 income/expense/balance（结余=收入−支出）；五险一金/公积金等写在 facts 中作说明，不得与柱图结余混为一谈。'
                : multiSourceSynth
                  ? '- 多源对照：DB/库内数值与联网公开参考区间须分开展示并说明采信口径；禁止把 DB 个人数据标成「联网检索摘要」。'
                  : '',
              codeAuthoritative
                ? '- 写代码/脚本任务：须用 ```python 或 ```javascript 围栏输出完整可运行示例（含必要 import）；先 1～2 句说明再贴代码；勿只给伪代码。'
                : '',
              CODE_AUTHORITY_SYNTH_RULE,
              REPORT_SYNTH_ALIGNMENT_SYNTH_RULE,
              '- 无 Code 时：有 RAG/爬虫/DB 冲突可一句说明采信哪边；来源由系统在文末展示，正文勿列 URL。',
              '- 若 RAG/知识库子步骤标明未命中（needs_clarify、澄清说明、无结构化 facts），禁止编造该部分所需的库内私人数字；应明确说明知识库未返回，仅基于其它子步骤已证实的数据展开。',
              '- DB/子步骤证据中未出现的字段名、数值、比例、阈值，禁止编造或猜测；缺列/缺统计时须明确说明「依据当前结果无法计算」，不得自行定义阈值后填占比。',
              hasGuiResult && hasDbResult
                ? '- 同时有 GUI 与 DB：库内数字以 DB 为准；GUI 仅补充页面操作结果或库外可见信息，勿用 GUI 覆盖 DB 统计。'
                : hasGuiResult
                  ? '- 有 GUI 时：正文必须基于 GUI 子步骤输出（页面操作结论、抽取到的标题/链接/文本）；禁止声称「系统限制网页操作」或「无法打开网页」——那是 DB Agent 的口径。若 GUI 结果不完整，如实说明已获取到的内容并指出缺口。'
                  : '',
              '- 有爬虫/联网参考时：正文须写出公开标准/区间/指南要点，并与 DB 数值对照；可写「详见下方来源表」，但不得只复述 DB 而忽略联网对照。',
              '- 已有 visualize/report 子输出时：正文仍须充分展开（800 字以上）；可概括报告要点但不得把正文缩成摘要；正文与 <!--REPORT--> 块对同一事实须一致。',
              adminSynthContext
                ? '- 若 admin 步骤已成功（日程/提醒/邮件/待办），必须在正文中明确写出执行结果（如会议标题、时间、是否已设提醒），不可遗漏。'
                : '- **禁止编造写操作**：计划中无 admin 步骤、子步骤也无 admin 输出时，不得声称「已创建提醒/日程/会议/待办/邮件」或「已为 admin 执行」；文字建议须明确仅为建议、未实际写入。',
              '- 若正文下方将展示 ECharts 图表，禁止写「可视化已跳过/熔断/未生成图表」；无完整收支数据时勿在图表中填 0 冒充支出/结余。'
            ].join('\n')
          ),
          new HumanMessage(
            `用户任务：${question}${critique}\n\n子步骤数据源：\n` +
              (synthBlocks.length ? synthBlocks.join('\n\n') : '（暂无可用事实数据）') +
              (directVisualize ? '\n\n[附属] 已有可视化 Agent 输出（含图表配置），正文须与之保持一致，勿称图表未生成。' : '') +
              (directReport
                ? '\n\n[附属] 已有报告 Agent 输出：正文仍须充分展开分析与结论（600 字以上），下方报告块为结构化附录，勿把正文缩成一两句摘要。'
                : plannedReport
                  ? '\n\n[说明] 报告由你汇总撰写：全部内容写在正文，用 ### 分段；勿留空壳摘要。'
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
              '\n\n请用对话口吻直接回答（不要报告章节标题）：'
          )
        ]

        try {
          const streamSynth =
            isManagerSynthStreamEnabled() && shouldEmitUserSynthStream(state)
          const r = await llmInvoke('synth', state, synthPrompt, {
            onDelta: streamSynth
              ? (delta) => {
                  if (delta) opts.sendEvent({ event: 'delta', data: delta, from: 'synth' })
                }
              : undefined
          })
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
