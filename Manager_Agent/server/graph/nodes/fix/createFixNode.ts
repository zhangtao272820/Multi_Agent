import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { Intent } from '../../../utils/shared/taskPlan'
import { effectiveUserTask } from '../../core/text'
import {
  buildAgentExecutorBundle,
  executeAdminStep,
  executeDbStep
} from '../../core/executors'
import {
  buildCrawlerHistoryFromMessages,
  buildCrawlerResultForManager,
  crawlerInvokeFromState,
} from '../../../utils/crawler/managerCrawlerTaskPayload'
import {
  buildManagerCodeTaskPayload,
  buildUpstreamContextFromResults,
} from '../../../utils/code/managerCodeTaskPayload'
import { unwrapAgentCall } from '../../../utils/agents/agentResult'
import {
  buildCodeEvidenceExtras,
  buildCodeFixHintFromMeta,
  parseCodeClarifyFromMeta,
} from '../../../utils/code/managerCodeMeta'
import { resolveManagerAgentSessionId } from '../../core/runtime/sessionBridge'
import { hasCodeInResults } from '#agent-shared/codeFirstAuthority'
import { extractStructuredPayload } from '../../core/shared'
import { tryCodeAuthorityDownstreamOutput } from '../../../utils/code/managerCodeDownstream'
import { createCodeAuthorityLlmModel } from '../../../utils/code/managerCodeAuthorityLlm'
import { criticRetryContradictsRunEvidence } from '../../core/output/criticEvidence'
import { isFixIntentBlockedByHardDown } from '../../core/output/criticPolicy'
import { detectGuiSemanticBlockFromState } from '../../../utils/gui/guiHumanConfirm'
import {
  detectGuiTerminalFailure,
  hasFailedGuiEvidenceInRun
} from '../../core/runtime/guiTerminal'

import type { CreateFixNodeDeps, FixStrategy } from './types'

export function createFixNode(deps: CreateFixNodeDeps) {
  const {
    ensureNotAborted,
    opts,
    lastUserText,
    llmInvoke,
    FixStrategySchema,
    safeJsonParse,
    callDbAgent,
    callRagAgent,
    callCrawlerAgent,
    callCodeAgent,
    callAiAdminAgent,
    parseCrawlerClarifyPayload,
    crawlerTaskPlanPatch,
    mergeMeta,
    mergeTaskPlan,
    getEffectivePlanSteps,
    appendMetrics,
    runInternalAgent,
    emitTrace,
    summarize,
    probeRagEvidence,
    isDbNoData
  } = deps

  return async (state: any) => {
    ensureNotAborted()
    opts.sendEvent({ event: 'phase', data: 'fix', from: 'manager' })

    if (Boolean(state.meta?.synthOnlyRepair)) {
      opts.sendEvent({
        event: 'thinking',
        data: '自愈：Code/图表数据已正确，仅重汇总正文以对齐 Code 口径',
        from: 'manager'
      })
      return { meta: mergeMeta(state, { synthOnlyRepair: false }) }
    }

    const guiSemanticBlock = detectGuiSemanticBlockFromState(state)
    if (guiSemanticBlock.blocked) {
      opts.sendEvent({
        event: 'thinking',
        data: '自愈：GUI 验证码/登录墙不可自动修复，跳过重跑浏览器步骤',
        from: 'manager'
      })
      return {
        meta: mergeMeta(state, {
          synthOnlyRepair: true,
          ...(guiSemanticBlock.failureType ? { guiSemanticBlocked: guiSemanticBlock.failureType } : {}),
        }),
      }
    }

    const guiTerminal = detectGuiTerminalFailure(state)
    if (guiTerminal.terminal) {
      opts.sendEvent({
        event: 'thinking',
        data: `自愈：GUI 终态失败（${guiTerminal.code || 'gui_terminal'}），跳过改道`,
        from: 'manager'
      })
      return {
        meta: mergeMeta(state, {
          guiTerminal: true,
          ...(guiTerminal.code ? { guiTerminalCode: guiTerminal.code } : {}),
          finalSynthPass: true
        }),
        fixQuery: '',
        fixIntent: undefined
      }
    }

    const question = effectiveUserTask(state.messages as any, state.routedQuery)
    const advice = state.fixQuery || ''
    const results = state.results || {}
    const pinGui =
      String(state.intent || '') === 'gui' ||
      String(state.fixIntent || '') === 'gui' ||
      hasFailedGuiEvidenceInRun(state)
    const fixPrompt = [
      new SystemMessage(
        [
          '你是一个高级自愈策略官。之前的 Agent 协作失败或审计未通过，你需要根据审计建议决定下一步修复方案。',
          '',
          '### 失败背景：',
          `1. 审计建议：${advice}`,
          `2. 已有数据源摘要：${Object.keys(results).join(', ')}`,
          '',
          '### 策略选项：',
          '1. **更正查询 (Refine Query)**：如果审计说漏掉事实，请生成更具体的查询。',
          '2. **切换 Agent (Switch Agent)**：仅当原能力明显不适用时才切换；GUI 浏览器任务失败时禁止改道 db/rag，必须保持 intent=gui。',
          '3. **重新规划 (Re-Plan)**：如果任务逻辑需要大规模调整，设置 intent 为 multi（GUI 单能力失败除外）。',
          '',
          '约束：若评估器认为 dataEvidence=yes 且本轮 evidence 已充分，禁止改道其它取数 Agent；应仅修正 query 或触发正文重汇总。',
          '约束：原 intent 为 gui 或本轮存在失败 GUI evidence 时，输出 intent 必须为 gui。',
          '',
          '输出必须是严格 JSON，示例：{"intent":"multi","query":"更具体的子任务描述","rationale":"原因"}（禁止输出 Zod/_def）'
        ].join('\n')
      ),
      new HumanMessage(`用户原始问题：${question}\n请给出修复策略 JSON：`)
    ]

    let strategy: FixStrategy = { intent: state.fixIntent || state.intent, query: advice || question }
    try {
      const r = await llmInvoke('critic', state, fixPrompt)
      const parsed = FixStrategySchema.safeParse(safeJsonParse(r.text))
      if (parsed.success) {
        strategy = parsed.data
        opts.sendEvent({ event: 'thinking', data: `自愈决策：${strategy.rationale || '执行修复步骤'}`, from: 'manager' })
      }
    } catch {
      opts.sendEvent({ event: 'thinking', data: '自愈决策：策略生成失败，执行默认修复', from: 'manager' })
    }
    if (pinGui && strategy.intent !== 'gui') {
      strategy = { ...strategy, intent: 'gui' as Intent, rationale: strategy.rationale || 'GUI 失败钉死重试 gui' }
    }

    const intent = strategy.intent
    const q = strategy.query
    if (intent === 'gui') {
      opts.sendEvent({
        event: 'thinking',
        data: '自愈：GUI 失败保持 gui 重试（由图边重跑 gui 节点）',
        from: 'manager'
      })
      return { fixIntent: 'gui' as Intent, fixQuery: q || advice || question }
    }
    if (isFixIntentBlockedByHardDown(intent, state.meta)) {
      opts.sendEvent({
        event: 'thinking',
        data: `自愈：专家 ${intent} 本轮已硬失败，跳过重复调用，仅重汇总`,
        from: 'manager'
      })
      return { meta: mergeMeta(state, { synthOnlyRepair: true }) }
    }
    if (criticRetryContradictsRunEvidence({ evaluation: state.evaluation })) {
      opts.sendEvent({
        event: 'thinking',
        data: `自愈：本轮证据已充分，忽略改道 ${intent}；仅重汇总正文`,
        from: 'manager'
      })
      return { meta: mergeMeta(state, { synthOnlyRepair: true }) }
    }
    if (intent === 'multi') {
      return { intent: 'multi' as Intent, routedQuery: q }
    }
    if (intent === 'db') {
      const existingDb = String(results.db || '').trim()
      if (existingDb && !isDbNoData(existingDb)) {
        opts.sendEvent({
          event: 'thinking',
          data: '自愈：DB 已有有效结果，跳过重复查库',
          from: 'manager'
        })
        return { meta: mergeMeta(state, { synthOnlyRepair: true }) }
      }
      const t0 = Date.now()
      const { deps: execDeps, opts: execOpts } = buildAgentExecutorBundle(
        {
          callDbAgent,
          callRagAgent,
          callCrawlerAgent,
          callCodeAgent,
          callAiAdminAgent,
          lastUserText,
          isDbNoData
        },
        {
          runId: opts.runId,
          sessionId: opts.sessionId,
          timeoutMs: Math.min(opts.timeoutMs, 45000),
          signal: opts.signal,
          dbAgentWsUrl: opts.dbAgentWsUrl,
          dbAgentHttpUrl: opts.dbAgentHttpUrl,
          dbId: opts.dbId,
          ragAgentHttpUrl: opts.ragAgentHttpUrl,
          crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
          codeAgentWsUrl: opts.codeAgentWsUrl,
          aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
          sendEvent: opts.sendEvent
        }
      )
      const outcome = await executeDbStep(execDeps, execOpts, {
        state,
        effQuery: q,
        timeoutMs: Math.min(opts.timeoutMs, 45000),
        sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'db' }),
        llmInvoke
      })
      await appendMetrics({ runId: opts.runId, phase: 'db', ms: Date.now() - t0 })
      if (!outcome.ok) {
        emitTrace({ type: 'fix_end', agent: 'db', status: 'error', error: outcome.error, at: new Date().toISOString() })
        return { meta: mergeMeta(state, { fixFailed: true }) }
      }
      const dbEvidence = outcome.evidence ?? { kind: 'db', query: q }
      emitTrace({ type: 'fix_end', agent: 'db', status: 'ok', evidence: dbEvidence, outputSummary: summarize(String(outcome.output ?? '')), at: new Date().toISOString() })
      return { results: { ...(state.results || {}), db: String(outcome.output ?? '') }, evidence: [dbEvidence] }
    }
    if (intent === 'rag') {
      let ragEvidence: any = null
      const ragRes = await callRagAgent({
        ragAgentHttpUrl: opts.ragAgentHttpUrl,
        timeoutMs: Math.min(opts.timeoutMs, 45000),
        message: q,
        userId: opts.userId,
        traceId: opts.runId,
        sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'rag' }),
        sendDelta: (d: string) => opts.sendEvent({ event: 'delta', data: d, from: 'rag' }),
        signal: opts.signal,
        onEvidence: (e: any) => (ragEvidence = e)
      })
      const res = unwrapAgentCall(ragRes).answer
      if (!ragEvidence) ragEvidence = await probeRagEvidence(q)
      emitTrace({ type: 'fix_end', agent: 'rag', status: 'ok', evidence: ragEvidence, outputSummary: summarize(res), at: new Date().toISOString() })
      return { results: { ...(state.results || {}), rag: res }, evidence: ragEvidence ? [ragEvidence] : [] }
    }
    if (intent === 'crawler') {
      const t0 = Date.now()
      const inv = crawlerInvokeFromState(q, lastUserText(state.messages), state.meta)
      const res = await callCrawlerAgent({
        crawlerAgentWsUrl: opts.crawlerAgentWsUrl,
        timeoutMs: opts.timeoutMs,
        task: inv.task,
        managerTask: inv.managerTask,
        sessionId: opts.sessionId,
        history: buildCrawlerHistoryFromMessages(state.messages),
        options: { maxItems: inv.maxItems ?? 10 },
        sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'crawler' }),
        signal: opts.signal
      })
      await appendMetrics({ runId: opts.runId, phase: 'crawler', ms: Date.now() - t0 })
      const crawlerClarify = parseCrawlerClarifyPayload(res)
      const patch = crawlerTaskPlanPatch(res, q)
      const answer = buildCrawlerResultForManager(res, inv.task)
      const crawlerEvidence = { kind: 'crawler' as const, query: q }
      emitTrace({ type: 'fix_end', agent: 'crawler', status: 'ok', evidence: crawlerEvidence, outputSummary: summarize(answer), at: new Date().toISOString() })
      return {
        results: { ...(state.results || {}), crawler: answer },
        evidence: [crawlerEvidence],
        meta: crawlerClarify.needsClarify
          ? mergeMeta(state, { needsClarify: true, clarifyQuestions: crawlerClarify.questions, uncertainty: 'high' })
          : undefined,
        taskPlan: patch
          ? mergeTaskPlan(
              state.taskPlan ?? null,
              {
                ...patch,
                needsClarification: crawlerClarify.needsClarify,
                clarificationQuestions: crawlerClarify.questions
              },
              state.intent,
              getEffectivePlanSteps(state as any)
            )
          : (state.taskPlan ?? null)
      }
    }
    if (intent === 'code') {
      const t0 = Date.now()
      const upstreamContext = buildUpstreamContextFromResults(state.results || {})
      const managerTask =
        buildManagerCodeTaskPayload({
          question: q,
          upstreamContext,
          taskKind: upstreamContext ? 'compute' : undefined,
        }) ?? undefined
      const priorCodeEv = (Array.isArray(state.evidence) ? state.evidence : []).find(
        (e: any) => String(e?.kind || '') === 'code',
      )
      const fixHint = buildCodeFixHintFromMeta(priorCodeEv as any)
      const fixQuery = fixHint ? `${q}\n\n修复提示：${fixHint}` : q
      const { answer: codeAnswer, meta: codeMeta } = await callCodeAgent({
        codeAgentWsUrl: opts.codeAgentWsUrl,
        timeoutMs: opts.timeoutMs,
        message: fixQuery,
        managerTask,
        threadId: opts.threadId,
        traceId: opts.runId,
        sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'code' }),
        sendDelta: (d: string) => opts.sendEvent({ event: 'delta', data: d, from: 'code' }),
        signal: opts.signal
      })
      await appendMetrics({ runId: opts.runId, phase: 'code', ms: Date.now() - t0 })
      const codeClarify = parseCodeClarifyFromMeta(codeMeta)
      const codeEvidence = {
        kind: 'code' as const,
        query: q,
        threadId: opts.threadId,
        ...buildCodeEvidenceExtras(codeMeta),
      }
      emitTrace({
        type: 'fix_end',
        agent: 'code',
        status: 'ok',
        evidence: codeEvidence,
        outputSummary: summarize(codeAnswer),
        at: new Date().toISOString()
      })
      return {
        results: { ...(state.results || {}), code: codeAnswer },
        evidence: [codeEvidence],
        ...(codeClarify.needsClarify
          ? {
              meta: mergeMeta(state, {
                needsClarify: true,
                clarifyQuestions: codeClarify.questions,
                uncertainty: 'high',
              }),
            }
          : {}),
      }
    }
    if (intent === 'admin') {
      const t0 = Date.now()
      const { deps: execDeps, opts: execOpts } = buildAgentExecutorBundle(
        {
          callDbAgent,
          callRagAgent,
          callCrawlerAgent,
          callCodeAgent,
          callAiAdminAgent,
          lastUserText,
          isDbNoData
        },
        {
          runId: opts.runId,
          sessionId: resolveManagerAgentSessionId(opts),
          timeoutMs: Math.min(opts.timeoutMs, 45000),
          signal: opts.signal,
          aiAdminAgentWsUrl: opts.aiAdminAgentWsUrl,
          sendEvent: opts.sendEvent
        }
      )
      const outcome = await executeAdminStep(execDeps, execOpts, {
        state,
        effQuery: q,
        timeoutMs: Math.min(opts.timeoutMs, 45000),
        sendThinking: (t: string) => opts.sendEvent({ event: 'thinking', data: t, from: 'admin' }),
        llmInvoke
      })
      await appendMetrics({ runId: opts.runId, phase: 'admin', ms: Date.now() - t0 })
      if (!outcome.ok) {
        emitTrace({ type: 'fix_end', agent: 'admin', status: 'error', error: outcome.error, at: new Date().toISOString() })
        return { meta: mergeMeta(state, { fixFailed: true }) }
      }
      const adminEvidence = outcome.evidence ?? { kind: 'admin', query: q }
      emitTrace({ type: 'fix_end', agent: 'admin', status: 'ok', evidence: adminEvidence, outputSummary: summarize(String(outcome.output ?? '')), at: new Date().toISOString() })
      return { results: { ...(state.results || {}), admin: String(outcome.output ?? '') }, evidence: [adminEvidence] }
    }
    if (intent === 'clean' || intent === 'visualize' || intent === 'report') {
      const t0 = Date.now()
      const mergedResults = { ...(state.results || {}) } as Record<string, unknown>
      if ((intent === 'visualize' || intent === 'report') && hasCodeInResults(mergedResults)) {
        const codeModel = createCodeAuthorityLlmModel({
          openaiApiKey: (opts as { openaiApiKey?: string }).openaiApiKey,
          openaiBaseUrl: (opts as { openaiBaseUrl?: string }).openaiBaseUrl,
          modelName: String(state.resources?.modelLowCost ?? (opts as { openaiModel?: string }).openaiModel ?? '')
        })
        const auth = await tryCodeAuthorityDownstreamOutput(intent, mergedResults, extractStructuredPayload, q, codeModel, {
          meta: state.meta,
          planSteps: state.plan
        })
        if (auth) {
          await appendMetrics({ runId: opts.runId, phase: intent, ms: Date.now() - t0 })
          const ev = { kind: intent, query: q, mode: auth.mode }
          emitTrace({ type: 'fix_end', agent: intent, status: 'ok', evidence: ev, outputSummary: summarize(auth.output), at: new Date().toISOString() })
          return {
            results: { ...mergedResults, [intent]: auth.output },
            evidence: [ev]
          }
        }
      }
      const context = Object.entries(state.results || {})
        .map(([k, v]) => `${k}:\n${String(v ?? '').slice(0, 1200)}`)
        .join('\n\n')
      const out = await runInternalAgent(intent, q, state, context)
      const answer = typeof out === 'string' ? out : out.answer
      await appendMetrics({ runId: opts.runId, phase: intent, ms: Date.now() - t0 })
      const ev = { kind: intent, query: q }
      emitTrace({ type: 'fix_end', agent: intent, status: 'ok', evidence: ev, outputSummary: summarize(answer), at: new Date().toISOString() })
      return {
        results: { ...(state.results || {}), [intent]: answer },
        evidence: [ev],
        resources: typeof out === 'string' ? state.resources : out.resources,
        meta: typeof out === 'string' ? state.meta : out.meta
      } as any
    }
    return {}
  }
}

