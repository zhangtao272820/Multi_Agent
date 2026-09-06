/**
 * 总管 → RAG 旁路步进会话契约：禁止复用 Manager session 污染文曲历史。
 * 用法：cd Manager_Agent && npm run smoke:rag-step-session
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSubAgentStepSessionId } from '../../../server/graph/core/routing/subAgentPassthrough'
import { isManagerSubAgentSessionId } from '#agent-shared/managerStepSession'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const supplementId = resolveSubAgentStepSessionId({
  runId: 'run-abc',
  agent: 'rag',
  stepId: 'db_supplement'
})
const fallbackId = resolveSubAgentStepSessionId({ runId: 'run-abc', agent: 'rag', stepId: 'db_fallback' })
const fixId = resolveSubAgentStepSessionId({ runId: 'run-abc', agent: 'rag', stepId: 'fix' })
assert(isManagerSubAgentSessionId(supplementId, 'rag'), `db_supplement id: ${supplementId}`)
assert(isManagerSubAgentSessionId(fallbackId, 'rag'), `db_fallback id: ${fallbackId}`)
assert(isManagerSubAgentSessionId(fixId, 'rag'), `fix id: ${fixId}`)
assert(!isManagerSubAgentSessionId('user-uuid-session', 'rag'), 'plain uuid must not look like step session')

const dbNodeSrc = readFileSync(path.join(root, 'server/graph/nodes/exec/dbNode.ts'), 'utf8')
assert(/resolveSubAgentStepSessionId/.test(dbNodeSrc), 'dbNode must import resolveSubAgentStepSessionId')
assert(/stepId:\s*'db_supplement'/.test(dbNodeSrc), 'dbNode supplement uses step session')
assert(/stepId:\s*'db_fallback'/.test(dbNodeSrc), 'dbNode fallback uses step session')
assert(!/conversationId:\s*opts\.ragConversationId/.test(dbNodeSrc), 'dbNode must not reuse Manager ragConversationId')
assert(/history:\s*\[\s*\]/.test(dbNodeSrc), 'dbNode RAG bypass must pass empty history')

const fixNodeSrc = readFileSync(path.join(root, 'server/graph/nodes/fix/createFixNode.ts'), 'utf8')
assert(/resolveSubAgentStepSessionId/.test(fixNodeSrc), 'createFixNode must use step session')
assert(/stepId:\s*'fix'/.test(fixNodeSrc), 'createFixNode rag fix uses stepId fix')
assert(/history:\s*\[\s*\]/.test(fixNodeSrc), 'createFixNode RAG must pass empty history')

const ragExecSrc = readFileSync(path.join(root, 'server/graph/core/executors/ragExecute.ts'), 'utf8')
assert(/resolveSubAgentStepSessionId/.test(ragExecSrc), 'ragExecute main path uses step session')

console.log('smoke: rag step session isolation ok')
