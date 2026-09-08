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
import { groundFollowupQuery, shouldGroundFollowupQuery } from '#agent-shared/followupQueryGrounding'
import { sessionIntentAnchorFromMeta } from '../../core/memory/multiTurnIntent'
import { prefetchClarifySuppressMetaPatch } from '../../orchestrate/clarifyProbeGate'
import { isSingleSourceRagTask } from '../../core/routing/subAgentPassthrough'

function resolveRagPrefetchQuestion(state: any, lastUser: string, question: string): string {
  const blueprint = (state.meta?.planBlueprint as { steps?: Array<{ agent?: string; queryFocus?: string }> } | undefined)
    ?.steps?.find((s) => String(s?.agent || '').trim() === 'rag')
  const planRagFocus = String(blueprint?.queryFocus || '').trim()
  const lean =
    resolveRagPrefetchLeanQuery({
      lastUser,
      planRagFocus,
      routedQuery: String(state.routedQuery || question || '').trim(),
      coalescedTask: String(state.meta?.coalescedTask || '').trim()
    }) || lastUser
  const turnKind = String(state.meta?.turnKind || '').trim()
  const anchor = sessionIntentAnchorFromMeta(state.meta)?.coalescedTask || ''
  let grounded = lean
  if (shouldGroundFollowupQuery({ turnKind, lastUser, anchorTask: anchor })) {
    grounded = groundFollowupQuery({
      lastUser,
      turnKind,
      anchorTask: anchor,
      candidate: lean
    })
  }
  const caption = String(
    state?.mediaAttachment?.caption || state?.meta?.routeImageCaption || ''
  )
    .trim()
    .slice(0, 80)
  if (caption && grounded && !grounded.includes(caption)) {
    return `${grounded}（图意：${caption}）`.slice(0, 900)
  }
  return grounded
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
    const skipRagPrefetch = isSingleSourceRagTask({
      ...(state.meta || {}),
      allowedAgents: state.allowedAgents,
      intent: state.intent,
    })
    const wantRag =
      targets.rag && String(opts.ragAgentHttpUrl ?? '').trim() && !skipRagPrefetch

    if (!wantDb && !wantRag) {
      if (skipRagPrefetch && targets.rag) {
        opts.sendEvent({
          event: 'thinking',
          data: '预取：单源 RAG 跳过 retrieve（执行步直连 /api/chat）',
          from: 'manager',
        })
      }
      return {
        meta: mergeMeta(state, {
          prefetchMode: skipRagPrefetch && targets.rag ? ('single_source_rag_skip' as const) : ('skip' as const),
          prefetchTargets: targets,
          ...(skipRagPrefetch && targets.rag ? { ragPrefetchSkipped: 'single_source_direct_chat' } : {}),
        }),
      }
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
    else if (skipRagPrefetch && targets.rag) labels.push('RAG 预取跳过（单源直连）')

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
            traceId: opts.runId
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
      // 透传协议：Planner 永不下发表名，避免步骤文案锁错表
      const dbBlock = formatDbPrefetchForPlanner(dbRes, { omitTableHints: true })
      if (dbBlock) metaPatch.dbPrefetchPlannerHint = dbBlock
      const unified = dbRes.unified_task_plan as {
        hints?: { suggested_tables?: string[] }
        entities?: { names?: string[]; locations?: string[] }
        prefetch_ready?: boolean
      } | null | undefined
      const names = (unified?.entities?.names ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
      const locations = (unified?.entities?.locations ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
      if (dbRes.ok) {
        const parts: string[] = [`DB plan ${dbRes.ms}ms`]
        if (unified?.prefetch_ready) parts.push('可复用 plan')
        parts.push('选表交 DB 自举')
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

    const clarifyKill = prefetchClarifySuppressMetaPatch(
      { ...(state.meta || {}), ...metaPatch } as Record<string, unknown>,
      ragRes
    )
    if (clarifyKill) {
      Object.assign(metaPatch, clarifyKill)
      opts.sendEvent({
        event: 'thinking',
        data: '预取已命中文档证据，取消 slot 澄清，继续执行检索专家。',
        from: 'manager'
      })
    }

    return { meta: mergeMeta(state, metaPatch) }
  }
}

