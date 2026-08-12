/**
 * Wave6 K6：路由权威链快照 — 供 Trace / metrics 排障三问（路由错？）。
 * 不做 cap 决策；只汇总已有契约字段。
 */
import { sourceCommitmentFromRaw } from './sourceCommitment'
import {
  isSingleSourceDbTask,
  isSingleSourceRagTask,
  isTrueMultiTask
} from '../core/routing/subAgentPassthrough'

export type RouteAuthorityChain = {
  sourceCommitment: string
  committedPlanes: string[]
  webFetchKind: string
  turnScopeMode: string
  turnKind: string
  singleSourcePassthrough: boolean
  trueMulti: boolean
  allowedAgents: string[]
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
  return {
    sourceCommitment: slice.sourceCommitment,
    committedPlanes: [...slice.committedPlanes],
    webFetchKind: slice.webFetchKind,
    turnScopeMode,
    turnKind,
    singleSourcePassthrough,
    trueMulti: isTrueMultiTask(meta),
    allowedAgents: agents
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
    goldenHit: null as boolean | null
  }
}
