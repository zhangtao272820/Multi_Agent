/**
 * Agent 形态日志：从 graph state 抽出协同形状，jsonl 可回读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAgentMorphologyFromState,
  inferMorphologyOutcome,
  listAgentMorphology,
  recordAgentMorphology
} from '#agent-shared/agentMorphologyJournal'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const planned = buildAgentMorphologyFromState(
  {
    intent: 'multi',
    allowedAgents: ['db', 'rag', 'report'],
    plan: [
      { id: 's1', agent: 'db', queryFocus: '查在院人数', dependsOn: [] },
      { id: 's2', agent: 'rag', queryFocus: '制度出处', dependsOn: [] },
      { id: 's3', agent: 'report', queryFocus: '汇总', dependsOn: ['s1', 's2'] }
    ],
    probe: { db: { pingOk: true, matched: true, tables: ['t1'] }, rag: { hasDocs: true, hits: 3 } },
    meta: {
      taskIntent: 'hybrid',
      taskForm: 'db_count',
      needsClarify: false,
      routeAuthorityChain: {
        sourceCommitment: 'clear',
        committedPlanes: ['db', 'rag'],
        turnScopeMode: 'current_only',
        turnKind: 'new_task',
        allowedAgents: ['db', 'rag', 'report']
      },
      orchestratorRaw: {
        taskIntent: 'hybrid',
        taskForm: 'db_count',
        isMulti: true,
        clauses: [{ layer: 'data', agents: ['db'], text: '查在院人数' }]
      }
    }
  },
  { kind: 'planned', runId: 'run-morph-1', sessionId: 'sess-1' }
)

assert(planned, 'planned record')
assert(planned!.allowedAgents.join(',') === 'db,rag,report', 'allowedAgents')
assert(planned!.plan.length === 3, 'plan steps')
assert(planned!.plan[0]?.blast_radius === 't0', 'db step t0')
assert(planned!.plan[2]?.blast_radius === 't0', 'report step t0')
assert(planned!.blast_radius === 't0', 'planned max t0')
assert(planned!.plan[2]?.dependsOn?.includes('s1'), 'DAG dependsOn')
assert(planned!.taskIntent === 'hybrid', 'taskIntent')
assert(planned!.taskForm === 'db_count', 'taskForm')
assert(planned!.sourceCommitment === 'clear', 'sourceCommitment')
assert(planned!.probe?.db?.tableCount === 1, 'probe tableCount')
assert(planned!.clauses?.[0]?.layer === 'data', 'clause layer')
assert(planned!.isMulti === true, 'isMulti')

const finalRec = buildAgentMorphologyFromState(
  {
    intent: 'db',
    allowedAgents: ['db'],
    evidence: [{ kind: 'db', agentResult: { agent: 'db', ok: false, error_code: 'timeout' } }],
    meta: {
      lastStepRecords: [{ agent: 'db', status: 'error', error_code: 'timeout' }],
      evidenceGate: { pass: false, reason: '查数任务未获得有效数据依据' },
      needsClarify: false,
      experienceReplayCount: 2,
      memoryRecallExplain: { count: 2, pathConflictDropped: 1 },
      pendingPrefsProposal: { conflictNote: '专家偏好冲突：现有=rag；新提议=admin' },
      memoryCaptureProposal: { kind: 'save_preference', status: 'draft_pending_review' },
    }
  },
  { kind: 'final', runId: 'run-morph-2' }
)
assert(finalRec?.experts?.[0]?.error_code === 'timeout', 'expert error_code')
assert(finalRec?.outcome === 'failed', 'failed outcome')
assert(finalRec?.evidenceGate?.pass === false, 'evidence gate')
assert(finalRec?.memoryGovernance?.pathConflictDropped === 1, 'path conflict in morphology')
assert(finalRec?.memoryGovernance?.pendingPrefsConflict?.includes('专家偏好冲突'), 'prefs conflict tag')
assert(finalRec?.memoryGovernance?.memoryCaptureKind === 'save_preference', 'capture kind')

assert(
  inferMorphologyOutcome({ kind: 'final', needsClarify: true }) === 'clarify',
  'clarify outcome'
)
assert(
  inferMorphologyOutcome({ kind: 'final', needsHumanConfirm: true }) === 'needs_human',
  'hitl outcome'
)

const adminMorph = buildAgentMorphologyFromState(
  {
    intent: 'admin',
    allowedAgents: ['admin'],
    plan: [{ id: 'a1', agent: 'admin', queryFocus: '发邮件' }],
    meta: {}
  },
  { kind: 'planned', runId: 'run-morph-admin' }
)
assert(adminMorph?.plan[0]?.blast_radius === 't2', 'admin step t2')
assert(adminMorph?.blast_radius === 't2', 'admin planned max t2')

const tmp = path.join(os.tmpdir(), `mgr-morph-${Date.now()}.jsonl`)
process.env.MANAGER_MORPHOLOGY_LOG_PATH = tmp
process.env.MANAGER_AGENT_MORPHOLOGY = '1'
await recordAgentMorphology(planned!)
await recordAgentMorphology(finalRec!)
const listed = await listAgentMorphology({ cwd: path.dirname(tmp), limit: 10 })
assert(listed.some((r) => r.run_id === 'run-morph-1' && r.kind === 'planned'), 'jsonl planned')
assert(listed.some((r) => r.run_id === 'run-morph-2' && r.kind === 'final'), 'jsonl final')
fs.unlinkSync(tmp)

const repoRoot = path.join(import.meta.dirname, '../../..')
const mig = fs.readFileSync(path.join(repoRoot, '../scripts/migrations/019_mgr_agent_morphology.sql'), 'utf8')
assert(mig.includes('mgr_agent_morphology'), 'migration table')
assert(mig.includes('UNIQUE (run_id, kind)'), 'unique run+kind')

const finalizeSrc = fs.readFileSync(
  path.join(repoRoot, 'server/graph/nodes/final/finalizeNodeRun.ts'),
  'utf8'
)
assert(finalizeSrc.includes('recordAgentMorphologySnapshot'), 'finalize writes morphology')
const orchSrc = fs.readFileSync(
  path.join(repoRoot, 'server/graph/nodes/orchestrate/createOrchestrateNode.ts'),
  'utf8'
)
assert(orchSrc.includes("kind: 'planned'"), 'orchestrate writes planned')
const apiSrc = fs.readFileSync(path.join(repoRoot, 'server/api/metrics/agent-morphology.get.ts'), 'utf8')
assert(apiSrc.includes('getAgentMorphologyForRun'), 'API get by run')

console.log('smoke-agent-morphology: OK')
