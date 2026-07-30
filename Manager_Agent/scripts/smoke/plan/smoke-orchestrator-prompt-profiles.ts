/**
 * P5：Orchestrator prompt profile 选型 smoke（不拉 LLM）。
 * 断言：按 Probe/会话平面挂载 ≤2 packs；无关 pack 未挂载；含 untrusted 纪律；gui vs crawler 底座。
 */
import {
  assembleOrchestratorCompactSystemPrompt,
  assembleOrchestratorSystemPrompt,
  listOrchestratorExamplePacks,
  ORCH_PACK_MARKERS,
  wrapUntrustedBlock,
  type OrchestratorPromptAssembleInput
} from '../../../server/graph/llm/orchestratorPromptProfiles'
import { assertSystemPromptWithinBudget, promptBudgetSystemChars } from '../../../server/graph/core/shared/promptBudget'
import { findPromptHygieneViolations } from '../../../agent-repo-shared/promptHygiene'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const cold: OrchestratorPromptAssembleInput = {}
const coldPacks = listOrchestratorExamplePacks(cold)
assert(coldPacks.length <= 2, 'cold mounts at most 2 packs')
assert(coldPacks.includes('db_only') && coldPacks.includes('gui_interact'), 'cold default packs')
const coldSys = assembleOrchestratorSystemPrompt(cold)
assert(coldSys.includes(ORCH_PACK_MARKERS.db_only), 'cold has db_only marker')
assert(coldSys.includes(ORCH_PACK_MARKERS.gui_interact), 'cold has gui_interact')
assert(!coldSys.includes(ORCH_PACK_MARKERS.multi_three), 'cold omits multi_three')
assert(!coldSys.includes(ORCH_PACK_MARKERS.admin_combo), 'cold omits admin_combo')
assert(!coldSys.includes(ORCH_PACK_MARKERS.report_brief), 'cold omits report_brief')
assert(coldSys.includes('<untrusted_*>'), 'base mentions untrusted tags')
assert(coldSys.includes('gui vs crawler') || coldSys.includes('【gui vs crawler】'), 'base has gui vs crawler rule')
assertSystemPromptWithinBudget(coldSys, 'orch:cold')

const dbOnly: OrchestratorPromptAssembleInput = { probeDbRelevant: true, probeRagHits: false }
const dbSys = assembleOrchestratorSystemPrompt(dbOnly)
assert(dbSys.includes(ORCH_PACK_MARKERS.db_only), 'db probe has db_only')
assert(dbSys.includes(ORCH_PACK_MARKERS.db_code), 'db probe has db_code')
assert(!dbSys.includes(ORCH_PACK_MARKERS.multi_three), 'db-only omits multi_three')
assert(!dbSys.includes(ORCH_PACK_MARKERS.rag_web), 'db-only omits rag_web')
assert(!dbSys.includes(ORCH_PACK_MARKERS.gui_interact), 'db-only omits gui_interact pack')

const both: OrchestratorPromptAssembleInput = { probeDbRelevant: true, probeRagHits: true }
const bothSys = assembleOrchestratorSystemPrompt(both)
assert(bothSys.includes(ORCH_PACK_MARKERS.multi_three), 'db+rag has multi_three')
assert(!bothSys.includes(ORCH_PACK_MARKERS.db_only), 'db+rag omits db_only singleton')

const action: OrchestratorPromptAssembleInput = { sessionPrimaryPlane: 'action' }
const actionSys = assembleOrchestratorSystemPrompt(action)
assert(actionSys.includes(ORCH_PACK_MARKERS.gui_interact), 'action plane has gui_interact')
assert(actionSys.includes(ORCH_PACK_MARKERS.admin_combo), 'action plane has admin_combo')
assert(!actionSys.includes(ORCH_PACK_MARKERS.db_only), 'action omits db_only')

const crawlerPlane: OrchestratorPromptAssembleInput = { sessionPrimaryPlane: 'crawler' }
const crawlerSys = assembleOrchestratorSystemPrompt(crawlerPlane)
assert(crawlerSys.includes(ORCH_PACK_MARKERS.gui_interact), 'crawler plane has gui_interact')
assert(crawlerSys.includes(ORCH_PACK_MARKERS.rag_web), 'crawler plane has rag_web')
assert(!crawlerSys.includes(ORCH_PACK_MARKERS.multi_three), 'crawler plane omits multi_three')

const forced = assembleOrchestratorSystemPrompt({ forcePacks: ['clarify', 'rag_web', 'db_only'] })
assert(forced.includes(ORCH_PACK_MARKERS.clarify), 'force clarify')
assert(forced.includes(ORCH_PACK_MARKERS.rag_web), 'force rag_web')
assert(!forced.includes(ORCH_PACK_MARKERS.db_only), 'force respects max 2')

const compact = assembleOrchestratorCompactSystemPrompt()
assert(compact.includes('紧凑编排器'), 'compact title')
assert(compact.includes('<untrusted_*>'), 'compact untrusted rule')
assert(!compact.includes(ORCH_PACK_MARKERS.db_only), 'compact has no example packs')

const wrapped = wrapUntrustedBlock('probe', 'RAG 可达: 2 hits')
assert(wrapped.startsWith('<untrusted_probe>'), 'wrap opens tag')
assert(wrapped.includes('RAG 可达'), 'wrap keeps body')
assert(wrapUntrustedBlock('probe', '  ') === '', 'empty wrap omitted')

assert(promptBudgetSystemChars() >= 2000, 'system budget configured')

for (const [name, text] of [
  ['cold', coldSys],
  ['db', dbSys],
  ['both', bothSys],
  ['action', actionSys],
  ['crawler', crawlerSys],
  ['compact', compact]
] as const) {
  const hits = findPromptHygieneViolations(text)
  assert(hits.length === 0, `${name} prompt hygiene clean (hits=${hits.join(',')})`)
}

console.log('smoke-orchestrator-prompt-profiles: ok')
