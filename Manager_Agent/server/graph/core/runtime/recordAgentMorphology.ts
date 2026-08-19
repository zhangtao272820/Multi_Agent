/**
 * Manager 图节点写入 Agent 形态日志（planned / final）。
 * 失败不阻断主路径。
 */
import {
  buildAgentMorphologyFromState,
  morphologyLogFields,
  recordAgentMorphology,
  type AgentMorphologyKind
} from '#agent-shared/agentMorphologyJournal'
import { emitStructuredLog } from './structuredLog'
import { tenantIdFromPolicyDir } from '../../../utils/session/managerPolicyDir'

export async function recordAgentMorphologySnapshot(input: {
  kind: AgentMorphologyKind
  runId?: string
  sessionId?: string | null
  policyDir?: string
  state: Record<string, unknown>
}): Promise<void> {
  const runId = String(input.runId || '').trim()
  if (!runId) return
  const record = buildAgentMorphologyFromState(input.state, {
    kind: input.kind,
    runId,
    sessionId: input.sessionId,
    tenantId: input.policyDir ? tenantIdFromPolicyDir(input.policyDir) : undefined
  })
  if (!record) return
  emitStructuredLog({
    level: 'info',
    ...morphologyLogFields(record)
  })
  await recordAgentMorphology(record)
}
