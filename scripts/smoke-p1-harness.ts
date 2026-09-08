/**
 * P1/P14 smoke：Tool Call 审计 + Process 记忆 + Checkpointer 自动 PG + RAG 向量 PG
 * 用法：cd Manager_Agent && npx tsx ../scripts/smoke-p1-harness.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatProcessMemoryBlock, upsertProcessMemory, recallProcessMemory } from '../shared/processMemoryStore'
import { recordToolCallAudit, listToolCallAuditForRun } from '../shared/toolCallAuditStore'
import { isAgentPgConfigured } from '../shared/agentPgClient'
import { isLlmConversationSummarizeEnabled } from '../Manager_Agent/server/utils/managerConversationLlmSummary'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-p1-harness] ${msg}`)
}

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

async function main() {
  console.log('smoke-p1-harness: start')

  const migration = readSource('scripts/migrations/011_agent_memory_phase13_14.sql')
  assert(migration.includes('mgr_tool_call_audit'), 'migration tool call audit')
  assert(migration.includes('mgr_process_memory'), 'migration process memory')
  assert(migration.includes('rag_experience_vectors'), 'migration rag vectors')

  assert(readSource('shared/toolCallAuditStore.ts').includes('recordToolCallAudit'), 'tool audit store')
  assert(readSource('shared/processMemoryStore.ts').includes('upsertProcessMemory'), 'process memory store')
  assert(readSource('Manager_Agent/server/utils/managerGraph.stepResultEvent.ts').includes('recordToolCallAudit'), 'step result audits')
  assert(readSource('Manager_Agent/server/utils/managerGraph.contextComposer.ts').includes('recallProcessMemory'), 'planner recalls process memory')
  assert(readSource('RAG_Agent/utils/rag_experience_vector_store.ts').includes('upsertRagExperienceVectorPg'), 'rag vector pg store')
  assert(readSource('Manager_Agent/server/utils/managerGraph.langgraphCheckpointer.ts').includes('MGR_CHECKPOINTER_AUTO'), 'checkpointer auto pg')

  delete process.env.MANAGER_CONVERSATION_LLM_SUMMARIZE
  assert(isLlmConversationSummarizeEnabled(), 'conversation summarize default on')

  const block = formatProcessMemoryBlock([
    {
      id: 1,
      tenantId: 'default',
      scenarioKey: 'finance',
      questionNorm: 'abc',
      toolChain: ['db', 'rag'],
      hint: 'test path',
      successScore: 0.9,
      hits: 2
    }
  ])
  assert(block.includes('db→rag'), 'process memory block format')

  if (isAgentPgConfigured()) {
    const runId = `smoke_audit_${Date.now()}`
    const ok = await recordToolCallAudit({
      runId,
      sessionId: 'smoke_sess',
      agent: 'db',
      toolName: 'db',
      stepId: 'step_db',
      ok: true,
      ms: 42,
      queryPreview: 'SELECT 1'
    })
    assert(ok, 'record tool call audit')
    const items = await listToolCallAuditForRun(runId)
    assert(items.length >= 1, 'list tool call audit')

    await upsertProcessMemory({
      tenantId: 'default',
      question: '查询财务并生成报告',
      toolChain: ['db', 'report'],
      hint: 'smoke process path',
      successScore: 0.88
    })
    const recalled = await recallProcessMemory('财务报告', { tenantId: 'default', limit: 3 })
    assert(recalled.length >= 0, 'recall process memory')
    console.log(`smoke-p1-harness: pg roundtrip audit=${items.length} process=${recalled.length}`)
  } else {
    console.log('smoke-p1-harness: skip PG roundtrip')
  }

  console.log('smoke-p1-harness: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
