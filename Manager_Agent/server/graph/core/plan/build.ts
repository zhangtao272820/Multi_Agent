import { TaskPlanSchema, normalizeEntities, type Step, type TaskPlan, type Intent } from '../../../utils/shared/taskPlan'
import { extractStructuredPayload } from '../shared'
import {
  isActionExecAgent,
  isUpstreamClarifyNoise,
  shouldIncludeUpstreamDepForStep,
  shouldPassUpstreamMissing
} from '../stepIsolation'
import { appendConstraintsToDbAgentQuery, appendConstraintsToQuery } from '../text'
import {
  ensureCodeInPipelineAgents,
  isPipelineAutoCleanEnabled,
  isPipelineAutoCodeEnabled,
  needsCleanProcessing,
  needsCodeProcessing,
  PIPELINE_AGENT_ORDER,
  planNeedsCleanProcessingLayer,
  planNeedsCodeProcessingLayer,
  shouldRetainCleanStep,
  shouldRetainCodeStep,
  sortAgentsByPipelineOrder,
  type PipelinePlanOpts
} from '../routing/clauses'
import { enforceSemanticDependsOn, assignOutputParallelGroups } from './planParallel'
import { validateAndPreparePlan } from './planValidate'
import { resolveStepInputsDependsOn } from './topology'
import { intentClassifyFromMeta } from '../../llm/intentClassifyLlm'
import { userRequiresDbDataPlane } from '../../orchestrate/routeOrchestration'
import { normalizeStepClauseIds } from '../routing/clausePlanBinding'
import { type TaskConstraints } from './constants'
import {
  formatMultimodalStructuredDigest,
  normalizeMultimodalStructured
} from '#agent-shared/multimodalStructuredHandoff'

export function getEffectivePlanSteps(state: { plan?: Step[]; taskPlan?: TaskPlan | null }) {
  const tpSteps = Array.isArray(state?.taskPlan?.steps) ? state.taskPlan!.steps : []
  const stSteps = Array.isArray(state?.plan) ? state.plan! : []
  return tpSteps.length ? tpSteps : stSteps
}

export function buildTaskPlan(state: any, steps: Step[]): TaskPlan {
  const candidate = {
    intent: state.intent,
    entities: normalizeEntities(state.entities as any),
    steps,
    needsClarification: false,
    clarificationQuestions: []
  }
  const parsed = TaskPlanSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  return {
    intent: 'multi',
    entities: normalizeEntities(undefined),
    steps,
    needsClarification: false,
    clarificationQuestions: []
  }
}

export function mergeTaskPlan(base: TaskPlan | null, incoming: Partial<TaskPlan> | null, fallbackIntent: Intent, fallbackSteps: Step[]) {
  const baseEntities = normalizeEntities(base?.entities as any)
  const inEntities = normalizeEntities((incoming?.entities as any) ?? {})
  const mergedEntities = normalizeEntities({
    names: [...baseEntities.names, ...inEntities.names],
    records: [...baseEntities.records, ...inEntities.records],
    locations: [...baseEntities.locations, ...inEntities.locations],
    dates: [...baseEntities.dates, ...inEntities.dates]
  })
  const mergedSteps =
    Array.isArray(incoming?.steps) && incoming!.steps!.length > 0 ? (incoming!.steps as Step[]) : (base?.steps?.length ? base.steps : fallbackSteps)
  return buildTaskPlan(
    {
      intent: incoming?.intent ?? base?.intent ?? fallbackIntent,
      entities: mergedEntities
    },
    mergedSteps
  )
}

export function enforcePlanConstraints(planIn: Step[], constraints: TaskConstraints) {
  const plan = Array.isArray(planIn) ? planIn : []
  return plan.map((s, idx) => {
    const step = { ...s }
    const agent = String(step.agent || '')
    if (agent === 'db') {
      step.query = appendConstraintsToDbAgentQuery(String(step.query || ''), constraints)
    } else if (['code', 'crawler'].includes(agent)) {
      step.query = appendConstraintsToQuery(String(step.query || ''), constraints)
    }
    // RAG 向量检索只用短问句；约束会扩大召回并混入无关文档（如养老规范）
    if (!step.id) step.id = `step_${agent || 'x'}_${idx + 1}`
    return step
  })
}

const SINGLE_INSTANCE_PLAN_AGENTS = new Set<Step['agent']>(['admin', 'code'])

/** Planner 偶发重复 clean 时只保留 code 之前的那一步（post-code 二次清洗在有 pre-clean 时无意义） */
export function dedupeCleanPlanSteps(steps: Step[]): Step[] {
  if (!Array.isArray(steps) || steps.length < 2) return steps
  const cleans = steps.filter((s) => s?.agent === 'clean')
  if (cleans.length <= 1) return steps

  const codeIdx = steps.findIndex((s) => s?.agent === 'code')
  let keep = cleans[0]!
  for (const c of cleans) {
    const idx = steps.indexOf(c)
    if (codeIdx < 0 || idx < codeIdx) {
      keep = c
      break
    }
  }
  const keepId = String(keep.id || 'step_clean').trim()
  const dropIds = new Set(
    cleans
      .filter((c) => String(c.id || '').trim() !== keepId)
      .map((c) => String(c.id || '').trim())
      .filter(Boolean)
  )
  if (!dropIds.size) return steps

  return steps
    .filter((s) => !dropIds.has(String(s.id || '').trim()))
    .map((s) => {
      if (!Array.isArray(s.dependsOn)) return s
      const deps = s.dependsOn.map(String).filter((d) => d && !dropIds.has(d))
      return deps.length ? { ...s, dependsOn: deps } : { ...s, dependsOn: undefined }
    })
}

/** admin / code 等执行类 Agent 在计划中最多保留一步（Planner LLM 偶发重复时兜底） */
export function dedupeSingleInstanceAgents(steps: Step[]): Step[] {
  const dedupedClean = dedupeCleanPlanSteps(steps)
  if (!Array.isArray(dedupedClean) || dedupedClean.length < 2) return dedupedClean
  const seen = new Set<Step['agent']>()
  const out: Step[] = []
  for (const s of dedupedClean) {
    if (!s?.agent) continue
    if (SINGLE_INSTANCE_PLAN_AGENTS.has(s.agent)) {
      if (seen.has(s.agent)) continue
      seen.add(s.agent)
    }
    out.push(s)
  }
  return out.length ? out : dedupedClean
}

export function normalizePlanSteps(steps: Step[]) {
  const deduped = dedupeSingleInstanceAgents(Array.isArray(steps) ? steps : [])
  const out: Step[] = []
  const used = new Set<string>()
  const firstIdByAgent: Partial<Record<Step['agent'], string>> = {}
  for (let i = 0; i < deduped.length; i++) {
    const s = deduped[i]
    if (!s) continue
    const agent = s.agent
    let id = String((s as any).id ?? '').trim()
    if (!id) id = `${agent}_${i + 1}`
    while (used.has(id)) id = `${id}_${Math.floor(Math.random() * 9) + 1}`
    used.add(id)
    if (!firstIdByAgent[agent]) firstIdByAgent[agent] = id
    out.push({
      ...s,
      id,
      clauseIds: normalizeStepClauseIds((s as { clauseIds?: unknown }).clauseIds),
      dependsOn: Array.isArray((s as any).dependsOn) ? (s as any).dependsOn : undefined
    })
  }
  const withInputs = resolveStepInputsDependsOn(out)
  const validIds = new Set(withInputs.map((x) => String(x.id || '').trim()).filter(Boolean))
  for (const s of withInputs) {
    const rawDeps = Array.isArray((s as any).dependsOn) ? ((s as any).dependsOn as unknown[]) : []
    const sid = String(s.id || '').trim()
    const cleaned = rawDeps
      .map((x) => String(x ?? '').trim())
      .filter((d) => d && d !== '0' && validIds.has(d) && d !== sid)
    ;(s as any).dependsOn = cleaned.length ? Array.from(new Set(cleaned)) : undefined
  }
  return withInputs
}

export function buildStepContext(
  step: Step,
  byId: Record<
    string,
    {
      id: string
      agent: Step['agent']
      query: string
      output: string
      status?: string
      error?: string
      meta?: unknown
    }
  >
) {
  const deps = Array.isArray((step as any).dependsOn) ? ((step as any).dependsOn as string[]) : []
  if (!deps.length) return ''
  const perDepMax = step.agent === 'code' ? 320 : 220
  const totalMax = step.agent === 'code' ? 1200 : 700
  const lines: string[] = []
  let used = 0

  for (const depId of deps) {
    if (used >= totalMax) break
    const e = byId[String(depId)]
    if (!e) continue
    if (e.status === 'skipped') continue
    if (!shouldIncludeUpstreamDepForStep(step, e.agent)) continue

    if (e.status === 'error') {
      const errLine = `- ${e.id} (${e.agent}): 执行失败：${String(e.error || 'unknown error')}`
      if (used + errLine.length > totalMax) break
      lines.push(errLine)
      used += errLine.length + 1
      continue
    }

    const extracted = extractStructuredPayload(String(e.output ?? ''))
    const factLines = (Array.isArray(extracted.facts) ? extracted.facts : [])
      .filter((f: any) => String(f?.key || '').trim())
      .slice(0, 6)
      .map((f: any) => `${String(f.key).trim()}: ${String(f.value ?? '').trim()}`)
      .filter(Boolean)
    const missing = shouldPassUpstreamMissing(step.agent, e.agent)
      ? (Array.isArray(extracted.missingFields) ? extracted.missingFields : [])
          .map((x: any) => String(x ?? '').trim())
          .filter(Boolean)
          .slice(0, 4)
      : []

    const mmDigest =
      String(e.agent) === 'multimodal'
        ? formatMultimodalStructuredDigest(
            normalizeMultimodalStructured(
              (e.meta as { agentResult?: { structured?: unknown } } | undefined)?.agentResult?.structured
            ),
            160
          )
        : ''

    const rawPreview = String(extracted.answer || '').replace(/\s+/g, ' ').trim()
    let preview = rawPreview.length > perDepMax ? `${rawPreview.slice(0, perDepMax)}…` : rawPreview
    if (isActionExecAgent(step.agent) && preview && isUpstreamClarifyNoise(preview)) {
      preview = ''
    }

    const compact = [
      mmDigest ? `识图交接: ${mmDigest}` : '',
      factLines.length ? `facts(${factLines.length}): ${factLines.join('；')}` : '',
      missing.length ? `missing: ${missing.join('、')}` : '',
      preview ? `preview: ${preview}` : ''
    ]
      .filter(Boolean)
      .join(' | ')
      .trim()

    if (!compact) continue
    const line = `- ${e.id} (${e.agent}): ${compact}`
    if (used + line.length > totalMax) break
    lines.push(line)
    used += line.length + 1
  }

  return lines.join('\n').trim()
}

