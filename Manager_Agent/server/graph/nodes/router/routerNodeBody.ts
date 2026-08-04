import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { coalesceRoutingHeuristicsText, shouldRunNlCoalesce } from '../../core/routing/nlResolve'
import {
  preferCurrentTurnScope,
  routingConversationContext,
  routingHeuristicsUserText,
  buildMultiRouteAdvisory,
  shouldSkipRouteHistoryBias
} from '../../core/text'
import { clausesFromMeta, reconcileRouteAllowedAgents, agentsFromClauses } from '../../core/routing/clauses'
import { composeManagerPromptContext } from '../../core/plan/contextComposer'
import {
  buildRouteStrategyAdvice,
  isRouteStrategyEnabled
} from '../../core/routing/routeStrategy'
import {
  buildRouteBanditAdvice,
  isRouteBanditEnabled
} from '../../core/routing/routeBandit'
import {
  buildRoutePolicyRlAdvice,
  isRoutePolicyRlEnabled
} from '../../core/routing/routePolicyRl'
import {
  buildCausalRouteAdvice,
  isRouteCausalEnabled
} from '../../core/routing/routeCausal'
import { applyRouterTaskStackOp } from '../../core/task/taskStackIngest'
import {
  buildWorldModelSnapshot,
  formatWorldModelBlock,
  isWorldModelEnabled,
  saveWorldModelSnapshot
} from '../../core/task/worldModel'
import { filterAgentsRespectingWriteGate, writeGateRouterHint } from '../../core/db/writeGate'
import { reconcileExtendedAgentAvailability, unhealthyAgentsForPrompt } from '../../core/agent/agentRegistry'
import { formatGuiDeployHintForRouter } from '../../../utils/gui/managerGuiAgentAvailability'
import { buildCapabilitySnapshotFromProbe, formatCapabilityProbeBlock } from '../../core/agent/agentCapabilities'
import { parseRouteLlmJson, ROUTE_JSON_EXAMPLE } from '../../core/shared/llmJson'
import { resolveTaskConstraints, taskConstraintsFromMeta } from '../../llm/taskConstraintsLlm'
import { coerceConstraintsForSimpleDbQuery, coerceConstraintsForSimpleRagQuery } from '../../../utils/db/managerDbSchemaHintsPolicy'
import { intentClassifyFromMeta } from '../../llm/intentClassifyLlm'
import { intentRagRecallFromMeta } from '../../core/rag/intentRagRecall'
import { resolveCompositeMediaAgents } from '../../llm/mediaRouteLlm'
import type { TaskConstraints } from '../../core/plan'
import { coalesceSimpleDbRoute, coalesceSimpleRagRoute } from '../../core/plan/planShortcuts'
import {
  finalizeLlmAllowedAgents,
  finalizeLlmRouteIntent,
  inferAllowedAgentsFromProbe,
  normalizeLlmAllowedAgents,
  stripAdminIfNotInCurrentTurn,
  type ExecutableAgent
} from '../../core/routing/routeFinalize'
import {
  alignAllowedAgentsWithDataPlane,
  ensureMultiIntentForPipeline,
  reconcileIntentClassifyDataPlane,
  requiresAgentPipelineExecution,
  shouldBlockDbOnlyCoalesce,
  stripDbUnlessDbAnchored
} from '../../orchestrate/routeOrchestration'
import {
  alignAllowedAgentsWithUnderstanding,
  describeAllowedAgentDelta
} from '../../core/routing/routeUnderstandAlign'
import { supplementAllowedFromWebStructuralAsync, applyGuiRouteOverrides } from '../../llm/webTaskStructuralLlm'
import { isChatWebMode, isManagerChatWebEnabled } from '../../../utils/chat/managerChatWeb'
import {
  formatRouteOrchestrationSummary,
  formatRouteDecisionThinking,
  isOrchVerbose,
  noteRouteAdjustment
} from '../../orchestrate/orchestrationNarrative'
import { resolveNeedsWebSearchAsync } from '../../../utils/search/managerWebSearchLlm'
import {
  applyCompositeRouteGuard,
  resolveCompositeRouteGuardByLlm,
  webExecutionModeFromCompositeGuard
} from '../../../utils/route/managerCompositeRouteGuardLlm'
import { getRouterPlaybookStatic, getAdminCapabilitiesAddon, getGuiAutomationAddon } from '../../core/evolution/playbookPrompts'
import { isUnifiedRoutingActive, shouldSkipLegacyRoutingNodes } from '../../orchestrate/unifiedRouting'
import {
  formatTurnScopeRouterHint,
  resolveTurnRoutingScope,
  shouldDirectChitchatSynth
} from '../../core/routing/turnScope'
import { emitRouteCapEvent } from '../../core/routing/routeStepsEvent'
import { sessionIntentAnchorFromMeta } from '../../core/memory/multiTurnIntent'
import { ROUTER_PLAYBOOK_FALLBACK, deriveAllowedAgentsFromRoute, finalizeAllowedAgents } from './helpers'
import type { CreateRouterNodeDeps } from './types'


export async function runRouterNodeBody(state: any, deps: CreateRouterNodeDeps) {
  const {
      policyDir,
      sessionId,
      runId,
      opts,
      policyPromise,
      defaultPolicy,
      lastUserText,
      isExplicitMultiRequest,
      shouldPreferMulti,
      needsDataFoundation,
      RouteSchema,
      llmInvoke,
      mergeMeta,
      safeJsonParse,
      summarize,
      appendConstraintsToQuery,
      uncertaintyFromConfidence,
      normalizeEntities
    } = deps
      if (isUnifiedRoutingActive(state) && Array.isArray(state.allowedAgents) && state.allowedAgents.length > 0) {
        const metaRoute = Number(state.meta?.routeConfidence)
        const classifyConf = Number(state.meta?.intentClassify?.confidence)
        if (!(Number.isFinite(metaRoute) && metaRoute > 0) && Number.isFinite(classifyConf) && classifyConf > 0) {
          const routeConfidence = Math.min(1, Math.max(0.35, classifyConf))
          return {
            meta: mergeMeta(state, {
              routeConfidence,
              uncertainty: routeConfidence >= 0.75 ? 'low' : routeConfidence >= 0.5 ? 'medium' : 'high'
            })
          }
        }
        return {}
      }
      if (shouldSkipLegacyRoutingNodes(state) && state?.meta?.orchestratorSource) {
        const metaRoute = Number(state.meta?.routeConfidence)
        const classifyConf = Number(state.meta?.intentClassify?.confidence)
        if (!(Number.isFinite(metaRoute) && metaRoute > 0) && Number.isFinite(classifyConf) && classifyConf > 0) {
          const routeConfidence = Math.min(1, Math.max(0.35, classifyConf))
          return {
            meta: mergeMeta(state, {
              routeConfidence,
              uncertainty: routeConfidence >= 0.75 ? 'low' : routeConfidence >= 0.5 ? 'medium' : 'high'
            })
          }
        }
        return {}
      }

      opts.sendEvent({ event: 'phase', data: 'route', from: 'manager' })
      const lastUser = String(lastUserText(state.messages as any) ?? '').trim()
      const chatRevision = String(state.meta?.chatRevision || '').trim()
      const isRevisionRun = chatRevision === 'edit_resend' || chatRevision === 'regenerate'
      const revisionUserText = String(state.meta?.revisionUserText || '').trim()
      const routeLastUser = isRevisionRun && revisionUserText ? revisionUserText : lastUser
      const turnScope = resolveTurnRoutingScope({
        messages: state.messages as any,
        lastUser: routeLastUser,
        sessionAnchor: sessionIntentAnchorFromMeta(state.meta),
        intentClassify: intentClassifyFromMeta(state.meta),
        attachment: state.mediaAttachment,
        meta: state.meta
      })
      const turnIsolated =
        isRevisionRun || turnScope.mode === 'current_only' || turnScope.mode === 'topic_shift' || turnScope.mode === 'chitchat'
      const question = turnScope.suppressMultiTurnMerge ? routeLastUser : turnScope.routingContext
      const qTrim = String(question || '').trim()

      if (turnScope.mode === 'topic_shift' && !state.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: '路由：话题切换 → 仅以当前轮路由（不继承上轮 rag/db/multi 锚点）',
          from: 'manager'
        })
      }

      if (
        shouldDirectChitchatSynth({
          meta: state.meta,
          intentClassify: intentClassifyFromMeta(state.meta),
          turnScope
        }) &&
        !state.mediaAttachment?.filePath &&
        !state.forceIntent
      ) {
        opts.sendEvent({
          event: 'thinking',
          data: '路由：寒暄/确认 → 直连对话合成（跳过子 Agent）',
          from: 'manager'
        })
        return {
          intent: 'multi',
          allowedAgents: [],
          routedQuery: routeLastUser,
          entities: normalizeEntities(undefined),
          meta: mergeMeta(state, {
            routeConfidence: 0.93,
            uncertainty: 'low',
            needsClarify: false,
            clarifyQuestions: [],
            directChitchatSynth: true,
            turnScopeMode: turnScope.mode,
            sessionIntentAnchor: null
          }),
          resources: state.resources
        }
      }

      const emitRouteUi = (payload: {
        intent: string
        allowedAgents: ExecutableAgent[]
        routedQuery: string
        rationale?: string
        needsWebSearch?: boolean
      }) => {
        emitRouteCapEvent({ sendEvent: opts.sendEvent, runId }, payload)
        if (!state.meta?.lowCostMode) {
          opts.sendEvent({
            event: 'thinking',
            data: `路由 cap：${payload.allowedAgents.length ? payload.allowedAgents.join('、') : '（直连对话）'}｜intent=${payload.intent}`,
            from: 'manager'
          })
        }
      }

      // 人工确认/取消（admin）续执行：当用户在澄清消息中回复“确认/取消”时，
      // 直接复用上下文里的待确认操作，避免再跑一轮不必要的澄清/规划。
      const humanDecision = state?.humanDecision
      // 仅接受后端专用的 human_confirm 决策；避免用户输入“确认/取消”触发多余的路由逻辑
      const isAdminConfirm = humanDecision === 'confirm'
      const isAdminCancel = humanDecision === 'cancel'
      if (isAdminConfirm || isAdminCancel) {
        const humanMessages = Array.isArray(state.messages) ? state.messages.filter((m: any) => m instanceof HumanMessage) : []
        const reversedHumans = [...humanMessages].reverse()
        const resumeQuestion = (() => {
          // human_confirm 不会写入新用户文本，因此直接取最近的人类问题
          if (humanDecision) return String(reversedHumans[0]?.content || '').trim() || qTrim
          const prevHuman = reversedHumans.find((m: any) => String(m?.content || '').trim() !== qTrim) || reversedHumans[0]
          return String(prevHuman?.content || '').trim() || qTrim
        })()

        const opRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\[\s*([0-9]+)\s*\]/g
        const funcRegex = /(add_[a-zA-Z0-9_]+)/g
        const extractOps = (text: string) => {
          const s = String(text || '')
          const bracketOps = Array.from(s.matchAll(opRegex))
            .map((m) => {
              const fn = String(m?.[1] || '').trim()
              const idx = String(m?.[2] || '').trim()
              return fn && idx ? `${fn}[${idx}]` : ''
            })
            .filter(Boolean)
          const funcOps = Array.from(s.matchAll(funcRegex)).map((m) => String(m?.[1] || '').trim()).filter(Boolean)
          return Array.from(new Set([...bracketOps, ...funcOps])).slice(0, 10)
        }
        const assistantMessages = Array.isArray(state.messages) ? state.messages.filter((m: any) => !(m instanceof HumanMessage)) : []
        const lastAdminClarifyText =
          [...assistantMessages].reverse().find((m: any) => /等待确认|待确认操作|确认继续|请回复“确认”/i.test(String(m?.content || ''))) || assistantMessages.slice(-1)[0]
        const pendingOps = extractOps(String(lastAdminClarifyText?.content || ''))

        if (isAdminCancel) {
          return {
            intent: 'report',
            allowedAgents: ['report'],
            routedQuery: `用户已取消人工确认。\n\n请停止任何待办/提醒执行，并回复“已取消”。`,
            entities: normalizeEntities(undefined),
            meta: mergeMeta(state, { routeConfidence: 0.95, uncertainty: 'low', lowCostMode: true, needsClarify: false, clarifyQuestions: [] }),
            resources: state.resources
          }
        }

        const pendingOpsText = pendingOps.length ? pendingOps.join('、') : '（未识别到具体操作，按 admin 语义尽量执行）'
        // 续执行模式：尽量少塞“新指令”，只保留原问题口径 + 待确认操作，降低输出漂移
        const routedQuery = `${resumeQuestion}\n\n用户已确认：继续执行待确认操作：${pendingOpsText}`

        const prevAllowed = normalizeLlmAllowedAgents(state.allowedAgents)
        const baseAllowed: ExecutableAgent[] = prevAllowed.length ? prevAllowed : ['admin']
        const allowedAgents = deriveAllowedAgentsFromRoute(
          'multi',
          baseAllowed.length >= 2 ? baseAllowed : ['admin', ...baseAllowed]
        )

        return {
          intent: 'multi',
          allowedAgents,
          routedQuery,
          entities: normalizeEntities(undefined),
          meta: mergeMeta(state, { routeConfidence: 0.95, uncertainty: 'low', lowCostMode: true, needsClarify: false, clarifyQuestions: [] }),
          resources: state.resources
        }
      }

      const attachment = state.mediaAttachment

      let nlHeuristicPlain = String(state.meta?.nlHeuristicTask || '').trim()
      let routeState = state
      if (
        !nlHeuristicPlain &&
        !state.meta?.intentMergedLlm &&
        shouldRunNlCoalesce(state.messages as any, lastUser) &&
        !turnScope.suppressMultiTurnMerge &&
        !attachment?.filePath &&
        !state.meta?.lowCostMode
      ) {
        try {
          const hit = await coalesceRoutingHeuristicsText({
            llmInvoke,
            state,
            routingContext: qTrim,
            lastTurnOnly: lastUser
          })
          if (hit?.coalesced) {
            nlHeuristicPlain = hit.coalesced.trim()
            routeState = {
              ...state,
              resources: hit.resources,
              meta: mergeMeta(state, {
                ...(hit.meta && typeof hit.meta === 'object' ? hit.meta : {}),
                nlHeuristicTask: nlHeuristicPlain,
                nlCoalesceUsed: true
              })
            }
            opts.sendEvent({ event: 'thinking', data: '路由：已用 LLM 合并多轮语义生成启发式任务句（非关键词规则）', from: 'manager' })
          }
        } catch {
          /* 合并失败则回退结构化拼接 */
        }
      }

      const heuristicsText = isRevisionRun
        ? routeLastUser
        : attachment?.filePath
          ? lastUser
          : nlHeuristicPlain.length > 0
            ? `${nlHeuristicPlain.slice(0, 880)}\n\n【当前用户输入】\n${lastUser}`
            : String(routingHeuristicsUserText(state.messages as any) || '').trim() || lastUser || qTrim

      const routeQuestion = attachment?.filePath ? routeLastUser : question

      const routingPolicy = await policyPromise.catch(() => defaultPolicy())
      if (routeState.meta?.policyCanary && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `策略金丝雀：本会话使用 shadow 策略 v${routingPolicy?.version ?? '?'}`,
          from: 'manager'
        })
      }
      const forced = ['db', 'rag', 'multimodal', 'music', 'video'].includes(String(state.forceIntent))
        ? state.forceIntent
        : null

      let constraints = taskConstraintsFromMeta(routeState.meta) ?? (await resolveTaskConstraints(heuristicsText, llmInvoke, routeState))
      const intentClassify = intentClassifyFromMeta(routeState.meta)
      constraints = coerceConstraintsForSimpleDbQuery(constraints, routeQuestion, {
        intentClassify,
        intent: String(routeState.intent || '')
      })
      constraints = coerceConstraintsForSimpleRagQuery(constraints, routeQuestion, {
        intentClassify,
        intent: String(routeState.intent || '')
      })
      routeState = { ...routeState, meta: mergeMeta(routeState, { taskConstraints: constraints }) }
      if (attachment?.filePath) {
        const compositeMedia = await resolveCompositeMediaAgents(heuristicsText, attachment, llmInvoke, routeState)
        if (compositeMedia) {
          routeState = { ...routeState, meta: mergeMeta(routeState, { compositeMediaAgents: compositeMedia }) }
        }
      }
      if (
        constraints.timeHints.length ||
        constraints.subjectHints.length ||
        constraints.wantsVisualize ||
        constraints.wantsReport
      ) {
        opts.sendEvent({ event: 'task_constraints', data: constraints, from: 'manager' })
      }

      const worldModel =
        sessionId && isWorldModelEnabled()
          ? await buildWorldModelSnapshot(policyDir, sessionId, {
              toolHealth: state.toolHealth,
              userId: deps.userId
            }).catch(() => null)
          : null
      if (worldModel) {
        await saveWorldModelSnapshot(policyDir, worldModel).catch(() => undefined)
        routeState = {
          ...routeState,
          meta: mergeMeta(routeState, {
            worldModelRisk: worldModel.risk,
            worldModelPosture: worldModel.posture,
            worldModel: {
              risk: worldModel.risk,
              benefit: worldModel.benefit,
              cost: worldModel.cost,
              confidence: worldModel.confidence,
              posture: worldModel.posture
            }
          })
        }
      }

      const routeStrategy = isRouteStrategyEnabled()
        ? await buildRouteStrategyAdvice(policyDir, sessionId, state.toolHealth).catch(() => null)
        : null
      const routeBandit = isRouteBanditEnabled()
        ? await buildRouteBanditAdvice(policyDir, sessionId).catch(() => null)
        : null
      const routePolicyRl = isRoutePolicyRlEnabled()
        ? await buildRoutePolicyRlAdvice(policyDir, sessionId).catch(() => null)
        : null
      const routeCausal = isRouteCausalEnabled()
        ? await buildCausalRouteAdvice(policyDir, sessionId).catch(() => null)
        : null
      if (routeBandit?.routerHintBlock && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `Bandit：${routeBandit.routerHintBlock.split('\n').slice(1, 3).join(' ').slice(0, 120)}`,
          from: 'manager'
        })
      }
      if (routeStrategy?.reasons?.length && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `策略决策：${routeStrategy.reasons.slice(0, 2).join('；')}${routeStrategy.reasons.length > 2 ? '…' : ''}`,
          from: 'manager'
        })
      }
      if (routePolicyRl?.routerHintBlock && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `策略梯度：${routePolicyRl.routerHintBlock.split('\n').slice(1, 2).join(' ').slice(0, 120)}`,
          from: 'manager'
        })
      }
      if (routeCausal?.routerHintBlock && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `因果图：${routeCausal.routerHintBlock.split('\n').slice(1, 2).join(' ').slice(0, 120)}`,
          from: 'manager'
        })
      }
      if (routeStrategy?.forceLowCostMode) {
        routeState = {
          ...routeState,
          meta: mergeMeta(routeState, { lowCostMode: true, routeStrategy })
        }
      } else if (routeStrategy) {
        routeState = { ...routeState, meta: mergeMeta(routeState, { routeStrategy }) }
      }

      const p = state.probe
      const probeContext = [
        p?.rag?.hits > 0 ? `知识库(RAG)命中: ${p.rag.hits}条结果` : '知识库未命中',
        p?.db?.matched ? `数据库(DB)匹配表: ${p.db.tables.join(',')}` : '数据库未匹配到表'
      ].join('; ')
      const healthContext = (() => {
        const hs = state.toolHealth?.agents || []
        if (!hs.length) return '工具健康状态未知'
        const base = hs.map((x: any) => `${x.agent}:${x.status}(p95=${x.p95Ms}ms)`).join('；')
        const bad = unhealthyAgentsForPrompt(state.toolHealth)
        return bad ? `${base}；${bad}` : base
      })()

      const skipRouteHistoryBias = isRevisionRun || shouldSkipRouteHistoryBias(lastUser, attachment, state.messages as any)
      const decomposeClauses = clausesFromMeta(routeState.meta)
      const multiRouteAdvisory = buildMultiRouteAdvisory(heuristicsText, p, decomposeClauses, lastUser, attachment, routeState.meta)
      const composed = await composeManagerPromptContext({
        stage: 'router',
        policyDir,
        sessionId,
        userId: deps.userId,
        heuristicsText,
        state: routeState,
        suppressCanary: routeStrategy?.suppressCanary,
        skipExperienceReplay: skipRouteHistoryBias || turnIsolated || isRevisionRun,
        skipLongMemoryForRoute: Boolean(attachment?.filePath) || turnIsolated || isRevisionRun,
        routeLastTurnOnly: routeLastUser,
        routeAttachment: attachment ?? null,
        routeMessages: state.messages as any,
        prependBlocks: [
          formatTurnScopeRouterHint(turnScope),
          probeContext,
          formatCapabilityProbeBlock(buildCapabilitySnapshotFromProbe(state.probe)),
          formatGuiDeployHintForRouter(state.toolHealth),
          `Tool Health：${healthContext}`,
          multiRouteAdvisory
        ],
        appendBlocks: [
          routeStrategy?.routerHintBlock || '',
          routeBandit?.routerHintBlock || '',
          routePolicyRl?.routerHintBlock || '',
          routeCausal?.routerHintBlock || '',
          formatWorldModelBlock(worldModel),
          writeGateRouterHint(state)
        ]
      })
      const promptPatches = composed.artifacts.promptPatches
      const taskStackRecall = composed.artifacts.taskStackRecall
      // mergeMeta 只返回 meta 片段，必须写回 state.meta，不能把返回值赋给整个 routeState（否则会丢失 resources，llmInvoke 读 modelLowCost 报错）
      routeState = {
        ...routeState,
        meta: mergeMeta(routeState, composed.metaPatch)
      }
      const experienceReplayCount = Number(composed.metaPatch.experienceReplayCount || 0)
      const experienceReplayNegativeCount = Number(composed.metaPatch.experienceReplayNegativeCount || 0)
      const promptPatchText = composed.blocks.find((b) => b.includes('自进化路由补丁')) || ''
      if (experienceReplayCount > 0 && !routeState.meta?.lowCostMode) {
        const mode = composed.metaPatch.experienceVectorRecall ? '向量+关键词' : '关键词'
        opts.sendEvent({
          event: 'thinking',
          data: `路由：已注入 ${experienceReplayCount} 条历史相似经验作校准（${mode} 经验回放）`,
          from: 'manager'
        })
      }
      if (promptPatchText && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `路由：已应用自进化 Prompt 补丁 v${promptPatches.patches?.version ?? '?'}`,
          from: 'manager'
        })
      }
      if (experienceReplayNegativeCount > 0 && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `路由：已注入 ${experienceReplayNegativeCount} 条历史负样本提示（避雷）`,
          from: 'manager'
        })
      }
      if (taskStackRecall.sharedCount > 0 && !routeState.meta?.lowCostMode) {
        opts.sendEvent({
          event: 'thinking',
          data: `路由：已注入跨会话共享任务栈 ${taskStackRecall.sharedCount} 项（同用户其它会话待办）`,
          from: 'manager'
        })
      }

      const routerPlaybookStatic =
        getRouterPlaybookStatic(ROUTER_PLAYBOOK_FALLBACK) + getAdminCapabilitiesAddon() + getGuiAutomationAddon()

      const prompt = [
        new SystemMessage(
          [
            routerPlaybookStatic,
            `必须只输出严格 JSON，格式与字段名必须与下列示例一致（禁止输出 Zod/_def 等内部结构）：\n${ROUTE_JSON_EXAMPLE}`,
            '不要输出任何前言、解释、Markdown、代码块或额外文本。',
            'intent 只能是 db/rag/code/crawler/gui/admin/clean/visualize/report/multimodal/music/video/multi 之一；禁止输出 single/simple/one 等自创值（单步任务也用 db/rag 等具体 agent 名）。',
            '必须填充 entities 与 query；query 要保留用户原始关键口径，尤其是时间范围。',
            'needsClarify 规则（重要）：仅当「缺少执行所必需且无法从后续检索合理缺省」的最小信息时才置 true（例如：用户明确要求操作某一具体账号/单据但未给出任何标识）。',
            '若用户已点名知识库/文档/制度/手册等为数据源，或 probe 显示知识库已命中：默认 needsClarify=false，优先走 rag 检索；表述多解时也在回答中说明假设，而不是在路由阶段强行澄清。',
            '若 needsClarify=true，则 clarifyQuestions 必须非空。',
            'taskStackOp 由你根据用户语义判断：仅当用户明确要「记入待办/加入任务栈/完成某待办」时填 add/done/delete；若用户要求当场执行且将由 admin 等步骤完成，或拟入栈内容与现有任务栈重复，则 taskStackOp=none。',
            '',
            '### 背景信息：',
            (() => {
              const ic = intentClassifyFromMeta(routeState.meta)
              if (!ic) return ''
              const rag = intentRagRecallFromMeta(routeState.meta)
              return [
                '【意图识别节点预判（高置信时对齐，非关键词规则）】',
                `primaryIntent=${ic.primaryIntent} isMulti=${ic.isMulti} isDbAnchored=${ic.isDbAnchored}`,
                `needsAdmin=${ic.needsAdmin} needsWeb=${ic.needsWeb} planShortcut=${ic.planShortcut}`,
                `suggestedAgents=${JSON.stringify(ic.suggestedAgents)}`,
                `mode=${String((routeState.meta as { intentClassifyMode?: string })?.intentClassifyMode || 'llm')}`,
                rag?.count ? `intentRagRecall=${rag.count}条 top=${rag.topHit?.primaryIntent || '?'}` : '',
                `rationale：${ic.rationale}`
              ]
                .filter(Boolean)
                .join('\n')
            })(),
            (() => {
              if (decomposeClauses.length <= 1) return ''
              const tagged = decomposeClauses
                .map((c, i) => {
                  const agents = c.agents?.length ? ` → ${c.agents.join('+')}` : ''
                  return `${i + 1}. ${c.text}${agents}`
                })
                .join('；')
              return `【LLM 子句参考（勿用关键词表硬套 agent）】${tagged}`
            })(),
            ...composed.blocks
          ]
            .map((x) => String(x ?? '').trim())
            .filter(Boolean)
            .join('\n')
        ),
        new HumanMessage(
          [
            attachment?.filePath
              ? `【附件】已上传：${attachment.filename || 'file'}（${attachment.mediaType}）`
              : '',
            `用户问题：${routeQuestion}`,
            '只输出 JSON，不要输出其他内容：'
          ]
            .filter(Boolean)
            .join('\n')
        )
      ]

      let rText = ''
      let nextResources = routeState.resources
      let nextMeta = routeState.meta
      try {
        const r = await llmInvoke('route', routeState, prompt)
        rText = String(r.text ?? '').trim()
        nextResources = r.resources
        nextMeta = r.meta ?? nextMeta
      } catch (e: any) {
        if (forced) {
          opts.sendEvent({ event: 'thinking', data: `路由：LLM 异常，但已锁定 ${forced} 协同模式，继续按 ${forced} 执行（原因：${e.message}）`, from: 'manager' })
          return {
            intent: forced,
            routedQuery: question,
            entities: normalizeEntities(undefined),
            meta: mergeMeta(routeState, { routeConfidence: 0.5, uncertainty: 'high', needsClarify: false, clarifyQuestions: [] }),
            resources: nextResources
          }
        }
        const fallbackIntent = 'multi'
        opts.sendEvent({ event: 'thinking', data: `路由：LLM 异常，回退为 ${fallbackIntent}（原因：${e.message}）`, from: 'manager' })
        return {
          intent: fallbackIntent,
          routedQuery: appendConstraintsToQuery(question, constraints),
          entities: normalizeEntities(undefined),
          meta: mergeMeta(routeState, { routeConfidence: 0.5, uncertainty: 'high' }),
          resources: nextResources
        }
      }

      const rawText = String(rText || '').trim()
      const parsedJson = safeJsonParse(rText)
      const parsed = parseRouteLlmJson(rawText)
      if (!parsed.success) {
        const rawPreview = summarize(rText, 280)
        const parseReason = !rawText ? '空输出' : parsedJson == null && !String(rawText).includes('"intent"') ? '非 JSON' : 'schema 不匹配'
        opts.sendEvent({
          event: 'thinking',
          data: `路由：${parseReason}，原文片段：${rawPreview || '（空）'}，将回退处理。`,
          from: 'manager'
        })
      }
      if (parsed.success) {
        if (String(rawText).includes('"_def"')) {
          opts.sendEvent({
            event: 'thinking',
            data: '路由：已从模型误输出的 schema 内部结构中恢复 JSON 字段。',
            from: 'manager'
          })
        }
        const v = parsed.data
        if (!forced) {
          const rawQs = Array.isArray(v.clarifyQuestions) ? v.clarifyQuestions : []
          const qs = rawQs.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 4)
          let wantsClarify = Boolean(v.needsClarify) || qs.length > 0
          const ragProbeHits = Number(p?.rag?.hits ?? 0) > 0
          const dbProbeMatched = Boolean(p?.db?.matched)
          const routeSaysRag = String(v.intent || '').trim() === 'rag'
          const routeSaysDb = String(v.intent || '').trim() === 'db'
          let clarifyTh = Number(routingPolicy?.routing?.clarifyThresholdHinted ?? 0.58)
          if (routeStrategy?.clarifyThresholdAdjust) {
            clarifyTh = Math.min(0.78, clarifyTh + routeStrategy.clarifyThresholdAdjust)
          }
          const modelConf = typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? v.confidence : 0
          const clarifyFloor = 0.62 + (routeStrategy?.preferClarifyBoost ?? 0)
          const lowConfThreshold = Number(process.env.MANAGER_ROUTE_LOW_CONF_CLARIFY ?? 0.52)
          if (
            !wantsClarify &&
            modelConf > 0 &&
            Number.isFinite(lowConfThreshold) &&
            lowConfThreshold > 0 &&
            modelConf < lowConfThreshold &&
            !routeSaysRag &&
            !routeSaysDb &&
            !ragProbeHits &&
            !dbProbeMatched &&
            !attachment?.filePath
          ) {
            wantsClarify = true
            opts.sendEvent({
              event: 'thinking',
              data: `路由：置信度 ${modelConf.toFixed(2)} 低于企业阈值 ${lowConfThreshold.toFixed(2)}，先澄清再执行。`,
              from: 'manager'
            })
          }
          if (
            routeStrategy?.preferClarifyBoost &&
            !wantsClarify &&
            modelConf > 0 &&
            modelConf < clarifyFloor &&
            !routeSaysRag &&
            !routeSaysDb &&
            !ragProbeHits &&
            !dbProbeMatched
          ) {
            wantsClarify = true
            opts.sendEvent({
              event: 'thinking',
              data: `策略决策：近期质量/满意度偏低，置信度 ${modelConf.toFixed(2)} 未达 ${clarifyFloor.toFixed(2)}，倾向先澄清。`,
              from: 'manager'
            })
          }
          const skipRouterClarify =
            wantsClarify &&
            (routeSaysRag ||
              routeSaysDb ||
              ragProbeHits ||
              dbProbeMatched ||
              (modelConf >= clarifyTh && (String(v.intent) === 'rag' || String(v.intent) === 'multi' || String(v.intent) === 'db')))
          if (skipRouterClarify) {
            wantsClarify = false
            opts.sendEvent({
              event: 'thinking',
              data: `路由：模型曾建议澄清，但满足「路由 intent=${String(v.intent)} / RAG命中=${ragProbeHits ? '是' : '否'} / DB命中=${dbProbeMatched ? '是' : '否'} / 置信≥策略阈值=${modelConf >= clarifyTh ? '是' : '否'}」之一，改为先检索与编排执行。`,
              from: 'manager'
            })
          }
          if (wantsClarify) {
            const clarifyQuestions =
              qs.length > 0
                ? qs
                : [
                    '你更倾向使用哪类数据源？（**业务数据库**中的表与记录 / **知识库文档**中的制度与手册）',
                    '是否需要限定时间范围、具体对象（人或单据编号），或指定输出形式（表格 / 图表 / 文字结论）？'
                  ]
            opts.sendEvent({
              event: 'thinking',
              data: `路由：需先澄清（${clarifyQuestions.length} 项），已暂停自动规划。`,
              from: 'manager'
            })
            const routedQueryRaw = String(v.query || question).trim() || question
            const routedQuery = appendConstraintsToQuery(routedQueryRaw, constraints)
            return {
              intent: v.intent,
              allowedAgents: finalizeAllowedAgents(
                String(v.intent),
                normalizeLlmAllowedAgents(v.allowedAgents),
                forced
              ),
              routedQuery,
              entities: normalizeEntities(v.entities as any),
              meta: mergeMeta({ ...routeState, meta: nextMeta }, {
                routeConfidence: Math.min(v.confidence, 0.55),
                uncertainty: 'high',
                needsClarify: true,
                clarifyQuestions
              }),
              resources: nextResources
            }
          }
        }

        let llmAllowed = normalizeLlmAllowedAgents(v.allowedAgents)
        const routerLlmAllowed = [...llmAllowed]
        let intent = finalizeLlmRouteIntent(String(v.intent), llmAllowed, forced)
        llmAllowed = finalizeLlmAllowedAgents(intent, llmAllowed, forced)

        if (!llmAllowed.length) {
          const inferred = inferAllowedAgentsFromProbe({
            intent: String(v.intent),
            probe: p,
            clauseAgents: agentsFromClauses(clausesFromMeta(state.meta))
          })
          if (inferred.length) {
            llmAllowed = inferred
            intent = finalizeLlmRouteIntent(intent, llmAllowed, forced)
            llmAllowed = finalizeLlmAllowedAgents(intent, llmAllowed, forced)
            opts.sendEvent({
              event: 'thinking',
              data: `路由：allowedAgents 为空，已按 probe/子句补全 → ${llmAllowed.join(' → ')}`,
              from: 'manager'
            })
          }
        }

        if (!forced) {
          let dbOnlyRoute = false
          let ragOnlyRoute = false
          const routeIc = intentClassifyFromMeta(routeState.meta)
          const dbCoalesce =
            shouldBlockDbOnlyCoalesce(routeIc) ?
              null
            : coalesceSimpleDbRoute({
                intent,
                question,
                userMessage: routeQuestion,
                routedQuery: String(v.query || question).trim(),
                allowedAgents: llmAllowed,
                routerLlmAllowed,
                constraints,
                probe: p,
                sessionId,
                intentClassify: routeIc,
                meta: routeState.meta
              })
          if (dbCoalesce) {
            intent = dbCoalesce.intent
            llmAllowed = [...dbCoalesce.allowedAgents]
            dbOnlyRoute = true
            opts.sendEvent({
              event: 'thinking',
              data: '路由：纯查库问句，收敛为 db（跳过 multi / rag / report 扩写）',
              from: 'manager'
            })
          } else {
            const ragCoalesce = coalesceSimpleRagRoute({
              intent,
              question,
              userMessage: routeQuestion,
              routedQuery: String(v.query || question).trim(),
              allowedAgents: llmAllowed,
              routerLlmAllowed,
              constraints,
              probe: p,
              sessionId,
              intentClassify: intentClassifyFromMeta(routeState.meta),
              meta: routeState.meta
            })
            if (ragCoalesce) {
              intent = ragCoalesce.intent
              llmAllowed = [...ragCoalesce.allowedAgents]
              ragOnlyRoute = true
              opts.sendEvent({
                event: 'thinking',
                data: '路由：纯知识库问句，收敛为 rag（跳过 multi / clean / code / report 扩写）',
                from: 'manager'
              })
            }
          }
          routeState = { ...routeState, meta: mergeMeta(routeState, { dbOnlyRoute, ragOnlyRoute }) }
        }

        const routeThinkingConfidence = v.confidence
        const routedQueryRaw = String(v.query || question).trim() || question
        const routedQuery = appendConstraintsToQuery(routedQueryRaw, constraints)
        const entities = normalizeEntities(v.entities as any)

        if (sessionId && v.taskStackOp && v.taskStackOp !== 'none') {
          const tsOp = await applyRouterTaskStackOp(policyDir, sessionId, v.taskStackOp, v.taskStackTitle).catch(
            () => null
          )
          if (tsOp?.applied) {
            opts.sendEvent({
              event: 'thinking',
              data: `路由模型入栈（${tsOp.action}）：${tsOp.title || ''}`,
              from: 'manager'
            })
            opts.sendEvent({ event: 'task_stack', data: { stack: tsOp.stack }, from: 'manager' })
          }
        }

        let allowedAgents = finalizeAllowedAgents(intent, llmAllowed, forced)
        const dbOnlyRoute = Boolean((routeState.meta as { dbOnlyRoute?: boolean } | undefined)?.dbOnlyRoute)
        const ragOnlyRoute = Boolean((routeState.meta as { ragOnlyRoute?: boolean } | undefined)?.ragOnlyRoute)
        const routeClauses = clausesFromMeta(state.meta)
        const intentIcRaw = intentClassifyFromMeta(routeState.meta)
        const intentIc = intentIcRaw ? reconcileIntentClassifyDataPlane(intentIcRaw) : null
        const routeAdjustments: string[] = []
        const beforeAlign = [...allowedAgents]
        allowedAgents = alignAllowedAgentsWithUnderstanding({
          routerAllowed: allowedAgents,
          intentClassify: intentIc,
          clauses: routeClauses,
          constraints,
          dbOnlyRoute,
          ragOnlyRoute,
          userText: routeQuestion
        })
        const alignDelta = describeAllowedAgentDelta(beforeAlign, allowedAgents)
        if (alignDelta) noteRouteAdjustment(routeAdjustments, `理解对齐 ${alignDelta}`)

        let compositeDataWebRoute = false
        let compositeWebExecution: 'serp_summary' | 'crawl' | 'none' = 'none'
        let llmNeedsWebSearchFlag = v.needsWebSearch === true
        let compositeGuardNote = ''
        if (!dbOnlyRoute && !ragOnlyRoute && routeQuestion) {
          const compositeGuard = await resolveCompositeRouteGuardByLlm({
            userText: routeQuestion,
            routeIntent: intent,
            allowedAgents,
            intentClassify: intentClassifyFromMeta(routeState.meta),
            llmInvoke,
            state: routeState
          })
          if (compositeGuard?.isCompositeDataWeb) {
            const appliedComposite = applyCompositeRouteGuard({
              intent,
              allowedAgents,
              llmNeedsWebSearch: llmNeedsWebSearchFlag,
              guard: compositeGuard,
              intentClassify: intentIc
            })
            if (appliedComposite.compositeDataWebRoute) {
              compositeDataWebRoute = true
              compositeWebExecution = appliedComposite.webExecution
              llmNeedsWebSearchFlag = appliedComposite.llmNeedsWebSearch
              compositeGuardNote = compositeGuard.rationale
              const beforeComposite = [...allowedAgents]
              intent = appliedComposite.intent
              allowedAgents = appliedComposite.allowedAgents as typeof allowedAgents
              const compositeDelta = describeAllowedAgentDelta(beforeComposite, allowedAgents)
              noteRouteAdjustment(
                routeAdjustments,
                `复合路由（库内+公网 web=${compositeWebExecution}）${compositeDelta || ''} ${compositeGuard.rationale.slice(0, 48)}`.trim()
              )
            }
          }
        }

        let webExecutionMode: import('../../utils/search/managerWebExecutionModeLlm').WebExecutionModeDecision | null = null
        if (compositeDataWebRoute) {
          // pipelineRequired 只表示还要跑 db/clean/report，不得绑架公网腿必须深抓
          webExecutionMode =
            webExecutionModeFromCompositeGuard(compositeWebExecution, compositeGuardNote) ||
            webExecutionModeFromCompositeGuard('serp_summary', compositeGuardNote || '库内取数 + 公网参考摘要')
        } else if (!dbOnlyRoute && !ragOnlyRoute && routeQuestion) {
          const beforeWeb = [...allowedAgents]
          const webSup = await supplementAllowedFromWebStructuralAsync(allowedAgents, routeQuestion, {
            llmInvoke,
            state: routeState,
            routeIntent: intent,
            llmNeedsWebSearch: v.needsWebSearch === true,
            toolHealth: state.toolHealth,
            openaiApiKey: (opts as { openaiApiKey?: string }).openaiApiKey,
            openaiModel: (opts as { openaiModel?: string }).openaiModel,
            openaiBaseUrl: (opts as { openaiBaseUrl?: string }).openaiBaseUrl
          })
          allowedAgents = webSup.allowedAgents
          webExecutionMode = webSup.webExecutionMode
          const webDelta = describeAllowedAgentDelta(beforeWeb, allowedAgents)
          if (webDelta) {
            const modeHint = webExecutionMode?.mode ? ` mode=${webExecutionMode.mode}` : ''
            noteRouteAdjustment(routeAdjustments, `网页执行模式${modeHint} ${webDelta}`)
          }
        }
        const guiRoute = applyGuiRouteOverrides({
          intent,
          allowedAgents,
          llmNeedsWebSearch: llmNeedsWebSearchFlag,
          webExecutionMode,
          compositeDataWebRoute
        })
        if (guiRoute.intent !== intent || guiRoute.llmNeedsWebSearch !== llmNeedsWebSearchFlag) {
          const modeLabel = webExecutionMode?.mode ?? 'gui'
          noteRouteAdjustment(routeAdjustments, `网页路由 ${intent}→${guiRoute.intent}（${modeLabel}）`)
        }
        intent = guiRoute.intent
        allowedAgents = guiRoute.allowedAgents
        const routerNeedsWebSearch = guiRoute.llmNeedsWebSearch

        let guiOperateKind: import('../../../utils/gui/guiOperateKindLlm').GuiOperateKindDecision | null = null
        if (
          !compositeDataWebRoute &&
          (webExecutionMode?.mode === 'gui' || intent === 'gui' || allowedAgents.includes('gui'))
        ) {
          try {
            const { resolveGuiOperateKindByLlm } = await import('../../../utils/gui/guiOperateKindLlm')
            guiOperateKind = await resolveGuiOperateKindByLlm({
              userText: routeQuestion || question,
              llmInvoke,
              state: routeState,
              llm: {
                openaiApiKey: (opts as { openaiApiKey?: string }).openaiApiKey,
                openaiModel: (opts as { openaiModel?: string }).openaiModel,
                openaiBaseUrl: (opts as { openaiBaseUrl?: string }).openaiBaseUrl,
              },
            })
            if (guiOperateKind) {
              noteRouteAdjustment(
                routeAdjustments,
                `GUI 操作类型 ${guiOperateKind.task_kind}${guiOperateKind.needs_login ? '+login' : ''}`,
              )
            }
          } catch {
            guiOperateKind = null
          }
        }
        const clauseAgents = agentsFromClauses(routeClauses)
        const beforeAdminStrip = [...allowedAgents]
        allowedAgents = stripAdminIfNotInCurrentTurn(
          allowedAgents,
          routeQuestion,
          intentClassifyFromMeta(routeState.meta),
          {
            routerLlmAllowed,
            clauseAgents
          }
        )
        if (beforeAdminStrip.includes('admin') && !allowedAgents.includes('admin')) {
          noteRouteAdjustment(routeAdjustments, '移除 admin（本轮无办公诉求）')
        }
        if (intent === 'multi' && allowedAgents.length && !dbOnlyRoute && !ragOnlyRoute) {
          const standalone =
            allowedAgents.length === 1 && ['music', 'video', 'multimodal'].includes(allowedAgents[0]!)
              ? (allowedAgents[0] as 'music' | 'video' | 'multimodal')
              : null
          const beforeReconcile = [...allowedAgents]
          const reconciled = reconcileRouteAllowedAgents(allowedAgents, routeClauses, { standaloneMedia: standalone })
          const reconcileDelta = describeAllowedAgentDelta(beforeReconcile, reconciled as ExecutableAgent[])
          if (reconcileDelta) noteRouteAdjustment(routeAdjustments, `cap 拓扑 ${reconcileDelta}`)
          allowedAgents = reconciled as typeof allowedAgents
        }
        const beforeWriteGate = [...allowedAgents]
        allowedAgents = filterAgentsRespectingWriteGate(allowedAgents, state) as typeof allowedAgents
        if (beforeWriteGate.includes('admin') && !allowedAgents.includes('admin')) {
          opts.sendEvent({
            event: 'thinking',
            data: '写操作闸门：admin 已暂禁（需用户确认后执行日程/邮件等写操作）。',
            from: 'manager'
          })
        }
        if (llmAllowed.length) {
          const removed = llmAllowed.filter((a) => !allowedAgents.includes(a))
          if (removed.length) noteRouteAdjustment(routeAdjustments, `剔除 ${removed.join('、')}`)
          if (!routeState.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: formatRouteOrchestrationSummary({ cap: allowedAgents, adjustments: routeAdjustments }),
              from: 'manager'
            })
            if (isOrchVerbose()) {
              opts.sendEvent({
                event: 'thinking',
                data: `路由模型原始：${llmAllowed.join('、')}｜intent=${intent} conf=${Number(v.confidence).toFixed(2)}`,
                from: 'manager'
              })
            }
          }
        }

        const web = await resolveNeedsWebSearchAsync({
          llmNeedsWebSearch: routerNeedsWebSearch,
          intent,
          allowedAgents,
          userText: routeQuestion,
          llmInvoke,
          llm: {
            openaiApiKey: (opts as { openaiApiKey?: string }).openaiApiKey,
            openaiModel: (opts as { openaiModel?: string }).openaiModel,
            openaiBaseUrl: (opts as { openaiBaseUrl?: string }).openaiBaseUrl
          },
          state: { ...routeState, meta: nextMeta }
        })
        const needsWebSearch = web.needsWebSearch

        if (needsWebSearch && !routeState.meta?.lowCostMode) {
          opts.sendEvent({
            event: 'thinking',
            data:
              web.reason === 'media_reference_heuristic'
                ? '路由：媒体任务含「参考/流行风格」等表述，启用联网检索（SERP）后再生成'
                : '路由：判定需要联网搜索（SERP）',
            from: 'manager'
          })
        }

        const extAvail = reconcileExtendedAgentAvailability(intent, allowedAgents, state.toolHealth)
        const guiModeLocked = webExecutionMode?.mode === 'gui' || intent === 'gui'
        if (guiModeLocked && extAvail.blocked.includes('gui')) {
          opts.sendEvent({
            event: 'thinking',
            data: `路由：任务需 GUI 浏览器，但 Lobster/gui 不可用（${extAvail.blocked.join('、')}）；请启动 extended profile 后重试。`,
            from: 'manager'
          })
          return {
            intent: 'gui',
            allowedAgents: ['gui'],
            routedQuery,
            entities,
            meta: mergeMeta({ ...routeState, meta: nextMeta }, {
              routeConfidence: Math.min(routeThinkingConfidence, 0.4),
              uncertainty: 'high',
              needsClarify: true,
              clarifyQuestions: extAvail.clarifyQuestions.length
                ? extAvail.clarifyQuestions
                : ['GUI 浏览器 Agent（Lobster）未启动或不可达，无法完成「打开/搜索/点击/提取」类任务。请启用 docker compose --profile extended 并确认 lobster_agent 健康。'],
              extendedAgentsUnavailable: extAvail.blocked,
              webExecutionMode
            }),
            resources: nextResources
          }
        }
        if (extAvail.degradeHint && !guiModeLocked) {
          opts.sendEvent({ event: 'thinking', data: extAvail.degradeHint, from: 'manager' })
          allowedAgents = allowedAgents.filter((a) => !extAvail.blocked.includes(a as any)) as typeof allowedAgents
        } else if (extAvail.clarifyQuestions.length) {
          opts.sendEvent({
            event: 'thinking',
            data: `路由：extended 能力不可用（${extAvail.blocked.join('、')}），需先澄清或启用 extended 部署。`,
            from: 'manager'
          })
          return {
            intent,
            allowedAgents,
            routedQuery,
            entities,
            meta: mergeMeta({ ...routeState, meta: nextMeta }, {
              routeConfidence: Math.min(routeThinkingConfidence, 0.45),
              uncertainty: 'high',
              needsClarify: true,
              clarifyQuestions: extAvail.clarifyQuestions,
              extendedAgentsUnavailable: extAvail.blocked
            }),
            resources: nextResources
          }
        }

        emitRouteUi({
          intent,
          allowedAgents,
          routedQuery,
          rationale: String(v.rationale || ''),
          needsWebSearch
        })

        if (!routeState.meta?.lowCostMode) {
          if (forced) {
            opts.sendEvent({
              event: 'thinking',
              data: `协作模式：已锁定 ${forced}（LLM 原始建议: ${v.intent}）`,
              from: 'manager'
            })
          } else {
            opts.sendEvent({
              event: 'thinking',
              data: formatRouteDecisionThinking({
                intent,
                confidence: routeThinkingConfidence,
                allowedAgents,
                adjustments: routeAdjustments,
                needsWebSearch,
                webMode: webExecutionMode?.mode,
                rationale: String(v.rationale || ''),
                userTask: routeQuestion
              }),
              from: 'manager'
            })
          }
        }

        allowedAgents = alignAllowedAgentsWithDataPlane(allowedAgents, intentIc, routerLlmAllowed)
        allowedAgents = stripDbUnlessDbAnchored(allowedAgents, intentIc)
        const pipelineRequired = requiresAgentPipelineExecution(intentIc, allowedAgents)
        intent = ensureMultiIntentForPipeline(intent, allowedAgents, pipelineRequired)
        if (pipelineRequired && !state?.meta?.lowCostMode) {
          opts.sendEvent({
            event: 'thinking',
            data: '路由编排：复合流水线任务，禁止聊天式联网直答（须 planner + 子 Agent）',
            from: 'manager'
          })
        }

        return {
          intent,
          allowedAgents,
          routedQuery,
          entities,
          meta: mergeMeta({ ...routeState, meta: nextMeta }, {
            routeConfidence: routeThinkingConfidence,
            uncertainty: uncertaintyFromConfidence(routeThinkingConfidence),
            needsClarify: false,
            clarifyQuestions: [],
            needsWebSearch,
            webSearchReason: web.reason,
            taskConstraints: constraints,
            dbOnlyRoute,
            compositeDataWebRoute,
            ...(compositeWebExecution !== 'none' ? { compositeWebExecution } : {}),
            ...(intentIc ? { intentClassify: intentIc } : {}),
            ...(webExecutionMode ? { webExecutionMode } : {}),
            ...(guiOperateKind ? { guiOperateKind } : {}),
            ...(isManagerChatWebEnabled() &&
            isChatWebMode(webExecutionMode) &&
            !pipelineRequired &&
            intentIc?.allowChatWebDirect !== false ?
              { chatWebOnly: true }
            : {}),
            ...(pipelineRequired ?
              { requiresAgentPipeline: true, allowChatWebDirect: false, chatWebOnly: false }
            : {}),
            ...(intent === 'gui' || allowedAgents.includes('gui') ? { allowGui: true } : {}),
            ...(attachment?.filePath ? { turnScope: 'current_only' as const, standaloneMediaRoute: intent === 'multimodal' ? 'multimodal' as const : undefined } : {}),
            turnScopeMode: turnScope.mode,
            ...(turnScope.mode === 'topic_shift' ? { turnTopicShift: true, sessionIntentAnchor: null } : {})
          }),
          resources: nextResources
        }
      }
      if (forced) {
        opts.sendEvent({ event: 'thinking', data: `路由：解析结果无效，但已锁定 ${forced} 协同模式，继续按 ${forced} 执行。`, from: 'manager' })
        return {
          intent: forced,
          allowedAgents: deriveAllowedAgentsFromRoute(String(forced), []),
          routedQuery: question,
          entities: normalizeEntities(undefined),
          meta: mergeMeta(routeState, { routeConfidence: 0.5, uncertainty: 'high', needsClarify: false, clarifyQuestions: [] }),
          resources: nextResources
        }
      }
      const fallbackIntent = 'multi'
      opts.sendEvent({
        event: 'thinking',
        data: '路由：LLM 输出无法解析，回退到 multi；请用户简化表述或重试。',
        from: 'manager'
      })
      return {
        intent: fallbackIntent,
        allowedAgents: deriveAllowedAgentsFromRoute(String(fallbackIntent), []),
        routedQuery: appendConstraintsToQuery(question, constraints),
        entities: normalizeEntities(undefined),
        meta: mergeMeta(routeState, { routeConfidence: 0.5, uncertainty: 'high' }),
        resources: nextResources
      }
}
