/**
 * P1-1 薄：promote verify 默认开启；不调 LLM。
 */
import {
  isExpertAutoPromoteAllowed,
  isPromoteVerifyRequired,
  isUnverifiedPromoteAllowed
} from '#agent-shared/evolutionPromotePolicy'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-promote-verify-gate] ${msg}`)
}

console.log('smoke-promote-verify-gate: start')

assert(isPromoteVerifyRequired({} as NodeJS.ProcessEnv), 'default promote verify required')
assert(!isUnverifiedPromoteAllowed({} as NodeJS.ProcessEnv), 'default unverified promote off')
assert(!isExpertAutoPromoteAllowed({} as NodeJS.ProcessEnv), 'default expert auto-promote off')

assert(
  !isPromoteVerifyRequired({ EVO_ALLOW_UNVERIFIED_PROMOTE: '1' } as NodeJS.ProcessEnv),
  'explicit unverified opens gate'
)
assert(
  !isPromoteVerifyRequired({ EVO_PROMOTE_REQUIRES_VERIFY: '0' } as NodeJS.ProcessEnv),
  'explicit verify off'
)
assert(
  isExpertAutoPromoteAllowed({ EVO_ALLOW_EXPERT_AUTO_PROMOTE: '1' } as NodeJS.ProcessEnv),
  'explicit expert auto-promote'
)

console.log('smoke-promote-verify-gate: OK')
