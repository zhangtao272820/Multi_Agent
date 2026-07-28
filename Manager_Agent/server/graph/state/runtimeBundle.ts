import type { ChatOpenAI } from '@langchain/openai'
import { redactSecrets as scrubSecretsForSynth } from '#agent-shared/redact'
import {
  createManagerChatOpenAI,
  callAiAdminAgent,
  callCodeAgent,
  callCrawlerAgent,
  callLobsterAgent,
  callDbAgent,
  callMultimodalAgent,
  callMusicAgent,
  callVideoAgent,
  callRagAgent,
  fetchDbTaskPlan,
  ragProbeTimeoutMs,
  buildAgentTraceHeaders,
  EntitiesSchema,
  ForceIntentSchema,
  IntentSchema,
  PlanSchema,
  RouteSchema,
  StepSchema,
  normalizeEntities,
  type ForceIntent,
  type Intent,
  type Step,
  type TaskPlan,
  createRagRelevanceJudge,
  createRagEvidenceMatchJudge,
  createRagScopeHintJudge
} from './wireGraphUtilsDeps'
import { Annotation } from '@langchain/langgraph'
import { BaseMessage } from '@langchain/core/messages'
import { z } from 'zod'
import {  clampNumber,
  defaultPolicy,
  extractStructuredPayload,
  extractTotalTokens,
  loadManagerPolicy,
  loadManagerPolicyShadow,
  maybeUpdateManagerPolicy,
  readHistoryEntries,
  safeJsonParse,
  sanitizeUntrustedText,
  summarizeManagerPolicyDiff
} from '../core/shared'
import { buildStepContext, buildTaskPlan, enforcePlanConstraints, enforcePlanCoverage, getEffectivePlanSteps, mergeTaskPlan, normalizePlanSteps, type TaskConstraints } from '../core/plan'
import { appendConstraintsToQuery, crawlerTaskPlanPatch, deriveScenarioKey, estimateTokensFromMessages, estimateTokensFromText, filterCrawlerResultDomestic, hasStrongDbAnchor, isCapabilityOutOfScope, isExplicitMultiRequest, lastUserText, needsDataFoundation, normalizeFinalUserText, parseCrawlerClarifyPayload, parseRagClarifyPayload, percentile, shouldPreferMulti, stripLatexMath, uncertaintyFromConfidence } from '../core/text'
import { createPlanPreviewNode } from '../nodes/planPreview'
import { compileManagerGraph } from './graph'
import { getManagerLangGraphCheckpointer } from '../core/runtime/langgraphCheckpointer'
import { createFixNode } from '../nodes/fix'
import { createExecutionNodes } from '../nodes/exec'
import { createMultiNode } from '../nodes/multi'
import { createFinalNodes } from '../nodes/final'
import { appendMemory, appendMetrics, appendNluMetrics, appendPolicyShadowObserve, isDbNoData, readFeedbackForRun } from '../core/runtime/runtimePersistence'
import { buildClarifyQuestionsFromContext } from '../core/plan/clarifyContext'
import { createPlanLinterNode } from '../nodes/planLinter'
import { createResourceNode } from '../nodes/resource'
import { createToolHealthNode } from '../nodes/toolHealth'
import { createTurnScopeNode } from '../nodes/turnScope'
import { createProbeNode } from '../nodes/probe'
import { createClarifyNode, createMetacogNode } from '../nodes/meta'
import { createRouterNode } from '../nodes/router'
import { createDecomposeNode } from '../nodes/decompose'
import { createIntentClassifyNode } from '../nodes/intentClassify'
import { createOrchestrateNode } from '../nodes/orchestrate'
import { createWebSearchNode } from '../nodes/search'
import { createPrefetchNode } from '../nodes/prefetch'
import { createPlanNode } from '../nodes/plan'
import { analyzePlanQualityFromMemory, planQualityHintForPlanner, recordPlanOutcome } from '../core/plan/planQuality'
import { createManagerRuntime } from '../core/runtime/runtime'
import { createInternalCollaborators } from '../core/runtime/internalCollaborators'
import { createSecurityNode } from '../nodes/security'
import { createSchedulerNode } from '../nodes/scheduler'
import { createMonitorNode } from '../nodes/monitor'
import { createEvaluatorNode } from '../nodes/evaluator'
import { createOptimizerNode } from '../nodes/optimizer'
import { createExecutionModeNode } from '../nodes/mode'
import { createVoteAggregatorNode } from '../nodes/voteAggregator'
import { resolveEffectiveManagerPolicy } from '../core/evolution/policyCanary'
import { shouldSuppressCanaryForSession } from '../core/routing/routeStrategy'
import fs from 'node:fs/promises'
import path from 'node:path'
import { traceable } from 'langsmith/traceable'

import { GraphState, FixStrategySchema } from './graphAnnotation'
import {
  buildClarifyQuestions,
  readEnvNumber,
  readEnvString,
  type ExperienceIndex,
  type SendEvent
} from './graphFactoryHelpers'


export type ManagerGraphRuntimeBundle = {
  summarize: (text: string, max?: number) => string
  formatReferences: (evidence: any[]) => string
  redactSecrets: (text: string) => string
  emitTrace: (data: any, from?: string) => void
  runInternalAgent: ReturnType<typeof createInternalCollaborators>['runInternalAgent']
  runAlwaysInternalCollaborators: ReturnType<typeof createInternalCollaborators>['runAlwaysInternalCollaborators']
  fetchJson: (url: string, body: any, timeoutMs: number) => Promise<any>
  ragEvidenceFromProbe: (query: string, probe: any) => any
  probeRagEvidence: (query: string) => Promise<any>
}

export function buildManagerGraphRuntimeBundle(input: {
  opts: {
    sendEvent: (event: { event: string; data?: any; from?: string }) => void
    runId: string
    userId?: string
    signal?: AbortSignal
    ragAgentHttpUrl: string
  }
  ensureNotAborted: () => void
  getModel: (modelName: string, temperature?: number) => ChatOpenAI
  traceRun: <T>(name: string, fn: () => Promise<T>, extra?: Record<string, any>) => Promise<T>
  mergeResources: (state: any, patch: Partial<any>) => any
  appendMetrics: typeof appendMetrics
  timeLeftMs: (resources: any) => number
}): ManagerGraphRuntimeBundle {
  const { opts, ensureNotAborted, getModel, traceRun, mergeResources, appendMetrics, timeLeftMs } = input
    const summarize = (text: string, max = 260) => {
      const s = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (!s) return ''
      return s.length > max ? `${s.slice(0, max)}…` : s
    }

    const formatReferences = (evidence: any[]) => {
      const items: { source: string; title?: string; url?: string; page?: number; chunkId?: string }[] = []
      for (const e of Array.isArray(evidence) ? evidence : []) {
        if (e?.kind === 'rag') {
          const citations = Array.isArray(e?.citations) ? e.citations : []
          for (const c of citations) {
            const source = String(c?.source ?? '').trim()
            if (!source) continue
            items.push({
              source,
              title: typeof c?.title === 'string' ? c.title : undefined,
              url: typeof c?.url === 'string' ? c.url : undefined,
              page: typeof c?.page === 'number' ? c.page : undefined,
              chunkId: typeof c?.chunkId === 'string' ? c.chunkId : undefined
            })
          }
          continue
        }
        if (e?.kind === 'crawler') {
          const url = String(e?.url ?? e?.query ?? '').trim()
          if (url && /^https?:\/\//i.test(url)) {
            items.push({ source: 'crawler', title: String(e?.title ?? url).trim(), url })
          }
          const crawlItems = Array.isArray(e?.items) ? e.items : []
          for (const it of crawlItems) {
            const u = String(it?.url ?? it?.link ?? '').trim()
            if (!u) continue
            items.push({
              source: String(it?.source ?? 'crawler').trim() || 'crawler',
              title: String(it?.title ?? it?.name ?? u).trim(),
              url: u
            })
          }
        }
      }
      const seen = new Set<string>()
      const lines: string[] = []
      for (const it of items) {
        const key = `${it.source}|${it.page ?? ''}|${it.chunkId ?? ''}|${it.url ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const label = it.title?.trim() ? it.title.trim() : it.source
        const suffix = [it.page ? `p.${it.page}` : '', it.url ? it.url : ''].filter(Boolean).join(' ')
        lines.push(suffix ? `- ${label} (${suffix})` : `- ${label}`)
        if (lines.length >= 8) break
      }
      if (!lines.length) return ''
      return `\n\n[参考来源]\n${lines.join('\n')}`
    }

    const redactSecrets = (text: string) => scrubSecretsForSynth(String(text ?? ''))

    const emitTrace = (data: any, from = 'manager') => {
      try {
        opts.sendEvent({ event: 'trace', data, from })
      } catch {}
    }

    const { runInternalAgent, runAlwaysInternalCollaborators } = createInternalCollaborators({
      opts,
      getModel,
      traceRun,
      extractTotalTokens,
      estimateTokensFromMessages,
      estimateTokensFromText,
      mergeResources,
      appendMetrics,
      timeLeftMs,
      extractStructuredPayload,
      emitTrace,
      summarize
    })

    const fetchJson = async (url: string, body: any, timeoutMs: number) => {
      ensureNotAborted()
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs))
      const onAbort = () => ctrl.abort()
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAgentTraceHeaders(opts.runId, { userId: opts.userId }),
            'x-manager-orchestrated': '1'
          },
          body: JSON.stringify(body ?? {}),
          signal: ctrl.signal
        })
        const ct = String(res.headers.get('content-type') || '').toLowerCase()
        if (!ct.includes('application/json')) return null
        return (await res.json().catch(() => null)) as any
      } finally {
        clearTimeout(t)
        try {
          opts.signal?.removeEventListener('abort', onAbort)
        } catch {}
      }
    }

    const ragEvidenceFromProbe = (query: string, probe: any) => {
      const hits = typeof probe?.hits === 'number' ? probe.hits : undefined
      const sources = Array.isArray(probe?.sources) ? probe.sources.map((s: any) => String(s)).filter(Boolean) : []
      if (!sources.length && typeof hits !== 'number') return null
      return { kind: 'rag' as const, query, hits, citations: sources.map((s: string) => ({ source: s })) }
    }

    const probeRagEvidence = async (query: string) => {
      const ragUrl = `${String(opts.ragAgentHttpUrl || '').replace(/\/+$/, '')}/api/probe`
      const data = await fetchJson(ragUrl, { query, k: 8 }, ragProbeTimeoutMs()).catch(() => null)
      return ragEvidenceFromProbe(query, data)
    }
  return { summarize, formatReferences, redactSecrets, emitTrace, runInternalAgent, runAlwaysInternalCollaborators, fetchJson, ragEvidenceFromProbe, probeRagEvidence }
}
