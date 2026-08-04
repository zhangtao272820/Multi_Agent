import fs from 'node:fs/promises'
import path from 'node:path'
import { effectiveUserTask } from '../text'
import { syncEvoPolicyPromote, syncEvoPolicyShadowWrite } from './evoPolicySync'

export type PlannerRule = {
  id: string
  /** 命中条件：allowedAgents 须包含全部列出的 agent */
  whenAllowedIncludes?: string[]
  whenIntent?: 'multi'
  /** 任务文本须包含任一关键词（小写匹配） */
  whenTaskHints?: string[]
  /** 计划中必须出现的 agent */
  requireAgents?: string[]
  /** 计划中禁止出现的 agent */
  forbidAgents?: string[]
  /** agent B 的步骤必须依赖 agent A 的步骤 */
  requireAfter?: Array<{ agent: string; after: string }>
  message: string
}

export type PlannerRuleSet = {
  version: number
  updatedAt: string
  active: boolean
  source?: 'manual' | 'auto' | 'promoted'
  confidence?: number
  rationale?: string
  rules: PlannerRule[]
}

const ACTIVE_FILE = 'manager-planner-rules.json'
const SHADOW_FILE = 'manager-planner-rules.shadow.json'

export function isPlannerRulesEnabled() {
  return String(process.env.MANAGER_PLANNER_RULES ?? '1').trim() !== '0'
}

function normalizeRule(raw: unknown): PlannerRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = String(o.id || '').trim()
  const message = String(o.message || '').trim()
  if (!id || !message) return null
  const pickArr = (k: string) =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean) : undefined
  const requireAfter = Array.isArray(o.requireAfter)
    ? (o.requireAfter as unknown[])
        .map((row) => {
          const r = row as Record<string, unknown>
          const agent = String(r?.agent || '').trim()
          const after = String(r?.after || '').trim()
          return agent && after ? { agent, after } : null
        })
        .filter(Boolean) as PlannerRule['requireAfter']
    : undefined
  return {
    id,
    message,
    whenAllowedIncludes: pickArr('whenAllowedIncludes'),
    whenIntent: o.whenIntent === 'multi' ? 'multi' : undefined,
    whenTaskHints: pickArr('whenTaskHints'),
    requireAgents: pickArr('requireAgents'),
    forbidAgents: pickArr('forbidAgents'),
    requireAfter
  }
}

function normalizeRuleSet(raw: unknown): PlannerRuleSet | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rules = (Array.isArray(o.rules) ? o.rules : [])
    .map(normalizeRule)
    .filter(Boolean) as PlannerRule[]
  if (!rules.length) return null
  return {
    version: Number(o.version) || 1,
    updatedAt: String(o.updatedAt || new Date().toISOString()),
    active: o.active !== false,
    source: (['manual', 'auto', 'promoted'].includes(String(o.source)) ? o.source : 'auto') as PlannerRuleSet['source'],
    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    rationale: typeof o.rationale === 'string' ? o.rationale : undefined,
    rules: rules.slice(0, 24)
  }
}

async function readRulesFile(policyDir: string, file: string): Promise<PlannerRuleSet | null> {
  try {
    const raw = await fs.readFile(path.join(policyDir, file), 'utf8')
    return normalizeRuleSet(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function loadActivePlannerRules(policyDir: string): Promise<PlannerRuleSet | null> {
  if (!isPlannerRulesEnabled()) return null
  const set = await readRulesFile(policyDir, ACTIVE_FILE)
  return set?.active !== false ? set : null
}

export async function loadShadowPlannerRules(policyDir: string): Promise<PlannerRuleSet | null> {
  if (!isPlannerRulesEnabled()) return null
  return readRulesFile(policyDir, SHADOW_FILE)
}

export async function writeShadowPlannerRules(policyDir: string, set: PlannerRuleSet) {
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  const body = { ...set, active: false }
  await fs.writeFile(path.join(policyDir, SHADOW_FILE), JSON.stringify(body, null, 2), 'utf8')
  await syncEvoPolicyShadowWrite(policyDir, 'planner_rules', body as unknown as Record<string, unknown>).catch(
    () => undefined
  )
}

export async function promoteShadowPlannerRules(
  policyDir: string,
  opts?: { minConfidence?: number }
): Promise<{ promoted: boolean; message: string }> {
  const shadow = await loadShadowPlannerRules(policyDir)
  if (!shadow) return { promoted: false, message: '无 shadow 规则' }
  const min = opts?.minConfidence ?? 0.68
  if (typeof shadow.confidence === 'number' && shadow.confidence < min) {
    return { promoted: false, message: `置信度 ${shadow.confidence} < ${min}` }
  }
  const active = { ...shadow, active: true, source: 'promoted' as const, updatedAt: new Date().toISOString() }
  await fs.writeFile(path.join(policyDir, ACTIVE_FILE), JSON.stringify(active, null, 2), 'utf8')
  await syncEvoPolicyPromote(policyDir, 'planner_rules', active as unknown as Record<string, unknown>, {
    verifyOk: true
  }).catch(() => undefined)
  return { promoted: true, message: `已晋级 planner 规则 v${active.version}` }
}

export function formatPlannerRulesBlock(rules: PlannerRuleSet | null): string {
  if (!rules?.rules.length) return ''
  return [
    '### 自进化规划硬规则（plan_lint 会强制执行；与本轮用户明确意图冲突时以本轮为准）',
    ...rules.rules.map((r) => `- [${r.id}] ${r.message}`)
  ].join('\n')
}

function ruleMatches(state: any, rule: PlannerRule, taskText: string): boolean {
  if (rule.whenIntent && String(state.intent || '') !== rule.whenIntent) return false
  const allowed = new Set<string>(
    (Array.isArray(state.allowedAgents) ? state.allowedAgents : []).map((a: any) => String(a ?? '').trim())
  )
  if (rule.whenAllowedIncludes?.length) {
    if (!rule.whenAllowedIncludes.every((a) => allowed.has(a))) return false
  }
  if (rule.whenTaskHints?.length) {
    const t = taskText.toLowerCase()
    if (!rule.whenTaskHints.some((h) => t.includes(String(h).toLowerCase()))) return false
  }
  return true
}

/** 由 plan_linter 调用：返回需阻断的 issue 文案 */
export function lintPlanWithPlannerRules(
  state: any,
  steps: any[],
  rules: PlannerRuleSet | null
): string[] {
  if (!rules?.rules.length) return []
  const taskText = effectiveUserTask(state.messages as any, state.routedQuery).toLowerCase()
  const agentsInPlan = (Array.isArray(steps) ? steps : []).map((s) => String(s?.agent || '').trim()).filter(Boolean)
  const agentSet = new Set(agentsInPlan)
  const byAgent = new Map<string, any[]>()
  for (const s of Array.isArray(steps) ? steps : []) {
    const ag = String(s?.agent || '').trim()
    if (!ag) continue
    const arr = byAgent.get(ag) || []
    arr.push(s)
    byAgent.set(ag, arr)
  }

  const issues: string[] = []
  for (const rule of rules.rules) {
    if (!ruleMatches(state, rule, taskText)) continue

    for (const req of rule.requireAgents || []) {
      if (!req) continue
      if (!agentSet.has(req)) issues.push(`规划规则[${rule.id}]：缺少必需步骤 agent=${req}（${rule.message}）`)
    }
    for (const ban of rule.forbidAgents || []) {
      if (agentSet.has(ban)) issues.push(`规划规则[${rule.id}]：禁止 agent=${ban}（${rule.message}）`)
    }
    for (const dep of rule.requireAfter || []) {
      const childSteps = byAgent.get(dep.agent) || []
      if (!childSteps.length) continue
      const parentIds = new Set(
        (byAgent.get(dep.after) || []).map((s: any) => String(s?.id || '').trim()).filter(Boolean)
      )
      if (!parentIds.size) {
        issues.push(`规划规则[${rule.id}]：${dep.agent} 须依赖 ${dep.after}，但计划中无 ${dep.after} 步骤`)
        continue
      }
      for (const cs of childSteps) {
        const deps = Array.isArray(cs?.dependsOn) ? cs.dependsOn.map((d: any) => String(d).trim()) : []
        const ok = deps.some((d) => parentIds.has(d))
        if (!ok) issues.push(`规划规则[${rule.id}]：步骤 ${cs?.id || dep.agent} 的 ${dep.agent} 须 dependsOn ${dep.after}`)
      }
    }
  }
  return issues
}

export function summarizePlannerRulesDiff(active: PlannerRuleSet | null, shadow: PlannerRuleSet | null) {
  const aIds = new Set((active?.rules || []).map((r) => r.id))
  const sIds = new Set((shadow?.rules || []).map((r) => r.id))
  const added = [...sIds].filter((id) => !aIds.has(id))
  const removed = [...aIds].filter((id) => !sIds.has(id))
  return {
    activeCount: active?.rules.length ?? 0,
    shadowCount: shadow?.rules.length ?? 0,
    added,
    removed
  }
}
