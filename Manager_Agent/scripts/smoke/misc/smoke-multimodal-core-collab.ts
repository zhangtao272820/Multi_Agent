/**
 * multimodal 升核心：registry + attachment orchestrator hint（无网络）
 */
import {
  EXTENDED_PROFILE_AGENTS,
  reconcileExtendedAgentAvailability
} from '../../../server/graph/core/agent/agentRegistry'
import { formatAttachmentHintForOrchestrator } from '../../../server/graph/orchestrate/unifiedRouting'
import { buildActionExecEffectiveQuery } from '../../../server/graph/core/stepIsolation/exec'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(!EXTENDED_PROFILE_AGENTS.includes('multimodal'), 'multimodal must not be extended-only')
assert(EXTENDED_PROFILE_AGENTS.includes('music'), 'music remains extended')
assert(EXTENDED_PROFILE_AGENTS.includes('video'), 'video remains extended')
assert(EXTENDED_PROFILE_AGENTS.includes('gui'), 'gui remains extended')

const mmOnlyDown = reconcileExtendedAgentAvailability('multimodal', ['multimodal'], {
  agents: [{ agent: 'multimodal', status: 'down' }]
})
assert(mmOnlyDown.blocked.length === 0, 'down multimodal is core; not blocked as extended')

const musicDown = reconcileExtendedAgentAvailability('music', ['music'], {
  agents: [{ agent: 'music', status: 'down' }]
})
assert(musicDown.blocked.includes('music'), 'down music remains extended-blocked')
assert(
  musicDown.clarifyQuestions.some((q) => q.includes('Multimodal')),
  'clarify should mention Multimodal in standard stack'
)

const hint = formatAttachmentHintForOrchestrator({ filePath: '/tmp/x.png', mediaType: 'image' })
assert(hint.includes('问题描述'), 'attachment hint mentions problem description')
assert(hint.includes('dependsOn multimodal'), 'attachment hint requires dependsOn multimodal')
assert(hint.includes('intent=multi'), 'attachment + business → multi')

const eff = buildActionExecEffectiveQuery(
  { id: 's2', agent: 'db', query: '按实体查记录', dependsOn: ['s1'] } as any,
  '结合图中信息查记录',
  '图中人物名为林婉清'
)
assert(eff.includes('林婉清'), 'upstream multimodal context injects into db query')
assert(eff.includes('已知信息'), 'upstream label present')

console.log('smoke-multimodal-core-collab ok')
