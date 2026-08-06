/**
 * P0/P2 黄金路径结构回归：不调用 LLM / 外部 Agent。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  agentsFromClauses,
  buildAgentScopedQuery,
  clausesFromMeta,
  isClauseDecomposeEnabled,
  reconcileRouteAllowedAgents
} from '../../../server/graph/core/routing/clauses'
import {
  deleteHumanConfirmCheckpoint,
  loadHumanConfirmCheckpoint,
  saveHumanConfirmCheckpoint
} from '../../../server/graph/core/runtime/checkpointStore'
import { buildHumanConfirmCheckpoint } from '../../../server/graph/core/output/composeFinal'
import { createAgentFailureNotifier } from '../../../server/graph/core/agent/agentErrors'
import {
  isManagerRagRetrieveFirstEnabled,
  ragRetrieveCallOptions,
  textIndicatesRagMiss
} from '../../../server/graph/core/rag/ragRetrievePolicy'
import { shouldBypassRagEvidenceJudge } from '../../../server/utils/rag/managerRagRelevance'
import { buildProbeHeuristicOrchestration, isOrchestratorCompactFirst } from '../../../server/graph/orchestrate/orchestratorHeuristic'
import { prefetchRagFromProbeCache } from '../../../server/graph/core/rag/ragPrefetch'
import { resolveTurnRoutingScope } from '../../../server/graph/core/routing/turnScope'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// P0-2: HITL checkpoint 落盘往返
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-ck-'))
const prevCwd = process.cwd()
process.chdir(tmpDir)
try {
  await saveHumanConfirmCheckpoint('sess-golden', buildHumanConfirmCheckpoint({ intent: 'multi', plan: [{ agent: 'admin' }] }))
  const loaded = await loadHumanConfirmCheckpoint('sess-golden')
  assert((loaded as { intent?: string })?.intent === 'multi', 'checkpoint roundtrip')
  await deleteHumanConfirmCheckpoint('sess-golden')
  const gone = await loadHumanConfirmCheckpoint('sess-golden')
  assert(!gone, 'checkpoint deleted')
} finally {
  process.chdir(prevCwd)
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
}

// P0-5: agent_error notifier 工厂
let captured: { agent?: string; message?: string } | null = null
const notify = createAgentFailureNotifier((ev) => {
  if (ev.event === 'agent_error') captured = ev.data as { agent?: string; message?: string }
}, 'run-golden')
notify('admin', 'gate blocked')
assert(captured?.agent === 'admin', 'agent_error payload agent')

// P0-6 / P2-2: retrieve-first 策略
assert(!isManagerRagRetrieveFirstEnabled(), 'retrieve-first default off (chat-first, align UI)')
process.env.MANAGER_RAG_RETRIEVE_FIRST = '1'
assert(isManagerRagRetrieveFirstEnabled(), 'retrieve-first can enable')
delete process.env.MANAGER_RAG_RETRIEVE_FIRST

const strict = ragRetrieveCallOptions('default', 2)
const relaxed = ragRetrieveCallOptions('relaxed', 0)
assert(strict.skipLlmRerank === true && relaxed.skipLlmRerank === false, 'retrieve call options modes')
assert(textIndicatesRagMiss('知识库检索未找到相关内容'), 'rag miss marker')
assert(!textIndicatesRagMiss('根据文档，答案是 42'), 'rag hit text')
assert(shouldBypassRagEvidenceJudge(2), 'probe hits bypass judge')
assert(!shouldBypassRagEvidenceJudge(0) || process.env.MANAGER_RAG_BYPASS_JUDGE_ON_PROBE === '0', 'zero probe default bypass')
// convergence / LEGACY_DEFAULTS：compact-first 默认关（LLM-first 编排）
assert(!isOrchestratorCompactFirst(), 'orchestrator compact-first default off')

const ragHeuristic = buildProbeHeuristicOrchestration({
  lastUser: '从知识库检索《养老机构服务规范》中护理员配比并生成柱状图',
  turnScope: resolveTurnRoutingScope({ messages: [], lastUser: '从知识库检索《养老机构服务规范》中护理员配比并生成柱状图' }),
  probe: { rag: { hits: 3 } }
})
assert(ragHeuristic?.allowedAgents.includes('rag'), 'heuristic rag cap')
assert(ragHeuristic?.allowedAgents.includes('visualize'), 'heuristic visualize cap')
assert(!ragHeuristic?.allowedAgents.includes('db'), 'heuristic no db on rag probe')

const probeCache = prefetchRagFromProbeCache(
  { hits: 2, sources: ['a.docx'], snippets: ['护理员配比 1:3', '高龄津贴 100元'] },
  '养老机构服务规范'
)
assert(probeCache?.ok && (probeCache.hits ?? 0) === 2, 'prefetch probe cache')

// P2-6: 子句拆解结构（不启用 env 时为空；启用后读 meta）
const prevDecompose = process.env.MANAGER_CLAUSE_DECOMPOSE
process.env.MANAGER_CLAUSE_DECOMPOSE = '1'
assert(isClauseDecomposeEnabled(), 'clause decompose flag')
const clauses = clausesFromMeta({
  taskClauses: [
    { id: 'c1', text: '查知识库政策', agents: ['rag'] },
    { id: 'c2', text: '汇总成报告', agents: ['report'] }
  ]
})
assert(clauses.length === 2, 'clauses from meta')
assert(agentsFromClauses(clauses).includes('rag'), 'agents from clauses')
const scoped = buildAgentScopedQuery('rag', clauses, 'fallback task')
assert(scoped.includes('查知识库') || scoped.includes('政策'), 'scoped rag query')
const allowed = reconcileRouteAllowedAgents(['db'], clauses)
assert(allowed.includes('rag') && allowed.includes('db'), 'route allowed merge')
if (prevDecompose === undefined) delete process.env.MANAGER_CLAUSE_DECOMPOSE
else process.env.MANAGER_CLAUSE_DECOMPOSE = prevDecompose

console.log('smoke: golden paths ok')
