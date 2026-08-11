/**
 * §3.6 协同契约 smoke：session 桥接、RAG 编排 history=[]、AMP 常量。
 * CI：npm run smoke:memory-coordination
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDbHistoryFromState, resolveManagerAgentSessionId } from '../../../server/graph/core/runtime/sessionBridge'
import { resolveSubAgentStepSessionId } from '../../../server/graph/core/routing/subAgentPassthrough'
import { isManagerSubAgentSessionId } from '#agent-shared/managerStepSession'
import { buildEvolutionApplied, extractEvolutionApplied } from '#agent-shared/evolutionApplied'
import {
  groundFollowupQuery,
  isFollowupQueryUngrounded,
  shouldGroundFollowupQuery
} from '#agent-shared/followupQueryGrounding'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-memory-coordination] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

console.log('smoke-memory-coordination: start')

// §3.1 sessionId 解析顺序
assert(
  resolveManagerAgentSessionId({ sessionId: 's1', ragConversationId: 'r1', runId: 'x' }) === 's1',
  'sessionId must win'
)
assert(
  resolveManagerAgentSessionId({ sessionId: '', ragConversationId: 'r1', runId: 'x' }) === 'r1',
  'ragConversationId fallback'
)
assert(
  resolveManagerAgentSessionId({ sessionId: '', ragConversationId: '', runId: 'x' }) === 'mgr-x',
  'mgr-{runId} fallback'
)

// DB/RAG 步进隔离：不得复用 Manager sessionId
assert(
  resolveSubAgentStepSessionId({ runId: 'x', agent: 'db' }) === 'mgr-x-db',
  'db sub-agent step session'
)
assert(
  resolveSubAgentStepSessionId({ runId: 'x', agent: 'rag', stepId: 'c1' }) === 'mgr-x-rag-c1',
  'rag sub-agent step session'
)
assert(
  resolveSubAgentStepSessionId({ runId: 'x', agent: 'db' }) !==
    resolveManagerAgentSessionId({ sessionId: 'mgr-session', ragConversationId: '', runId: 'x' }),
  'sub-agent session must differ from manager session when manager sid present'
)

// §3.2 DB history ≤8 轮
const dbHist = buildDbHistoryFromState(
  Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `t${i}`
  })),
  '当前问'
)
assert(dbHist.length <= 17, 'DB history should cap at 8 turns + current')
assert(dbHist[dbHist.length - 1]?.content === '当前问', 'current question appended')

// output_followup：DB 仅窄 assistant + 当前问
const followupDb = buildDbHistoryFromState(
  [
    { role: 'user', content: '查比对' },
    { role: 'assistant', content: '环境指标 vs 汇总指标' },
    { role: 'user', content: '同上面是哪种' }
  ],
  '同上面是哪种',
  { turnScopeMode: 'current_only', turnKind: 'output_followup' }
)
assert(followupDb.length === 2, 'output_followup DB history = assistant + current')
assert(followupDb[0]?.role === 'assistant', 'output_followup keeps assistant only')

// §3.2 RAG 透传协议：不发编排头；执行层用步进 session + current_only 空 history
const ragClientSrc = readSource('Manager_Agent/server/utils/agents/ragClient.ts')
assert(!ragClientSrc.includes("'x-manager-orchestrated': '1'"), 'ragClient must not set orchestrated header (passthrough)')
assert(!ragClientSrc.includes('manager_rag_task_json'), 'ragClient must not send manager_rag_task_json')

const ragExecSrc = readSource('Manager_Agent/server/graph/core/executors/ragExecute.ts')
assert(ragExecSrc.includes('resolveSubAgentStepSessionId'), 'ragExecute uses step session isolation')
assert(ragExecSrc.includes("turnScopeMode === 'current_only'"), 'ragExecute empties history on current_only')
assert(ragExecSrc.includes('groundFollowupQuery'), 'ragExecute grounds followup lean')

const dbExecSrc = readSource('Manager_Agent/server/graph/core/executors/dbExecutor.ts')
assert(dbExecSrc.includes('resolveSubAgentStepSessionId'), 'dbExecutor uses step session isolation')
assert(!dbExecSrc.includes('resolveManagerAgentSessionId'), 'dbExecutor must not reuse manager session')

// AMP 文档化常量（静态检查 shared 模块存在）
const ampSrc = readSource('shared/agentMemoryPolicy.ts')
assert(ampSrc.includes('AMP_POLICY_VERSION'), 'AMP policy module present')
assert(ampSrc.includes('sessionTurnsMax: 200'), 'session turns cap in AMP')

const userKeySrc = readSource('shared/resolveUserKey.ts')
assert(userKeySrc.includes('__global__'), 'user_key fallback')

// 步进 session 识别：禁 RAG 服务端历史回灌
assert(isManagerSubAgentSessionId('mgr-x-rag-c1', 'rag'), 'mgr-*-rag-* is step session')
assert(isManagerSubAgentSessionId('mgr-x-db', 'db'), 'mgr-*-db is step session')
assert(!isManagerSubAgentSessionId('user-session-1', 'rag'), 'user session is not manager step')

const ragChatSrc = readSource('RAG_Agent/server/api/chat.post.ts')
assert(ragChatSrc.includes('isManagerSubAgentSessionId'), 'RAG chat detects manager step session')
assert(ragChatSrc.includes('!isManagerStepSession'), 'RAG chat skips session backfill for step session')
assert(ragChatSrc.includes('resolveRagStandaloneTurnScope'), 'RAG standalone turnScope wired')

const dbPrepSrc = readSource('DB_Agent/utils/graph/postProcess.ts')
assert(dbPrepSrc.includes('resolveDbStandaloneTurnScope'), 'DB standalone turnScope wired')
assert(dbPrepSrc.includes('createPrepareGraphInput'), 'DB prepare graph input present')

const evo = buildEvolutionApplied({ promptPatches: [{ id: 'p1', stage: 'sql', hits: 2 }], experienceHits: 1, banditArm: 'arm_a' })
assert(evo.experienceHits === 1 && evo.banditArm === 'arm_a', 'evolutionApplied builder')
assert(extractEvolutionApplied({ evolutionApplied: evo })?.experienceHits === 1, 'evolutionApplied extract')

const stepEvtSrc = readSource('Manager_Agent/server/graph/core/output/stepResultEvent.ts')
assert(stepEvtSrc.includes('evolutionApplied'), 'step_result carries evolutionApplied')

// 短承接禁跑题：lean 必须锚定上轮任务
const anchorTask = '养老机构服务规范中护理员配比标准是多少'
assert(shouldGroundFollowupQuery({ turnKind: 'output_followup', lastUser: '再详细一点', anchorTask }), 'followup needs ground')
const grounded = groundFollowupQuery({
  lastUser: '再详细一点',
  turnKind: 'output_followup',
  anchorTask,
  candidate: '提取养老机构服务规范中关于远程护理慢性病管理及远程心理学情绪支持的具体条款'
})
assert(/护理员配比|配比标准/.test(grounded), `grounded must keep ratio topic: ${grounded}`)
assert(!/远程护理|慢性病|心理学/.test(grounded), `grounded must not invent remote nursing: ${grounded}`)
assert(
  isFollowupQueryUngrounded(
    '提取养老机构服务规范中关于远程护理慢性病管理及远程心理学情绪支持的具体条款',
    anchorTask
  ),
  'invented remote nursing must be ungrounded'
)

const dbStepSrc = readSource('Manager_Agent/server/graph/core/db/dbStepQuestion.ts')
assert(dbStepSrc.includes('groundFollowupQuery'), 'dbStepQuestion grounds followup')
const orchInvSrc = readSource('Manager_Agent/server/graph/orchestrate/orchestratorInvariants.ts')
assert(orchInvSrc.includes('groundOrchestratorFollowupBundle'), 'orchestrator grounds followup bundle')
assert(ragExecSrc.includes('groundFollowupQuery'), 'ragExecute grounds followup lean')

console.log('smoke-memory-coordination: OK')
