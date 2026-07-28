import { prefetchDbTaskPlan, shouldPrefetchDbPlan, formatDbPrefetchForPlanner } from '../../core/db/dbPrefetch'
import {
  formatRagPrefetchForPlanner,
  isAgentPrefetchEnabled,
  prefetchRagRetrieve,
  shouldPrefetchRagRetrieve
} from '../../core/rag/ragPrefetch'
import { formatPrefetchTargets, resolvePrefetchTargets } from '../../core/probe/prefetchGate'
import { resolveRagPrefetchLeanQuery } from '../../core/probe/retrieverPlan'
import { ragPrefetchTimeoutMs, dbPrefetchTimeoutMs } from '../../core/probe/probeConfig'
import { effectiveUserTask, lastUserText } from '../../core/text'
import { resolveDbPrefetchQuestionFromState } from '../../core/db/dbStepQuestion'

function resolveRagPrefetchQuestion(state: any, lastUser: string, question: string): string {
  const blueprint = (state.meta?.planBlueprint as { steps?: Array<{ agent?: string; queryFocus?: string }> } | undefined)
    ?.steps?.find((s) => String(s?.agent || '').trim() === 'rag')
  const planRagFocus = String(blueprint?.queryFocus || '').trim()
  return (
    resolveRagPrefetchLeanQuery({
      lastUser,
      planRagFocus,
      routedQuery: String(state.routedQuery || question || '').trim(),
      coalescedTask: String(state.meta?.coalescedTask || '').trim()
    }) || lastUser
  )
}

import type { CreatePrefetchNodeDeps } from './types'

export function createPrefetchNode(deps: CreatePrefetchNodeDeps) {
  const { opts, mergeMeta, appendMetrics } = deps

  return async (state: any) => {
    if (!isAgentPrefetchEnabled()) {
      return { meta: mergeMeta(state, { prefetchMode: 'off' as const }) }
    }

    const lastUser = lastUserText(state.messages as any)
    const question = effectiveUserTask(state.messages as any, state.routedQuery)

    const targets = resolvePrefetchTargets(state)
    const wantDb =
      targets.db &&
      String(opts.dbAgentHttpUrl ?? '').trim() &&
      shouldPrefetchDbPlan({
        intent: state.intent,
        allowedAgents: state.allowedAgents,
        meta: state.meta,
        routedQuery: String(state.routedQuery || question),
        messages: state.messages
      }, lastUser, question)
    const wantRag = targets.rag && String(opts.ragAgentHttpUrl ?? '').trim()

    if (!wantDb && !wantRag) {
      return { meta: mergeMeta(state, { prefetchMode: 'skip' as const, prefetchTargets: targets }) }
    }

    const ragPrefetchQuestion = resolveRagPrefetchQuestion(state, lastUser, question)
    const planRagStep = (state.meta?.planBlueprint as { steps?: Array<{ agent?: string; queryFocus?: string }> } | undefined)
      ?.steps?.find((s) => String(s?.agent || '').trim() === 'rag')
    const dbPrefetchQuestion = resolveDbPrefetchQuestionFromState(state, lastUser, question)
    const ragPrefetchTimeout = ragPrefetchTimeoutMs()
    const dbPrefetchTimeout = dbPrefetchTimeoutMs()
    const labels: string[] = []
    if (wantDb) labels.push('DB plan')
    if (wantRag) labels.push('RAG retrieve')

    opts.sendEvent({ event: 'phase', data: 'prefetch', from: 'manager' })
    const mode =
      wantDb && wantRag ? `${labels.join(' ∥ ')} 并行执行` : labels.join('')
    opts.sendEvent({
      event: 'thinking',
      data: `预取：${mode}（路由 allowedAgents 需 ${formatPrefetchTargets(targets)}）；等待完成后再执行子 Agent…`,
      from: 'manager'
    })

    const t0 = Date.now()
    const [dbRes, ragRes] = await Promise.all([
      wantDb
        ? prefetchDbTaskPlan({
            dbAgentHttpUrl: String(opts.dbAgentHttpUrl),
            question: dbPrefetchQuestion,
            timeoutMs: dbPrefetchTimeout,
            dbId: opts.dbId,
            traceId: opts.runId,
            managerTask: {
              source: 'manager',
              refined_question: dbPrefetchQuestion,
              must_filters: [],
              schema_search_keywords: ''
            }
          })
        : Promise.resolve(null),
      wantRag
        ? prefetchRagRetrieve({
            ragAgentHttpUrl: String(opts.ragAgentHttpUrl),
            question: ragPrefetchQuestion,
            lastUserMessage: lastUser,
            timeoutMs: ragPrefetchTimeout,
            userId: opts.userId,
            traceId: opts.runId,
            coalescedTask: String(state.meta?.coalescedTask || state.routedQuery || '').trim(),
            turnScopeMode: String(state.meta?.turnScopeMode || '').trim() || null,
            turnKind: String(state.meta?.turnKind || '').trim() || null,
            planRagFocus: String(planRagStep?.queryFocus || '').trim(),
            probeRag: state.probe?.rag ?? null
          })
        : Promise.resolve(null)
    ])

    const metaPatch: Record<string, unknown> = {
      prefetchMode: 'done' as const,
      prefetchMs: Date.now() - t0,
      prefetchTargets: targets
    }
    const notes: string[] = []

    if (dbRes) {
      metaPatch.dbPlanPrefetch = { ...dbRes, question: dbPrefetchQuestion }
      const dbBlock = formatDbPrefetchForPlanner(dbRes)
      if (dbBlock) metaPatch.dbPrefetchPlannerHint = dbBlock
      const unified = dbRes.unified_task_plan as {
        hints?: { suggested_tables?: string[] }
        entities?: { names?: string[]; locations?: string[] }
        prefetch_ready?: boolean
      } | null | undefined
      const tables = (unified?.hints?.suggested_tables ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
      const names = (unified?.entities?.names ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
      const locations = (unified?.entities?.locations ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
      if (dbRes.ok) {
        const parts: string[] = [`DB plan ${dbRes.ms}ms`]
        if (unified?.prefetch_ready) parts.push('可复用 plan+schema')
        if (tables.length) parts.push(`表 ${tables.slice(0, 3).join('、')}`)
        if (locations.length) parts.push(`地区 ${locations.slice(0, 2).join('、')}`)
        if (names.length) parts.push(`实体 ${names.slice(0, 2).join('、')}`)
        notes.push(parts.join(' · '))
      } else if (dbRes.error) {
        notes.push(`DB plan 失败：${dbRes.error}`)
      } else {
        notes.push(`DB plan ${dbRes.ms}ms（无 unified_task_plan）`)
      }
      if (appendMetrics && opts.runId) {
        await appendMetrics({
          runId: opts.runId,
          phase: 'db_plan_prefetch',
          ms: dbRes.ms,
          extra: { ok: dbRes.ok, parallelWith: wantRag ? 'rag_retrieve_prefetch' : 'none' }
        }).catch(() => undefined)
      }
    }

    if (ragRes) {
      metaPatch.ragRetrievePrefetch = ragRes
      const block = formatRagPrefetchForPlanner(ragRes)
      if (block) metaPatch.ragPrefetchPlannerHint = block
      if (ragRes.hardFailure) {
        const code = String(ragRes.error_code || 'network').trim() || 'network'
        const prev = (metaPatch.expertHardDown && typeof metaPatch.expertHardDown === 'object'
          ? metaPatch.expertHardDown
          : {}) as Record<string, string>
        metaPatch.expertHardDown = { ...prev, rag: code }
      }
      if (ragRes.ok) {
        const fromProbeCache = (ragRes.ms ?? 0) < 80 && Number(ragRes.hits ?? 0) > 0
        const preview = (ragRes.evidence || [])
          .slice(0, 2)
          .map((e) => {
            const src = String(e.source || 'doc').trim()
            const body = String(e.content || '').replace(/\s+/g, ' ').trim().slice(0, 80)
            return body ? `${src}：${body}` : src
          })
          .filter(Boolean)
        notes.push(
          preview.length
            ? `RAG ${ragRes.ms}ms（${ragRes.hits ?? 0} 条${fromProbeCache ? '·probe' : ''}）· ${preview.join('；')}`
            : `RAG ${ragRes.ms}ms（${ragRes.hits ?? 0} 条${fromProbeCache ? '·probe' : ''}）`
        )
      } else if (ragRes.error) {
        notes.push(`RAG 失败：${ragRes.error}${ragRes.query ? `｜q=${String(ragRes.query).slice(0, 48)}` : ''}`)
      } else if (ragRes.needsClarify) {
        notes.push(`RAG ${ragRes.ms}ms（需澄清，0 条）${ragRes.query ? `｜q=${String(ragRes.query).slice(0, 48)}` : ''}`)
      } else {
        notes.push(`RAG ${ragRes.ms}ms（0 条命中）`)
      }
      if (appendMetrics && opts.runId) {
        await appendMetrics({
          runId: opts.runId,
          phase: 'rag_retrieve_prefetch',
          ms: ragRes.ms,
          extra: { ok: ragRes.ok, hits: ragRes.hits ?? 0, parallelWith: wantDb ? 'db_plan_prefetch' : 'none' }
        }).catch(() => undefined)
      }
    }

    opts.sendEvent({
      event: 'thinking',
      data: notes.length
        ? `预取完成（${Date.now() - t0}ms）：${notes.join('；')}`
        : `预取完成（${Date.now() - t0}ms）`,
      from: 'manager'
    })

    return { meta: mergeMeta(state, metaPatch) }
  }
}

