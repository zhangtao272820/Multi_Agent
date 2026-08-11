/**
 * 总管 → 子 Agent 透传判定 SSOT：
 * - 单源：outbound = lastUserText（对齐独立端）
 * - 真 multi：outbound = clause / queryFocus（一次切分，禁二次 LLM 改写）
 */
import { clausesFromMeta } from './clauses'

const DATA_PLANE_AGENTS = new Set(['db', 'rag', 'crawler', 'admin', 'multimodal', 'gui'])

function metaObj(meta: unknown): Record<string, unknown> | null {
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
}

function allowedAgentsFromMeta(meta: unknown): string[] {
  const m = metaObj(meta)
  if (!m || !Array.isArray(m.allowedAgents)) return []
  return m.allowedAgents.map((a) => String(a || '').trim()).filter(Boolean)
}

function blueprintStepAgents(meta: unknown): string[] {
  const steps = (metaObj(meta)?.planBlueprint as { steps?: Array<{ agent?: string }> } | undefined)?.steps
  if (!Array.isArray(steps)) return []
  return steps.map((s) => String(s?.agent || '').trim()).filter(Boolean)
}

function planShortcutFromMeta(meta: unknown): string {
  const m = metaObj(meta)
  return String(
    (m?.intentClassify as { planShortcut?: string } | undefined)?.planShortcut || m?.planShortcut || ''
  ).trim()
}

function primaryIntentFromMeta(meta: unknown): string {
  const m = metaObj(meta)
  return String(
    m?.intent || (m?.intentClassify as { primaryIntent?: string } | undefined)?.primaryIntent || ''
  ).trim()
}

function dataPlaneAgentsIn(list: string[]): string[] {
  return list.filter((a) => DATA_PLANE_AGENTS.has(a))
}

/** 数据面集合（去重，保序） */
function uniqueDataPlanes(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of dataPlaneAgentsIn(list)) {
    if (seen.has(a)) continue
    seen.add(a)
    out.push(a)
  }
  return out
}

/** 单源 DB：仅一个数据面且为 db（可挂 code/visualize/report/clean）→ 透传用户原话 */
export function isSingleSourceDbTask(meta: unknown): boolean {
  const intent = primaryIntentFromMeta(meta)
  if (intent === 'db') return true
  if (planShortcutFromMeta(meta) === 'db_only') return true
  const allowed = allowedAgentsFromMeta(meta)
  if (allowed.length === 1 && allowed[0] === 'db') return true
  const allowedData = uniqueDataPlanes(allowed)
  if (allowedData.length === 1 && allowedData[0] === 'db') return true
  const steps = blueprintStepAgents(meta)
  if (steps.length === 1 && steps[0] === 'db') return true
  const stepData = uniqueDataPlanes(steps)
  if (stepData.length === 1 && stepData[0] === 'db') return true
  return false
}

/** 单源 RAG：仅一个数据面且为 rag（可挂加工链）→ 透传用户原话 */
export function isSingleSourceRagTask(meta: unknown): boolean {
  const intent = primaryIntentFromMeta(meta)
  if (intent === 'rag') return true
  if (planShortcutFromMeta(meta) === 'rag_only') return true
  const allowed = allowedAgentsFromMeta(meta)
  if (allowed.length === 1 && allowed[0] === 'rag') return true
  const allowedData = uniqueDataPlanes(allowed)
  if (allowedData.length === 1 && allowedData[0] === 'rag') return true
  const steps = blueprintStepAgents(meta)
  if (steps.length === 1 && steps[0] === 'rag') return true
  const stepData = uniqueDataPlanes(steps)
  if (stepData.length === 1 && stepData[0] === 'rag') return true
  return false
}

/** 真多源：≥2 个不同数据面；假 multi / 单源+加工链不得锁 queryFocus */
export function isTrueMultiTask(meta: unknown): boolean {
  if (isSingleSourceDbTask(meta) || isSingleSourceRagTask(meta)) return false
  const shortcut = planShortcutFromMeta(meta)
  if (shortcut === 'db_only' || shortcut === 'rag_only' || shortcut === 'admin_only' || shortcut === 'chitchat_only') {
    return false
  }

  const allowedData = uniqueDataPlanes(allowedAgentsFromMeta(meta))
  if (allowedData.length >= 2) return true

  const stepData = uniqueDataPlanes(blueprintStepAgents(meta))
  if (stepData.length >= 2) return true

  const clauses = clausesFromMeta(meta)
  if (clauses.length >= 2) {
    const clauseData = new Set<string>()
    for (const c of clauses) {
      for (const a of c.agents || []) {
        if (DATA_PLANE_AGENTS.has(String(a))) clauseData.add(String(a))
      }
    }
    if (clauseData.size >= 2) return true
  }

  return false
}

/** 步进级子会话，避免复用 Manager sessionId 污染 DB/RAG 服务端历史 */
export function resolveSubAgentStepSessionId(input: {
  runId?: string
  agent: string
  stepId?: string
}): string {
  const runId = String(input.runId || '').trim() || 'run'
  const agent = String(input.agent || 'step').trim().replace(/[^\w-]+/g, '_').slice(0, 24) || 'step'
  const step = String(input.stepId || '').trim().replace(/[^\w-]+/g, '_').slice(0, 32)
  return step ? `mgr-${runId}-${agent}-${step}` : `mgr-${runId}-${agent}`
}
