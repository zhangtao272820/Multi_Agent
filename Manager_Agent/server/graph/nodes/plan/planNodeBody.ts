import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { buildAgentScopedQuery, clausesFromMeta, isClauseDecomposeEnabled, agentsFromClauses } from '../../core/routing/clauses'
import { stepDispatchDraftFromMeta } from '../../core/proPuStack'
import { composeManagerPromptContext } from '../../core/plan/contextComposer'
import { extractAdminSubtaskText, sanitizePlanSteps } from '../../core/stepIsolation'
import {
  applyRoutePlanCoverage,
  finalizePlanForExecution,
  normalizePlanSteps,
  reconcilePlanWithRoute
} from '../../core/plan'
import { validateAndPreparePlan } from '../../core/plan/planValidate'
import {
  mergePlanWithClauseMaterialization
} from '../../core/routing/clausePlanBinding'
import { resolvePipelineHints, pipelineHintsFromMeta } from '../../llm/pipelineHintsLlm'
import { applyMediaPlanTopology, resolveMediaPlanTopology } from '../../llm/mediaPlanLlm'
import {
  effectiveUserTask,
  preferCurrentTurnScope,
  routingHeuristicsUserText
} from '../../core/text'
import { unhealthyAgentsForPrompt } from '../../core/agent/agentRegistry'
import type { Step } from '../../../utils/shared/taskPlan'
import { parsePlanLlmJson, PLAN_JSON_EXAMPLE } from '../../core/shared/llmJson'
import { PLANNER_INTRO, getPlannerPlaybookRules, getAgentScopedPlaybookAddons } from '../../core/evolution/playbookPrompts'
import { clipSkillBlock } from '../../core/shared/promptBudget'
import { isAdminBlockedForState } from '../../core/db/writeGate'
import { resolveTaskConstraints, taskConstraintsFromMeta } from '../../llm/taskConstraintsLlm'
import { intentClassifyFromMeta } from '../../llm/intentClassifyLlm'
import {
  blueprintCoversRequiredAgents,
  formatPlanBlueprintForPrompt,
  isPlanBlueprintMaterializeEnabled,
  materializeStepsFromBlueprint,
  planBlueprintFromMeta,
  resolvePlanBlueprintByLlm
} from '../../llm/planBlueprintLlm'
import { shouldMaterializePlanFromBlueprint } from '../../core/routing/proRoutePolicy'
import { repairMissingPlanStepsByLlm } from '../../llm/planRepairLlm'
import { formatWebExecutionModeForPrompt, webExecutionModeFromMeta } from '../../llm/webTaskStructuralLlm'
import {
  formatPlanOrchestrationSummary,
  isOrchVerbose,
  notePlanInternalFix
} from '../../orchestrate/orchestrationNarrative'
import { emitPlanDagEvent } from '../../core/routing/routeStepsEvent'
import { emitPlanStepsEvent } from '../../core/plan/planStepsEvent'
import { coerceConstraintsForSimpleDbQuery, coerceConstraintsForSimpleRagQuery } from '../../../utils/db/managerDbSchemaHintsPolicy'
import { ensureDbProbeHintsForPlan } from '../../../utils/db/managerDbHintsLlm'
import { probeAdminAgentReadiness, isAdminReadinessProbeEnabled } from '../../../utils/admin/managerAdminReadinessProbe'
import { buildAgentRegistry } from '../../core/agent/agentRegistry'
import { agentWsUrlToHttpOrigin } from '../../../utils/platform/agentEndpoints'
import { enrichTaskPlanWithDbPlan } from '../../core/db/dbPrefetch'
import { resolveDbPrefetchQuestionFromState, resolveDbStepQuestionSync } from '../../core/db/dbStepQuestion'
import { buildDbChartShortcutPlan, buildAdminOnlyShortcutPlan, buildDbOnlyShortcutPlan, buildRagOnlyShortcutPlan, shouldUseAdminOnlyShortcut, shouldUseDbChartShortcut, shouldUseDbOnlyShortcut, shouldUseRagOnlyShortcut } from '../../core/plan/planShortcuts'
import { shouldSkipLegacyPlanShortcuts, shouldSkipPlanRuleFallback } from '../../orchestrate/unifiedRouting'
import type { TaskConstraints } from '../../core/plan'
import { PLANNER_RULES_FALLBACK, stripAdminStepsIfBlocked } from './helpers'
import type { CreatePlanNodeDeps } from './types'
import type { CreatePlanNodeDeps } from './types'
import type { createPlanQueryHelpers } from './planQueryHelpers'


export async function runPlanNodeBody(state: any, deps: any, helpers: any) {
  const {
    ensureNotAborted,
    opts,
    lastUserText,
    enforcePlanConstraints,
    buildTaskPlan,
    appendMemory,
    needsDataFoundation,
    fetchDbTaskPlan,
    mergeTaskPlan,
    llmInvoke,
    PlanSchema,
    safeJsonParse,
    enforcePlanCoverage,
    getPlanQualityHint,
    recordPlanOutcome,
    runId
  } = deps
  const { publishPlanUi, planHeuristicsFor, plannerQueryForAgent, formatBlueprintStepQuery } = helpers
        ensureNotAborted()
        opts.sendEvent({ event: 'phase', data: 'planner', from: 'manager' })
        const question = effectiveUserTask(state.messages as any, state.routedQuery)
        const lastMsg = lastUserText(state.messages)
        const planHeuristicsText = planHeuristicsFor(state)
        const dbPlanQuestion = (full: string) =>
          resolveDbPrefetchQuestionFromState(state, lastMsg, String(full || question).trim())
        const fetchDbPlanWithScope = async (full: string) => {
          const scopedQ = dbPlanQuestion(full)
          return fetchDbTaskPlan({
            dbAgentHttpUrl: opts.dbAgentHttpUrl!,
            question: scopedQ,
            timeoutMs: Math.min(8_000, opts.timeoutMs),
            dbId: opts.dbId,
            traceId: runId
          })
        }
        const clauses = clausesFromMeta(state.meta)
        const clauseAgents = agentsFromClauses(clauses)
        const constraints = coerceConstraintsForSimpleRagQuery(
          coerceConstraintsForSimpleDbQuery(
            taskConstraintsFromMeta(state.meta) ?? (await resolveTaskConstraints(question, llmInvoke, state)),
            lastMsg,
            { intentClassify: intentClassifyFromMeta(state.meta), intent: String(state.intent || '') }
          ),
          lastMsg,
          { intentClassify: intentClassifyFromMeta(state.meta), intent: String(state.intent || '') }
        )
        const allowedForDb = (Array.isArray(state.allowedAgents) ? state.allowedAgents : [])
          .map((a: any) => String(a ?? '').trim())
          .filter(Boolean)
        const willUseDb =
          state.intent === 'db' || (state.intent === 'multi' && allowedForDb.includes('db'))
        const dbProbeQuestion = resolveDbPrefetchQuestionFromState(
          state,
          lastMsg,
          String(state.routedQuery || planHeuristicsText || question).trim()
        )
        const dbProbeHints = await ensureDbProbeHintsForPlan({
          state,
          question: dbProbeQuestion,
          llmInvoke,
          willUseDb
        })
        const allowedForAdmin = (Array.isArray(state.allowedAgents) ? state.allowedAgents : [])
          .map((a: unknown) => String(a ?? '').trim())
          .includes('admin')
        let adminReadiness: Awaited<ReturnType<typeof probeAdminAgentReadiness>> | undefined
        if (isAdminReadinessProbeEnabled() && allowedForAdmin) {
          const adminEntry = buildAgentRegistry().entries.find((e) => e.id === 'admin')
          const adminHttp =
            adminEntry?.httpBase ||
            (adminEntry?.wsUrl ? agentWsUrlToHttpOrigin(adminEntry.wsUrl) : '')
          if (adminHttp) {
            adminReadiness = await probeAdminAgentReadiness(adminHttp, opts.timeoutMs)
            if (!state?.meta?.lowCostMode && adminReadiness.weatherConfigured === false) {
              opts.sendEvent({
                event: 'thinking',
                data: 'Admin 天气 API 未配置（checks.weather），天气类子任务可能失败',
                from: 'manager'
              })
            }
          }
        }
        const attachPlanMeta = (meta: any, patch: Record<string, unknown> = {}) => ({
          ...(meta || {}),
          dbProbeHints,
          ...(adminReadiness ? { adminReadinessProbe: adminReadiness } : {}),
          ...patch
        })
        if (!state?.meta?.lowCostMode && dbProbeHints.hintTables.length) {
          opts.sendEvent({
            event: 'thinking',
            data: `DB 选表启发：${dbProbeHints.hintTables.join('、')}${dbProbeHints.rationale ? `（${dbProbeHints.rationale.slice(0, 72)}）` : ''}`,
            from: 'manager'
          })
        }
        const sanitizePlanOpts = {
          llmInvoke,
          state,
          userTask: question,
          lowCostMode: Boolean(state.meta?.lowCostMode)
        }
        const sanitizePlan = async (plan: Step[]) => sanitizePlanSteps(plan, sanitizePlanOpts)

        const p = state.probe
        const probeContext = [
          p?.rag?.hits > 0 ? `RAG命中: ${p.rag.hits}条结果` : 'RAG未命中',
          // 不下发具体表名，避免 Planner 把 top-N 表写进步骤（选表交 DB 自举）
          p?.db?.matched || p?.db?.routingRelevant ? 'DB探测：有业务表命中' : 'DB未匹配到表'
        ].join('; ')
        const dbPrefetchHint =
          String(state.meta?.dbPrefetchPlannerHint || '').trim() ||
          (() => {
            const cached = state.meta?.dbPlanPrefetch as { ok?: boolean; ms?: number } | undefined
            if (cached?.ok) return `DB plan 预取已完成（${cached.ms ?? '?'}ms，供 entities/查数规划参考）`
            return ''
          })()
        const ragPrefetchHint = String(state.meta?.ragPrefetchPlannerHint || '').trim()
        const prefetchContext = [dbPrefetchHint, ragPrefetchHint].filter(Boolean).join('\n')
        const healthContext = (() => {
          const hs = state.toolHealth?.agents || []
          if (!hs.length) return '工具健康状态未知'
          const base = hs.map((x: any) => `${x.agent}:${x.status}(avg=${x.avgMs}ms,p95=${x.p95Ms}ms)`).join('；')
          const bad = unhealthyAgentsForPrompt(state.toolHealth)
          return bad ? `${base}；${bad}` : base
        })()

        let routeIntent = state.intent
        const allowedOnly = (Array.isArray(state.allowedAgents) ? state.allowedAgents : [])
          .map((a: any) => String(a ?? '').trim())
          .filter(Boolean) as Step['agent'][]

        const skipLegacyShortcuts = shouldSkipLegacyPlanShortcuts(state)

        if (
          !skipLegacyShortcuts &&
          shouldUseDbChartShortcut({
            intent: String(state.intent || ''),
            question,
            routedQuery: String(state.routedQuery || ''),
            allowedAgents: allowedOnly,
            constraints,
            probe: state.probe,
            sessionId: deps.sessionId,
            intentClassify: intentClassifyFromMeta(state.meta),
            meta: state.meta
          })
        ) {
          const shortcutPlan = normalizePlanSteps(
            enforcePlanConstraints(buildDbChartShortcutPlan({
              intent: String(state.intent || ''),
              question,
              routedQuery: String(state.routedQuery || ''),
              constraints
            }), constraints)
          )
          if (!state?.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: `快捷计划（查完就画）：${shortcutPlan.map((s: Step) => s.agent).join(' → ')}`,
              from: 'manager'
            })
          }
          const gatedShortcut = await sanitizePlan(stripAdminStepsIfBlocked(shortcutPlan, state))
          await appendMemory({
            type: 'plan_shortcut',
            user: lastUserText(state.messages),
            intent: state.intent,
            routedQuery: state.routedQuery || '',
            plan: gatedShortcut,
            source: 'rule'
          })
          await recordPlanOutcome?.({
            user: lastUserText(state.messages),
            intent: state.intent,
            plan: gatedShortcut,
            source: 'rule',
            runId
          })
          return {
            plan: gatedShortcut,
            taskPlan: buildTaskPlan(state, gatedShortcut),
            resources: state.resources,
            meta: attachPlanMeta(state.meta, { dbChartShortcut: true })
          }
        }

        const shortcutBase = {
          intent: String(state.intent || ''),
          question,
          userMessage: lastMsg,
          routedQuery: String(state.routedQuery || ''),
          allowedAgents: allowedOnly,
          constraints,
          probe: state.probe,
          sessionId: deps.sessionId,
          intentClassify: intentClassifyFromMeta(state.meta),
          meta: state.meta
        }

        if (!skipLegacyShortcuts && shouldUseDbOnlyShortcut(shortcutBase)) {
          const shortcutPlan = normalizePlanSteps(
            enforcePlanConstraints(buildDbOnlyShortcutPlan(shortcutBase), constraints)
          )
          opts.sendEvent({
            event: 'thinking',
            data: `快捷计划（纯查库）：${shortcutPlan.map((s: Step) => s.agent).join(' → ')}`,
            from: 'manager'
          })
          const gated = await sanitizePlan(stripAdminStepsIfBlocked(shortcutPlan, state))
          await appendMemory({
            type: 'plan_shortcut',
            user: lastUserText(state.messages),
            intent: state.intent,
            routedQuery: state.routedQuery || '',
            plan: gated,
            source: 'rule'
          })
          await recordPlanOutcome?.({
            user: lastUserText(state.messages),
            intent: state.intent,
            plan: gated,
            source: 'rule',
            runId
          })
          return {
            plan: gated,
            taskPlan: buildTaskPlan(state, gated),
            resources: state.resources,
            meta: attachPlanMeta(state.meta, { dbOnlyShortcut: true })
          }
        }

        if (!skipLegacyShortcuts && shouldUseRagOnlyShortcut(shortcutBase)) {
          const shortcutPlan = normalizePlanSteps(
            enforcePlanConstraints(buildRagOnlyShortcutPlan(shortcutBase), constraints)
          )
          opts.sendEvent({
            event: 'thinking',
            data: `快捷计划（纯知识库）：${shortcutPlan.map((s: Step) => s.agent).join(' → ')}`,
            from: 'manager'
          })
          const gated = await sanitizePlan(stripAdminStepsIfBlocked(shortcutPlan, state))
          return {
            plan: gated,
            taskPlan: buildTaskPlan(state, gated),
            resources: state.resources,
            meta: attachPlanMeta(state.meta, { ragOnlyShortcut: true })
          }
        }

        if (!skipLegacyShortcuts && shouldUseAdminOnlyShortcut(shortcutBase) && !isAdminBlockedForState(state)) {
          const shortcutPlan = normalizePlanSteps(
            enforcePlanConstraints(buildAdminOnlyShortcutPlan(shortcutBase), constraints)
          )
          opts.sendEvent({
            event: 'thinking',
            data: `快捷计划（办公事务）：${shortcutPlan.map((s: Step) => s.agent).join(' → ')}`,
            from: 'manager'
          })
          const gated = await sanitizePlan(stripAdminStepsIfBlocked(shortcutPlan, state))
          return {
            plan: gated,
            taskPlan: buildTaskPlan(state, gated),
            resources: state.resources,
            meta: attachPlanMeta(state.meta, { adminOnlyShortcut: true })
          }
        }

        if (
          !skipLegacyShortcuts &&
          state.intent !== 'multi' &&
          (
            routeIntent === 'rag' ||
            routeIntent === 'db' ||
            routeIntent === 'code' ||
            routeIntent === 'crawler' ||
            routeIntent === 'gui' ||
            (routeIntent === 'admin' && !isAdminBlockedForState(state)) ||
            routeIntent === 'clean' ||
            routeIntent === 'visualize' ||
            routeIntent === 'report' ||
            routeIntent === 'multimodal' ||
            routeIntent === 'music' ||
            routeIntent === 'video'
          )
        ) {
          const agent = routeIntent as Step['agent']
          const q = plannerQueryForAgent(agent, planHeuristicsText, state)
          const singleQuery =
            routeIntent === 'db'
              ? `从数据库查询：${q}`
              : routeIntent === 'rag'
                ? `从知识库/文档检索相关事实（仅针对下列要点，勿将多轮对话中无关上文当作检索目标）：${q}`
                : routeIntent === 'gui'
                  ? `在浏览器中完成用户指定的页面交互与信息抽取：${q}`
                  : routeIntent === 'crawler'
                    ? `从公开网页采集与任务相关的事实信息：${q}`
                    : q
          const singlePlan = normalizePlanSteps(
            enforcePlanConstraints(
              [
                {
                  id: `step_${routeIntent}`,
                  agent: routeIntent,
                  query: singleQuery
                }
              ],
              constraints
            )
          )
          if (!state?.meta?.lowCostMode) {
            opts.sendEvent({ event: 'thinking', data: `计划：${singlePlan.map((s: any) => s.agent).join(' → ')}`, from: 'manager' })
          }
          const taskPlan = buildTaskPlan(state, singlePlan)
          await appendMemory({
            type: 'plan_llm',
            user: lastUserText(state.messages),
            intent: state.intent,
            routedQuery: state.routedQuery || '',
            plan: singlePlan,
            source: 'single',
            clauseCount: clauses.length
          })
          await recordPlanOutcome?.({
            user: lastUserText(state.messages),
            intent: state.intent,
            plan: singlePlan,
            source: 'single',
            runId
          })
          const gatedSingle = await sanitizePlan(stripAdminStepsIfBlocked(singlePlan, state))
          publishPlanUi(gatedSingle)
          return { plan: gatedSingle, taskPlan: buildTaskPlan(state, gatedSingle), resources: state.resources, meta: attachPlanMeta(state.meta) }
        }

        const planTaskText = planHeuristicsFor(state)
        const rawAllowed = (Array.isArray(state.allowedAgents) ? state.allowedAgents : [])
          .map((a: any) => String(a ?? '').trim())
          .filter(Boolean) as Step['agent'][]
        const expandedAllowed = rawAllowed
        const requiredAgents = new Set<string>(expandedAllowed)
        const adminAllowed = !isAdminBlockedForState(state)
        const finalRequiredAgents = adminAllowed ? requiredAgents : new Set([...requiredAgents].filter((a) => a !== 'admin'))

        let pipelineHints = pipelineHintsFromMeta(state.meta)
        if (!pipelineHints) {
          pipelineHints = await resolvePipelineHints({
            question: planTaskText || question,
            allowedAgents: [...finalRequiredAgents],
            clauses,
            constraints,
            llmInvoke,
            state
          })
        }
        const pipeOpts = { question: planTaskText || question, constraints, pipelineHints }
        const routeAllowedCap = (): Step['agent'][] | undefined =>
          expandedAllowed.length ? expandedAllowed : rawAllowed.length ? rawAllowed : undefined
        const coverRouteAgents = (plan: Step[], excerpt: string) =>
          applyRoutePlanCoverage(plan, {
            question,
            intent: state.intent,
            allowedCap: routeAllowedCap(),
            excerpt,
            constraints,
            pipelineHints
          })
        const enrichPlanWithTopology = async (planIn: Step[], excerpt: string) => {
          let plan = validateAndPreparePlan(planIn, {
            excerpt,
            pipelineOpts: pipeOpts,
            allowedCap: [...finalRequiredAgents] as Step['agent'][]
          })
          const mediaTopology = await resolveMediaPlanTopology({
            question: excerpt || planTaskText || question,
            plan,
            allowedAgents: [...finalRequiredAgents],
            hasAttachment: Boolean(state.mediaAttachment?.filePath),
            meta: state.meta,
            llmInvoke,
            state
          })
          plan = applyMediaPlanTopology(plan, mediaTopology)
          if (
            !state?.meta?.lowCostMode &&
            (mediaTopology.musicDependsOnMultimodal || mediaTopology.videoDependsOnMultimodal)
          ) {
            opts.sendEvent({
              event: 'thinking',
              data: `媒体拓扑（LLM/路由启发）：music→识图=${mediaTopology.musicDependsOnMultimodal}；video→识图=${mediaTopology.videoDependsOnMultimodal}${
                mediaTopology.rationale ? `（${mediaTopology.rationale.slice(0, 72)}）` : ''
              }`,
              from: 'manager'
            })
          }
          return { plan, mediaTopology }
        }
        const pipelineHintBlock =
          pipelineHints.needsCode || pipelineHints.needsClean
            ? `【流水线启发（模型语义判断）】needsCode=${pipelineHints.needsCode}；needsClean=${pipelineHints.needsClean}${
                pipelineHints.rationale ? `；理由：${pipelineHints.rationale}` : ''
              }`
            : ''
        if (!state?.meta?.lowCostMode && (pipelineHints.needsCode || pipelineHints.needsClean) && isOrchVerbose()) {
          opts.sendEvent({
            event: 'thinking',
            data: `流水线启发：code=${pipelineHints.needsCode} clean=${pipelineHints.needsClean}${pipelineHints.rationale ? `（${pipelineHints.rationale.slice(0, 80)}）` : ''}`,
            from: 'manager'
          })
        }

        const planInternalFixes: string[] = []
        let planBlueprint = planBlueprintFromMeta(state.meta)
        if (!planBlueprint?.steps?.length && state.intent === 'multi' && finalRequiredAgents.size >= 1) {
          planBlueprint = await resolvePlanBlueprintByLlm({
            userTask: planTaskText || question,
            allowedAgents: [...finalRequiredAgents],
            clauses,
            constraints,
            pipelineHints,
            llmInvoke,
            state
          })
          if (planBlueprint && !state?.meta?.lowCostMode && isOrchVerbose()) {
            opts.sendEvent({
              event: 'thinking',
              data: `执行蓝图（${planBlueprint.steps.length} 步，conf=${Number(planBlueprint.confidence).toFixed(2)}）：${planBlueprint.steps.map((s) => s.agent).join('、')}`,
              from: 'manager'
            })
          }
        }
        const blueprintBlock = formatPlanBlueprintForPrompt(planBlueprint)
        const webModeDecision = webExecutionModeFromMeta(state.meta)
        const webModeBlock = formatWebExecutionModeForPrompt(webModeDecision)
        const serpSummaryEnough =
          webModeDecision?.serpSummaryEnough === true ||
          webModeDecision?.mode === 'search_serp_only' ||
          state.meta?.compositeWebExecution === 'serp_summary'
        const routeCapMandatoryBlock =
          finalRequiredAgents.size > 0
            ? [
                `【路由 cap 强制】以下 Agent 必须各生成独立一步，禁止合并或省略：${[...finalRequiredAgents].join('、')}。`,
                finalRequiredAgents.has('crawler')
                  ? serpSummaryEnough
                    ? '本轮公网腿 serpSummaryEnough：crawler 步消费联网检索摘要即可，勿要求全文/榜单精抓。'
                    : 'web_search 仅为联网种子；allowedAgents 含 crawler 时须单独一步采集公网参考/指南摘要（不可假定预取已替代 crawler）。'
                  : '',
                state.meta?.needsWebSearch === true && finalRequiredAgents.has('crawler')
                  ? '本轮已执行或即将使用联网检索，crawler 步骤应消费 serp_context/seedUrls。'
                  : ''
              ]
                .filter(Boolean)
                .join('\n')
            : ''

        /** multi 且 LLM 规划失败时：按子句/agent 生成精简 query（不再透传整段任务） */
        const tryRuleBasedMultiFallback = async (): Promise<{ plan: any[]; taskPlan: any } | null> => {
          if (state.intent !== 'multi' || finalRequiredAgents.size < 1) return null
          if (finalRequiredAgents.size === 1) {
            const only = [...finalRequiredAgents][0] as Step['agent']
            if (!['multimodal', 'music', 'video', 'rag', 'db', 'crawler', 'gui', 'admin'].includes(only)) return null
            const q = plannerQueryForAgent(only, planHeuristicsText, state)
            const single = await sanitizePlan(
              normalizePlanSteps(enforcePlanConstraints([{ id: `step_${only}`, agent: only, query: q }], constraints))
            )
            publishPlanUi(single)
            return { plan: single, taskPlan: buildTaskPlan(state, single) }
          }
          const rulePlan: any[] = []
          const dataAgentIds: string[] = []
          const needRag = finalRequiredAgents.has('rag')
          const needDb = finalRequiredAgents.has('db')
          const needCrawler = finalRequiredAgents.has('crawler')
          const needGui = finalRequiredAgents.has('gui')
          const needAdmin = finalRequiredAgents.has('admin')
          if (needRag) {
            const q = plannerQueryForAgent('rag', planHeuristicsText, state)
            rulePlan.push({ id: 'step_rag', agent: 'rag', query: `从知识库/文档查询相关原始数据并返回事实：${q}` })
            dataAgentIds.push('step_rag')
          }
          if (needDb) {
            const q = plannerQueryForAgent('db', question, state)
            rulePlan.push({ id: 'step_db', agent: 'db', query: `从数据库查询：${q}` })
            dataAgentIds.push('step_db')
          }
          if (needCrawler) {
            const q = plannerQueryForAgent('crawler', planHeuristicsText, state)
            rulePlan.push({ id: 'step_crawler', agent: 'crawler', query: `从公开网页采集与任务相关的事实信息：${q}` })
            dataAgentIds.push('step_crawler')
          }
          if (needGui) {
            const q = plannerQueryForAgent('gui', planHeuristicsText, state)
            rulePlan.push({ id: 'step_gui', agent: 'gui', query: `在浏览器中完成用户指定的页面交互与信息抽取：${q}` })
          }
          if (finalRequiredAgents.has('multimodal')) {
            const q = plannerQueryForAgent('multimodal', planHeuristicsText, state)
            rulePlan.push({ id: 'step_multimodal', agent: 'multimodal', query: q })
          }
          if (finalRequiredAgents.has('music')) {
            const q = plannerQueryForAgent('music', planHeuristicsText, state)
            rulePlan.push({ id: 'step_music', agent: 'music', query: q })
          }
          if (finalRequiredAgents.has('video')) {
            const q = plannerQueryForAgent('video', planHeuristicsText, state)
            rulePlan.push({ id: 'step_video', agent: 'video', query: q })
          }
          const processingAgentIds: string[] = [...dataAgentIds]
          if (finalRequiredAgents.has('clean') && dataAgentIds.length > 0) {
            const q = plannerQueryForAgent('clean', question, state)
            rulePlan.push({
              id: 'step_clean',
              agent: 'clean',
              query: `对已有数据进行清洗、去重、规范化与字段对齐：${q}`
            })
            processingAgentIds.push('step_clean')
          }
          if (finalRequiredAgents.has('code')) {
            const q = plannerQueryForAgent('code', question, state)
            rulePlan.push({
              id: 'step_code',
              agent: 'code',
              query: `对已有数据进行计算、加工和汇总，提取关键数值：${q}`
            })
            processingAgentIds.push('step_code')
          }
          if (finalRequiredAgents.has('visualize')) {
            const q = plannerQueryForAgent('visualize', question, state)
            rulePlan.push({
              id: 'step_visualize',
              agent: 'visualize',
              query: `基于已有事实生成图表配置（ECharts option JSON）和表格数据：${q}`
            })
          }
          if (finalRequiredAgents.has('report')) {
            const q = plannerQueryForAgent('report', question, state)
            rulePlan.push({
              id: 'step_report',
              agent: 'report',
              query: `整合多源结果生成结构化分析报告（核心结论、风险、建议）：${q}`
            })
          }
          if (needAdmin) {
            const q = plannerQueryForAgent('admin', question, state)
            rulePlan.push({
              id: 'step_admin',
              agent: 'admin',
              query: extractAdminSubtaskText(q) || q
            })
          }
          if (rulePlan.length === 0) return null
          const capForClause = expandedAllowed.length ? expandedAllowed : ([...finalRequiredAgents] as Step['agent'][])
          const clauseBoundRule = mergePlanWithClauseMaterialization(rulePlan as Step[], clauses, {
            excerpt: planHeuristicsText,
            fallbackQuery: planHeuristicsText,
            allowedAgents: capForClause,
            meta: state.meta as Record<string, unknown>
          })
          let preTopoPlan = clauseBoundRule.plan
          if (clauseBoundRule.repaired && !state?.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: `规则兜底子句绑定：${clauseBoundRule.reasons.join('；')}`,
              from: 'manager'
            })
          }
          const { plan: ensuredRulePlan } = await enrichPlanWithTopology(preTopoPlan, planHeuristicsText)
          const planDebug = ensuredRulePlan.map((s: any) => `${s.agent}:${String(s.query || '').replace(/\s+/g, ' ').slice(0, 60)}`).join(' | ')
          if (!state?.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: `规划：LLM 未产出有效步骤，使用规则兜底 → ${ensuredRulePlan.map((s: any) => s.agent).join(' → ')}；明细：${planDebug}`,
              from: 'manager'
            })
          }
          const constrainedRulePlan = await sanitizePlan(
            stripAdminStepsIfBlocked(normalizePlanSteps(enforcePlanConstraints(ensuredRulePlan, constraints)), state)
          )
          let taskPlan = buildTaskPlan(state, constrainedRulePlan)
          if (rulePlan.some((s: any) => s.agent === 'db') && opts.dbAgentHttpUrl) {
            try {
              const dbPlanRes = await fetchDbPlanWithScope(question)
              const unified = dbPlanRes?.unified_task_plan
              if (unified && typeof unified === 'object') {
                taskPlan = mergeTaskPlan(taskPlan, {
                  intent: taskPlan.intent,
                  entities: {
                    names: Array.isArray(unified?.entities?.names) ? unified.entities.names : [],
                    records: Array.isArray(unified?.entities?.records) ? unified.entities.records : [],
                    locations: Array.isArray(unified?.entities?.locations) ? unified.entities.locations : [],
                    dates: Array.isArray(unified?.entities?.dates) ? unified.entities.dates : []
                  }
                } as any, state.intent, constrainedRulePlan)
              }
            } catch {}
          }
          await appendMemory({
            type: 'plan_llm',
            user: lastUserText(state.messages),
            intent: state.intent,
            routedQuery: state.routedQuery || '',
            plan: constrainedRulePlan,
            source: 'rule',
            ruleFallback: true,
            clauseCount: clauses.length
          })
          await recordPlanOutcome?.({
            user: lastUserText(state.messages),
            intent: state.intent,
            plan: constrainedRulePlan,
            source: 'rule',
            runId
          })
          publishPlanUi(constrainedRulePlan)
          return { plan: constrainedRulePlan, taskPlan }
        }

        /** 编排已产出蓝图：材料化为 plan，跳过 Planner LLM（语义来自 orchestrate，此处只做结构映射） */
        const tryBlueprintMaterializedPlan = async (materializeOpts?: {
          force?: boolean
        }): Promise<{ plan: Step[]; taskPlan: any } | null> => {
          if (!materializeOpts?.force && !shouldMaterializePlanFromBlueprint(state)) return null
          if (state.intent !== 'multi' || finalRequiredAgents.size < 2) return null
          if (!planBlueprint?.steps?.length) return null
          if (!blueprintCoversRequiredAgents(planBlueprint, [...finalRequiredAgents])) return null
          const minConf = materializeOpts?.force ? 0.55 : 0.65
          if (Number(planBlueprint.confidence ?? 0) < minConf) return null

          const rawSteps = materializeStepsFromBlueprint(planBlueprint, (agent, focus) =>
            formatBlueprintStepQuery(agent, focus, state)
          )
          const capForClause = expandedAllowed.length ? expandedAllowed : ([...finalRequiredAgents] as Step['agent'][])
          const clauseBound = mergePlanWithClauseMaterialization(rawSteps, clauses, {
            excerpt: planHeuristicsText,
            fallbackQuery: planHeuristicsText,
            allowedAgents: capForClause,
            meta: state.meta as Record<string, unknown>
          })
          const { plan: topoPlan } = await enrichPlanWithTopology(clauseBound.plan, planHeuristicsText)
          const covered = coverRouteAgents(topoPlan, planHeuristicsText)
          const constrained = await sanitizePlan(
            stripAdminStepsIfBlocked(
              normalizePlanSteps(enforcePlanConstraints(covered, constraints)),
              state
            )
          )
          if (!constrained.length) return null
          if (!state?.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: `规划：编排蓝图材料化（跳过 Planner LLM）→ ${constrained.map((s) => s.agent).join(' → ')}`,
              from: 'manager'
            })
          }
          let taskPlan = buildTaskPlan(state, constrained)
          const dbStepForPrefetch = constrained.find((s) => String(s?.agent || '') === 'db')
          if (dbStepForPrefetch && opts.dbAgentHttpUrl) {
            const dbPrefetchSource =
              String(dbStepForPrefetch.query || '').trim().length >= 4
                ? String(dbStepForPrefetch.query).trim()
                : question
            taskPlan = await enrichTaskPlanWithDbPlan(taskPlan, state, state.intent, constrained, mergeTaskPlan, async () => {
              try {
                const dbPlanRes = await fetchDbPlanWithScope(dbPrefetchSource)
                const unified = dbPlanRes?.unified_task_plan
                if (unified && typeof unified === 'object') {
                  return mergeTaskPlan(
                    taskPlan,
                    {
                      intent: taskPlan.intent,
                      entities: {
                        names: Array.isArray(unified?.entities?.names) ? unified.entities.names : [],
                        records: Array.isArray(unified?.entities?.records) ? unified.entities.records : [],
                        locations: Array.isArray(unified?.entities?.locations) ? unified.entities.locations : [],
                        dates: Array.isArray(unified?.entities?.dates) ? unified.entities.dates : []
                      }
                    },
                    state.intent,
                    constrained
                  )
                }
              } catch {
                /* ignore */
              }
              return taskPlan
            })
          }
          await appendMemory({
            type: 'plan_llm',
            user: lastUserText(state.messages),
            intent: state.intent,
            routedQuery: state.routedQuery || '',
            plan: constrained,
            source: 'rule',
            ruleFallback: true,
            clauseCount: clauses.length
          })
          await recordPlanOutcome?.({
            user: lastUserText(state.messages),
            intent: state.intent,
            plan: constrained,
            source: 'rule',
            runId
          })
          publishPlanUi(constrained)
          return { plan: constrained, taskPlan }
        }

        const blueprintMaterialized = await tryBlueprintMaterializedPlan()
        if (blueprintMaterialized) {
          return {
            plan: blueprintMaterialized.plan,
            taskPlan: blueprintMaterialized.taskPlan,
            resources: state.resources,
            meta: attachPlanMeta(state.meta, { pipelineHints, planBlueprint, planMaterialized: true })
          }
        }

        const routeAgentHints = Array.from(finalRequiredAgents)
        const allowedAgents = routeAgentHints.length
          ? routeAgentHints.join(' / ')
          : '仅允许从用户问题中明确能推出的 Agent 中选择；不要根据 probe 或你自己的猜测新增 db/rag/crawler'
        const clauseHint =
          isClauseDecomposeEnabled(deps.sessionId) && clauses.length > 1
            ? `【LLM 子句参考】${clauses.map((c, i) => `${i + 1}.${c.text}${c.agents.length ? `→${c.agents.join('+')}` : ''}`).join('；')}`
            : ''
        const clauseAgentHint =
          clauseAgents.length > 0
            ? `【子句 agent 并集（必须在 steps 中体现；每步写 clauseIds）】${clauseAgents.join(' / ')}`
            : ''
        const clauseBindingHint =
          clauses.length > 1
            ? `【子句绑定】共 ${clauses.length} 条子句：${clauses.map((c) => `${c.id}→${c.agents.join('+') || '?'}`).join('；')}；每步必须含 clauseIds，且每个子句至少一步。`
            : ''
        const suppressCanary = Boolean((state.meta as { routeStrategy?: { suppressCanary?: boolean } })?.routeStrategy?.suppressCanary)
        const skipLayeredMemoryForPlanner =
          state.meta?.turnScope === 'current_only' ||
          Boolean(state.meta?.standaloneMediaRoute) ||
          preferCurrentTurnScope(state.messages as any, lastMsg)
        const composed = deps.policyDir
          ? await composeManagerPromptContext({
              stage: 'planner',
              policyDir: deps.policyDir,
              sessionId: deps.sessionId,
              userId: deps.userId,
              heuristicsText: planHeuristicsText,
              state,
              suppressCanary,
              skipLayeredMemoryForPlanner,
              getPlanQualityHint
            })
          : { blocks: [] as string[], metaPatch: {}, artifacts: null as any }
        const artifactMetaPatch = composed.metaPatch
        const withPipelineMeta = (meta: any) =>
          attachPlanMeta(meta, { pipelineHints, planBlueprint, ...artifactMetaPatch })
        const plannerPlaybookRules = clipSkillBlock(
          getPlannerPlaybookRules(allowedAgents, PLANNER_RULES_FALLBACK) +
            getAgentScopedPlaybookAddons({
              allowedAgents: String(allowedAgents || '')
                .split(/[,，/\s]+/)
                .map((x) => x.trim())
                .filter(Boolean),
              intent: String(state.intent || '')
            })
        )
        const prompt = [
          new SystemMessage(
            [
              PLANNER_INTRO,
              ...composed.blocks,
              clauseHint,
              clauseAgentHint,
              clauseBindingHint,
              pipelineHintBlock,
              blueprintBlock,
              webModeBlock,
              routeCapMandatoryBlock,
              plannerPlaybookRules,
              `- 格式：\n${PLAN_JSON_EXAMPLE}`
            ]
              .map((x) => String(x ?? '').trim())
              .filter(Boolean)
              .join('\n')
          ),
          new HumanMessage(
            [
              `路由后的用户任务：${question}`,
              `probe（弱参考，勿据此擅自加步骤）：${probeContext}`,
              prefetchContext ? `预取（route 后并行，供规划参考）：\n${prefetchContext}` : '',
              String(state.meta?.serpContext || '').trim() ?
                `联网摘要（若已执行 web_search）：\n${String(state.meta?.serpContext || '').trim()}`
              : '',
              `工具健康：${healthContext}`,
              '仅输出 JSON，不要任何其他内容：'
            ]
              .filter(Boolean)
              .join('\n')
          )
        ]

        let nextResources = state.resources
        let nextMeta = state.meta

        const finalizePlannerFromSteps = async (
          rawSteps: Step[]
        ): Promise<{ plan: Step[]; taskPlan: any; resources: typeof nextResources; meta: any }> => {
          const cap = expandedAllowed.length ? expandedAllowed : undefined
          let plan = reconcilePlanWithRoute(rawSteps, {
            intent: state.intent,
            allowedAgents: cap,
            clauseAgents,
            question,
            excerpt: planHeuristicsText,
            mediaAttachment: state.mediaAttachment ?? null,
            constraints
          })
          const clauseBound = mergePlanWithClauseMaterialization(plan, clauses, {
            excerpt: planHeuristicsText,
            fallbackQuery: planHeuristicsText,
            allowedAgents: cap,
            meta: state.meta as Record<string, unknown>
          })
          plan = clauseBound.plan
          if (clauseBound.repaired) {
            notePlanInternalFix(planInternalFixes, `子句绑定：${clauseBound.reasons.join('；')}`)
            if (!state?.meta?.lowCostMode && isOrchVerbose()) {
              opts.sendEvent({
                event: 'thinking',
                data: `子句绑定补全：${clauseBound.reasons.join('；')}`,
                from: 'manager'
              })
            }
          }
          const enriched = await enrichPlanWithTopology(plan, planHeuristicsText)
          plan = coverRouteAgents(enriched.plan, planHeuristicsText)
          const onlyAdmin =
            finalRequiredAgents.has('admin') &&
            !finalRequiredAgents.has('code') &&
            !finalRequiredAgents.has('db') &&
            !finalRequiredAgents.has('rag') &&
            !finalRequiredAgents.has('crawler') &&
            !finalRequiredAgents.has('multimodal') &&
            !finalRequiredAgents.has('music') &&
            !finalRequiredAgents.has('video')
          if (onlyAdmin && !plan.some((s: any) => s.agent === 'admin')) {
            plan = [
              {
                id: 'step_admin',
                agent: 'admin',
                query: extractAdminSubtaskText(question) || question
              }
            ]
          }
          plan = await sanitizePlan(
            stripAdminStepsIfBlocked(normalizePlanSteps(enforcePlanConstraints(plan, constraints)), state)
          )
          const planForDag = finalizePlanForExecution(plan as Step[])
          if (!state?.meta?.lowCostMode) {
            const pipelineNote =
              pipelineHints.needsCode || pipelineHints.needsClean
                ? `code=${pipelineHints.needsCode} clean=${pipelineHints.needsClean}`
                : undefined
            const blueprintNote = planBlueprint?.steps?.length
              ? planBlueprint.steps.map((s) => s.agent).join('、')
              : undefined
            opts.sendEvent({
              event: 'thinking',
              data: formatPlanOrchestrationSummary({
                plan: planForDag,
                pipelineNote,
                blueprintNote,
                internalFixes: planInternalFixes
              }),
              from: 'manager'
            })
            if (isOrchVerbose()) {
              const planDebug = plan
                .map((s: any) => `${s.agent}:${String(s.query || '').replace(/\s+/g, ' ').slice(0, 60)}`)
                .join(' | ')
              opts.sendEvent({ event: 'thinking', data: `计划明细：${planDebug}`, from: 'manager' })
            }
          }
          publishPlanUi(planForDag)
          let taskPlan = buildTaskPlan(state, plan)
          const dbStepForPrefetch = plan.find((s: any) => String(s?.agent || '') === 'db')
          const dbPrefetchSource =
            dbStepForPrefetch && String(dbStepForPrefetch.query || '').trim().length >= 4
              ? String(dbStepForPrefetch.query).trim()
              : question
          const hasDbStep = Boolean(dbStepForPrefetch)
          if (hasDbStep && opts.dbAgentHttpUrl) {
            taskPlan = await enrichTaskPlanWithDbPlan(taskPlan, state, state.intent, plan, mergeTaskPlan, async () => {
              try {
                const dbPlanRes = await fetchDbPlanWithScope(dbPrefetchSource)
                const unified = dbPlanRes?.unified_task_plan
                if (unified && typeof unified === 'object') {
                  return mergeTaskPlan(
                    taskPlan,
                    {
                      intent: taskPlan.intent,
                      entities: {
                        names: Array.isArray(unified?.entities?.names) ? unified.entities.names : [],
                        records: Array.isArray(unified?.entities?.records) ? unified.entities.records : [],
                        locations: Array.isArray(unified?.entities?.locations) ? unified.entities.locations : [],
                        dates: Array.isArray(unified?.entities?.dates) ? unified.entities.dates : []
                      }
                    } as any,
                    state.intent,
                    plan
                  )
                }
              } catch {}
              return taskPlan
            })
          }
          await appendMemory({
            type: 'plan_llm',
            user: lastUserText(state.messages),
            intent: state.intent,
            routedQuery: state.routedQuery || '',
            plan,
            source: 'llm',
            clauseCount: clauses.length
          })
          await recordPlanOutcome?.({
            user: lastUserText(state.messages),
            intent: state.intent,
            plan,
            source: 'llm',
            runId
          })
          return { plan, taskPlan, resources: nextResources, meta: withPipelineMeta(nextMeta) }
        }

        try {
          const r = await llmInvoke('plan', state, prompt)
          const rText = String(r.text ?? '').trim()
          nextResources = r.resources
          nextMeta = r.meta ?? nextMeta

          const parsed = parsePlanLlmJson(rText)
          if (parsed.success) {
            return await finalizePlannerFromSteps(parsed.data.steps)
          }
          if (!state?.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: '规划：LLM 输出无法通过 schema 校验，尝试编排蓝图材料化…',
              from: 'manager'
            })
          }
          const schemaBlueprint = await tryBlueprintMaterializedPlan({ force: true })
          if (schemaBlueprint) {
            return {
              plan: schemaBlueprint.plan,
              taskPlan: schemaBlueprint.taskPlan,
              resources: nextResources,
              meta: withPipelineMeta(nextMeta)
            }
          }
          if (!state?.meta?.lowCostMode) {
            opts.sendEvent({
              event: 'thinking',
              data: '规划：LLM 输出无法通过 schema 校验，将尝试 multi 规则兜底或默认规划。',
              from: 'manager'
            })
          }
        } catch (e: any) {
          opts.sendEvent({
            event: 'thinking',
            data: `规划：LLM 异常（${e.message}），尝试编排蓝图材料化…`,
            from: 'manager'
          })
          const blueprintFallback = await tryBlueprintMaterializedPlan({ force: true })
          if (blueprintFallback) {
            return {
              plan: blueprintFallback.plan,
              taskPlan: blueprintFallback.taskPlan,
              resources: nextResources,
              meta: withPipelineMeta(nextMeta)
            }
          }
          try {
            opts.sendEvent({ event: 'thinking', data: '规划：Planner LLM 重试一次…', from: 'manager' })
            const r2 = await (llmInvoke as (typeof llmInvoke & { (s: 'plan', st: any, m: any[], o?: { tier?: 'light' | 'standard' }): Promise<{ text: string; resources: any; meta: any }> }))(
              'plan',
              state,
              prompt,
              { tier: 'light' }
            )
            nextResources = r2.resources ?? nextResources
            nextMeta = r2.meta ?? nextMeta
            const parsed2 = parsePlanLlmJson(String(r2.text ?? '').trim())
            if (parsed2.success) {
              return await finalizePlannerFromSteps(parsed2.data.steps)
            }
          } catch (e2: any) {
            opts.sendEvent({
              event: 'thinking',
              data: `规划：重试仍失败（${e2.message}），尝试 LLM 补步…`,
              from: 'manager'
            })
          }
          const capAgents = expandedAllowed.length ? expandedAllowed : [...finalRequiredAgents]
          const execAgents = new Set([
            'db', 'rag', 'code', 'crawler', 'gui', 'admin', 'clean', 'visualize', 'report', 'multimodal', 'music', 'video'
          ])
          const missing = capAgents.filter((a) => execAgents.has(String(a))) as Step['agent'][]
          if (missing.length >= 2) {
            const repaired = await repairMissingPlanStepsByLlm({
              missingAgents: missing,
              existingPlan: [],
              userTask: question,
              allowedAgents: capAgents.map(String),
              clauses,
              planBlueprint,
              llmInvoke,
              state
            })
            if (repaired?.length) {
              try {
                return await finalizePlannerFromSteps(repaired)
              } catch {}
            }
          }
          opts.sendEvent({
            event: 'thinking',
            data: `规划：LLM 补步未成功，回退默认规划（原因：${e.message}）`,
            from: 'manager'
          })
        }

        const ruleFallback = shouldSkipPlanRuleFallback(state) ? null : await tryRuleBasedMultiFallback()
        if (ruleFallback) {
          publishPlanUi(ruleFallback.plan)
          return { plan: ruleFallback.plan, taskPlan: ruleFallback.taskPlan, resources: nextResources, meta: withPipelineMeta(nextMeta) }
        }

        if (shouldSkipPlanRuleFallback(state)) {
          opts.sendEvent({
            event: 'thinking',
            data: '规划：编排 LLM 蓝图/Planner 均未产出有效步骤（已禁用规则兜底）',
            from: 'manager'
          })
          return {
            plan: [],
            taskPlan: buildTaskPlan(state, []),
            resources: nextResources,
            meta: withPipelineMeta({
              ...nextMeta,
              needsClarify: true,
              clarifyQuestions: ['请补充各子任务的数据来源与期望输出（如：知识库/数据库/联网/附件）']
            })
          }
        }

        const defaultPlan: any[] = []
        const userTask = effectiveUserTask(state.messages as any, state.routedQuery)
        const fallbackHeuristics = String(lastMsg || '').trim() || userTask
        const fallbackRequired = new Set<string>(
          expandedAllowed.length ? expandedAllowed : rawAllowed
        )

        if (fallbackRequired.has('rag') || state.intent === 'rag') {
          defaultPlan.push({
            id: 'step_rag',
            agent: 'rag',
            query: `从知识库/文档查询相关原始数据并返回事实：${plannerQueryForAgent('rag', fallbackHeuristics, state)}`
          })
        }
        if (fallbackRequired.has('db') || state.intent === 'db') {
          defaultPlan.push({
            id: 'step_db',
            agent: 'db',
            query: `从数据库查询：${plannerQueryForAgent('db', userTask, state)}`
          })
        }
        if (fallbackRequired.has('crawler') || state.intent === 'crawler') {
          defaultPlan.push({
            id: 'step_crawler',
            agent: 'crawler',
            query: `从公开网页采集与任务相关的事实信息：${plannerQueryForAgent('crawler', fallbackHeuristics, state)}`
          })
        }
        if (fallbackRequired.has('gui') || state.intent === 'gui') {
          defaultPlan.push({
            id: 'step_gui',
            agent: 'gui',
            query: `在浏览器中完成用户指定的页面交互与信息抽取：${plannerQueryForAgent('gui', fallbackHeuristics, state)}`
          })
        }
        if (fallbackRequired.has('multimodal') || state.intent === 'multimodal') {
          defaultPlan.push({ id: 'step_multimodal', agent: 'multimodal', query: plannerQueryForAgent('multimodal', fallbackHeuristics, state) })
        }
        if (fallbackRequired.has('music') || state.intent === 'music') {
          defaultPlan.push({ id: 'step_music', agent: 'music', query: plannerQueryForAgent('music', fallbackHeuristics, state) })
        }
        if (fallbackRequired.has('video') || state.intent === 'video') {
          defaultPlan.push({ id: 'step_video', agent: 'video', query: plannerQueryForAgent('video', fallbackHeuristics, state) })
        }
        if (fallbackRequired.has('code')) {
          defaultPlan.push({
            id: 'step_code',
            agent: 'code',
            query: `对已有数据进行计算、加工和汇总，提取关键数值：${plannerQueryForAgent('code', userTask, state)}`
          })
        }

        if (defaultPlan.length === 0) {
          const mediaIntent = ['video', 'music', 'multimodal'].includes(String(state.intent))
            ? (state.intent as Step['agent'])
            : null
          if (mediaIntent) {
            defaultPlan.push({
              id: `step_${mediaIntent}`,
              agent: mediaIntent,
              query: plannerQueryForAgent(mediaIntent, fallbackHeuristics, state)
            })
          } else if (state.mediaAttachment?.filePath) {
            defaultPlan.push({
              id: 'step_multimodal',
              agent: 'multimodal',
              query: plannerQueryForAgent('multimodal', fallbackHeuristics, state)
            })
          } else {
            const classify = intentClassifyFromMeta(state.meta)
            const seed = (classify?.suggestedAgents?.length ? classify.suggestedAgents : allowedOnly) as Step['agent'][]
            const preferOrder: Step['agent'][] = ['rag', 'db', 'crawler', 'admin', 'code', 'multimodal', 'music', 'video']
            const pick = preferOrder.find((a) => seed.includes(a)) || seed[0] || 'rag'
            defaultPlan.push({
              id: `step_${pick}`,
              agent: pick,
              query: plannerQueryForAgent(pick, userTask, state)
            })
          }
        }

        const foundationPlan = defaultPlan

        const existingAgents = new Set(foundationPlan.map((s) => s.agent))
        if (state.intent === 'multi') {
          const extraAgents: Array<{ agent: string; query: string }> = []
          if (!existingAgents.has('visualize') && fallbackRequired.has('visualize')) {
            extraAgents.push({ agent: 'visualize', query: `基于已有事实生成图表配置（ECharts option JSON）和表格数据：${userTask}` })
          }
          if (!existingAgents.has('report') && fallbackRequired.has('report')) {
            extraAgents.push({ agent: 'report', query: `整合多源结果生成结构化分析报告（核心结论、风险、建议）：${userTask}` })
          }
          if (!existingAgents.has('clean') && fallbackRequired.has('clean')) {
            extraAgents.push({ agent: 'clean', query: `对已有数据进行清洗与标准化：${userTask}` })
          }
          if (!existingAgents.has('admin') && fallbackRequired.has('admin')) {
            extraAgents.push({
              agent: 'admin',
              query: extractAdminSubtaskText(userTask) || userTask
            })
          }
          for (const item of extraAgents) {
            foundationPlan.push({
              id: `step_${item.agent}`,
              agent: item.agent,
              query: item.query
            })
          }
        }

        const capAgents = expandedAllowed.length ? expandedAllowed : undefined
        const reconciledDefault = enforcePlanConstraints(
          reconcilePlanWithRoute(foundationPlan, {
            intent: state.intent,
            allowedAgents: capAgents,
            clauseAgents,
            question: userTask,
            excerpt: fallbackHeuristics,
            mediaAttachment: state.mediaAttachment ?? null,
            constraints
          }),
          constraints
        )
        const { plan: topologyDefaultPlan } = await enrichPlanWithTopology(reconciledDefault, fallbackHeuristics)
        const coveredDefaultPlan = coverRouteAgents(topologyDefaultPlan, fallbackHeuristics)
        const enforcedDefaultPlan = await sanitizePlan(
          stripAdminStepsIfBlocked(normalizePlanSteps(coveredDefaultPlan), state)
        )
        const defaultPlanDebug = enforcedDefaultPlan.map((s: any) => `${s.agent}:${String(s.query || '').replace(/\s+/g, ' ').slice(0, 60)}`).join(' | ')
        opts.sendEvent({ event: 'thinking', data: `回退计划：${enforcedDefaultPlan.map((s: any) => s.agent).join(' → ')}；明细：${defaultPlanDebug}`, from: 'manager' })
        let taskPlan = buildTaskPlan(state, enforcedDefaultPlan)
        const hasDbStep = enforcedDefaultPlan.some((s: any) => s.agent === 'db')
        if (hasDbStep && opts.dbAgentHttpUrl) {
          taskPlan = await enrichTaskPlanWithDbPlan(taskPlan, state, state.intent, enforcedDefaultPlan, mergeTaskPlan, async () => {
            try {
              const dbPlanRes = await fetchDbPlanWithScope(userTask)
              const unified = dbPlanRes?.unified_task_plan
              if (unified && typeof unified === 'object') {
                return mergeTaskPlan(
                  taskPlan,
                  {
                    intent: taskPlan.intent,
                    entities: {
                      names: Array.isArray(unified?.entities?.names) ? unified.entities.names : [],
                      records: Array.isArray(unified?.entities?.records) ? unified.entities.records : [],
                      locations: Array.isArray(unified?.entities?.locations) ? unified.entities.locations : [],
                      dates: Array.isArray(unified?.entities?.dates) ? unified.entities.dates : []
                    }
                  } as any,
                  state.intent,
                  enforcedDefaultPlan
                )
              }
            } catch {}
            return taskPlan
          })
        }
        publishPlanUi(enforcedDefaultPlan)
        return { plan: enforcedDefaultPlan, taskPlan, resources: nextResources, meta: withPipelineMeta(nextMeta) }
}
