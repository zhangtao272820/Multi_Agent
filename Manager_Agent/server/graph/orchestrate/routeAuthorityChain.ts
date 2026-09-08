/**
 * Wave6 K6：路由权威链快照 — 供 Trace / metrics 排障三问（路由错？）。
 * 不做 cap 决策；只汇总已有契约字段。
 * Phase0：扩展 thickness / skips / routeLlmCalls 供成熟化 SLI。
 */
import { sourceCommitmentFromRaw } from './sourceCommitment'
import {
  isSingleSourceDbTask,
  isSingleSourceRagTask,
  isTrueMultiTask
} from '../core/routing/subAgentPassthrough'
import { shouldSkipPostSynthAudit } from '../core/routing/orchestrationThickness'
import {
  buildRouteSkipsSnapshot,
  estimateRouteLlmCalls
} from '../core/routing/routeSkipCascade'

export type RouteAuthorityChain = {
  sourceCommitment: string
  committedPlanes: string[]
  webFetchKind: string
  turnScopeMode: string
  turnKind: string
  singleSourcePassthrough: boolean
  trueMulti: boolean
  allowedAgents: string[]
  /** Phase0 */
  orchestrationThickness: string
  orchestratorSource: string
  routeSkips: Record<string, boolean>
  routeLlmCalls: number
  /** 轻量看图 SLI */
  routeCaptionMs?: number
  routeCaptionChars?: number
  routeCaptionSource?: string
  localReplanCount?: number
}

export function buildRouteAuthorityChain(input: {
  meta?: unknown
  raw?: Record<string, unknown> | null
  turnScopeMode?: string | null
  turnKind?: string | null
  allowedAgents?: string[] | null
}): RouteAuthorityChain {
  const meta = (input.meta && typeof input.meta === 'object' ? input.meta : {}) as Record<string, unknown>
  const raw =
    input.raw && typeof input.raw === 'object'
      ? input.raw
      : (meta as { orchestratorRaw?: Record<string, unknown> }).orchestratorRaw || meta
  const slice = sourceCommitmentFromRaw(raw as Record<string, unknown>)
  const agents = (input.allowedAgents ?? (Array.isArray(meta.allowedAgents) ? meta.allowedAgents : []))
    .map((a) => String(a || '').trim())
    .filter(Boolean)
  const turnScopeMode = String(
    input.turnScopeMode ?? meta.turnScopeMode ?? ''
  ).trim() || 'current_only'
  const turnKind = String(input.turnKind ?? meta.turnKind ?? '').trim() || 'new_task'
  const singleSourcePassthrough =
    isSingleSourceDbTask(meta) || isSingleSourceRagTask(meta)

  const orchestrationThickness = String(meta.orchestrationThickness || '').trim() || 'complex'
  const orchestratorSource = String(meta.orchestratorSource || '').trim()
  const priorSkips =
    meta.routeSkips && typeof meta.routeSkips === 'object'
      ? (meta.routeSkips as Record<string, boolean>)
      : null
  const routeSkips =
    priorSkips ??
    buildRouteSkipsSnapshot({
      skipAlign: Boolean(meta.routeSkipAlign),
      skipPlane: Boolean(meta.routeSkipPlane),
      skipWebAlign: Boolean(meta.routeSkipWebAlign),
      plannerBypassed: Boolean(meta.plannerBypassed) || orchestrationThickness === 'single_source',
      skipAudit: shouldSkipPostSynthAudit(meta)
    })

  const priorCalls = Number(meta.routeLlmCalls)
  const routeLlmCalls = Number.isFinite(priorCalls) && priorCalls > 0
    ? Math.floor(priorCalls)
    : estimateRouteLlmCalls({
        priorAuxCalls: Number(meta.routeAuxLlmCalls) || 0,
        ranOrchestratorLlm: meta.directChitchatSynth !== true && !String(orchestratorSource).includes('meta_intent'),
        skipAlign: routeSkips.align,
        skipPlane: routeSkips.plane,
        skipWebAlign: routeSkips.webAlign
      })

  const captionMs = Number(meta.routeCaptionMs)
  const captionChars = Number(meta.routeCaptionChars)
  const captionSource = String(meta.routeCaptionSource || '').trim()
  const localReplanCount = Number(meta.localReplanCount)

  return {
    sourceCommitment: slice.sourceCommitment,
    committedPlanes: [...slice.committedPlanes],
    webFetchKind: slice.webFetchKind,
    turnScopeMode,
    turnKind,
    singleSourcePassthrough,
    trueMulti: isTrueMultiTask(meta),
    allowedAgents: agents,
    orchestrationThickness,
    orchestratorSource,
    routeSkips,
    routeLlmCalls,
    ...(Number.isFinite(captionMs) && captionMs >= 0 ? { routeCaptionMs: Math.floor(captionMs) } : {}),
    ...(Number.isFinite(captionChars) && captionChars >= 0
      ? { routeCaptionChars: Math.floor(captionChars) }
      : {}),
    ...(captionSource ? { routeCaptionSource: captionSource } : {}),
    ...(Number.isFinite(localReplanCount) && localReplanCount >= 0
      ? { localReplanCount: Math.floor(localReplanCount) }
      : {})
  }
}

/** 写入 manager-metrics.jsonl 的 phase=route_authority 行（过程 SLI，无假业务%） */
export function routeAuthorityMetricExtra(chain: RouteAuthorityChain): Record<string, unknown> {
  return {
    sourceCommitment: chain.sourceCommitment,
    committedPlanes: chain.committedPlanes,
    webFetchKind: chain.webFetchKind,
    turnScopeMode: chain.turnScopeMode,
    turnKind: chain.turnKind,
    singleSourcePassthrough: chain.singleSourcePassthrough,
    trueMulti: chain.trueMulti,
    allowedAgents: chain.allowedAgents,
    orchestrationThickness: chain.orchestrationThickness,
    orchestratorSource: chain.orchestratorSource,
    routeSkips: chain.routeSkips,
    routeLlmCalls: chain.routeLlmCalls,
    ...(chain.routeCaptionMs != null ? { routeCaptionMs: chain.routeCaptionMs } : {}),
    ...(chain.routeCaptionChars != null ? { routeCaptionChars: chain.routeCaptionChars } : {}),
    ...(chain.routeCaptionSource ? { routeCaptionSource: chain.routeCaptionSource } : {}),
    ...(chain.localReplanCount != null ? { localReplanCount: chain.localReplanCount } : {}),
    goldenHit: null as boolean | null
  }
}
