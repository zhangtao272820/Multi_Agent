/**
 * Probe 结构性锚定：业务库表命中 → db 数据面（不用用户原话正则判意图）。
 * 用于「[地区]+[统计对象]分布」等未写「数据库」但 DB probe 已命中的单源问句。
 */

import type { TaskClause } from '../routing/clauses'
import { agentsFromClauses } from '../routing/clauses'
import type { IntentClassifyResult } from '../../llm/intentClassifyLlm'
import type { DataSourceAgent } from '../../orchestrate/routeOrchestration'
import { isProbeDbRoutingRelevant, type ProbeDbSlice } from './probeInterpretation'

const DATA_PLANE = new Set<string>(['db', 'rag', 'crawler'])

function dataPlanesFromClauses(clauses?: TaskClause[]): DataSourceAgent[] {
  return agentsFromClauses(clauses ?? []).filter((a) => DATA_PLANE.has(a)) as DataSourceAgent[]
}

function distinctDataPlanes(...lists: (DataSourceAgent[] | undefined)[]): number {
  const seen = new Set<DataSourceAgent>()
  for (const list of lists) {
    for (const a of list ?? []) {
      if (DATA_PLANE.has(a)) seen.add(a)
    }
  }
  return seen.size
}

/** DB probe 命中且任务非多数据面 → 锚定 isDbAnchored + db_only（抑制 RAG probe 污染） */
export function inferDbAnchorFromProbe(input: {
  classify: IntentClassifyResult
  probe?: { db?: ProbeDbSlice; rag?: { hits?: number } } | null
  clauses?: TaskClause[]
}): IntentClassifyResult {
  const { classify, probe, clauses } = input
  if (classify.isDbAnchored === true) return classify

  const ragHits = Number(probe?.rag?.hits ?? 0) || 0
  const classifyPlanes = (classify.dataSources ?? []).filter((d) => DATA_PLANE.has(d)) as DataSourceAgent[]
  const docRagTask =
    classify.primaryIntent === 'rag' ||
    classify.planShortcut === 'rag_only' ||
    (classifyPlanes.length === 1 && classifyPlanes[0] === 'rag')
  if (ragHits > 0 && docRagTask) return classify

  if (!isProbeDbRoutingRelevant(probe?.db)) return classify

  const clausePlanes = dataPlanesFromClauses(clauses)
  if (distinctDataPlanes(clausePlanes, classifyPlanes) >= 2) return classify

  const wantsRag =
    clausePlanes.includes('rag') ||
    clausesDeclareDataSource(clauses, 'rag') ||
    (classifyPlanes.includes('rag') &&
      (classify.primaryIntent === 'rag' || classify.planShortcut === 'rag_only'))
  const wantsWeb =
    clausePlanes.includes('crawler') ||
    clausesDeclareDataSource(clauses, 'crawler') ||
    (classify.needsWeb && classifyPlanes.includes('crawler'))
  const wantsPipeline =
    classify.explicitWantsVisualize ||
    classify.explicitWantsReport ||
    (classify.requiresAgentPipeline === true && distinctDataPlanes(clausePlanes, classifyPlanes) >= 2)

  if (wantsRag && !clausePlanes.includes('db') && !classifyPlanes.includes('db')) return classify
  if (wantsWeb) return classify
  if (wantsPipeline && !clausePlanes.includes('db') && !classifyPlanes.includes('db')) return classify

  return {
    ...classify,
    isDbAnchored: true,
    primaryIntent: 'db',
    planShortcut:
      classify.planShortcut === 'none' || classify.planShortcut === 'db_chart' ? 'db_only' : classify.planShortcut,
    dataSources: ['db'],
    suggestedAgents: ['db'],
    isMulti: false,
    requiresAgentPipeline: false,
    allowChatWebDirect: classify.allowChatWebDirect ?? true,
    needsWeb: false
  }
}

/** 子句已声明的数据面并入 classify.dataSources（编排 LLM 漏填时补齐） */
export function mergeDataSourcesWithClauses(
  classify: IntentClassifyResult,
  clauses?: TaskClause[]
): IntentClassifyResult {
  const ds = new Set<DataSourceAgent>(
    ((classify.dataSources ?? []) as DataSourceAgent[]).filter((d) => DATA_PLANE.has(d))
  )
  for (const a of dataPlanesFromClauses(clauses)) ds.add(a)
  if (!ds.size) return classify
  return { ...classify, dataSources: [...ds] }
}

export function clausesDeclareDataSource(clauses: TaskClause[] | undefined, source: DataSourceAgent): boolean {
  if (!clauses?.length) return false
  return clauses.some((c) => (c.agents ?? []).includes(source))
}
