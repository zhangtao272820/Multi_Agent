/**
 * MANAGER_DISABLED_AGENTS：轻量集群踢出 music/video
 */
import {
  parseDisabledAgents,
  activeCapabilityRegistry,
  isCapabilityDisabled
} from '../../../server/graph/core/agent/capabilities'
import { stripDisabledAgents, buildAgentRegistry } from '../../../server/graph/core/agent/agentRegistry'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke:disabled-agents] ${msg}`)
}

const env = { MANAGER_DISABLED_AGENTS: 'music,video' } as NodeJS.ProcessEnv
assert(parseDisabledAgents(env).has('music') && parseDisabledAgents(env).has('video'), 'parse music+video')
assert(isCapabilityDisabled('music', env), 'music disabled')
assert(!isCapabilityDisabled('rag', env), 'rag enabled')
assert(
  !activeCapabilityRegistry(env).some((c) => c.id === 'music' || c.id === 'video'),
  'active registry excludes media'
)
assert(
  stripDisabledAgents(['db', 'music', 'rag', 'video'], env).join(',') === 'db,rag',
  'strip media from cap'
)

const snap = buildAgentRegistry(env)
assert(!snap.entries.some((e) => e.id === 'music' || e.id === 'video'), 'registry snapshot excludes')

assert(parseDisabledAgents({} as NodeJS.ProcessEnv).size === 0, 'empty env keeps all')

const coreEnv = { MANAGER_DISABLED_AGENTS: 'music,video,gui' } as NodeJS.ProcessEnv
assert(parseDisabledAgents(coreEnv).has('gui'), 'core/public disables gui')
assert(stripDisabledAgents(['db', 'gui', 'rag'], coreEnv).join(',') === 'db,rag', 'strip gui')
assert(!activeCapabilityRegistry(coreEnv).some((c) => c.id === 'gui'), 'active registry excludes gui')

console.log('smoke:disabled-agents: OK')
