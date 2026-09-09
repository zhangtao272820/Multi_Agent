/**
 * Phase F：Race 默认关 + Field Guide 预算（不调 LLM）。
 */
import { isManagerRaceEnabled, fieldGuideMaxChars } from '../../../agent-repo-shared/specialistBrief'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-manager-race-gate] ${msg}`)
}

console.log('smoke-manager-race-gate: start')
assert(isManagerRaceEnabled() === false, 'default race off')
assert(isManagerRaceEnabled({ MANAGER_RACE_ENABLED: '' } as NodeJS.ProcessEnv) === false, 'empty off')
assert(isManagerRaceEnabled({ MANAGER_RACE_ENABLED: '1' } as NodeJS.ProcessEnv) === true, 'opt-in')
assert(fieldGuideMaxChars() <= 4000, 'guide cap')
console.log('smoke-manager-race-gate: ok')
