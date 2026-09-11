/**
 * Wave M4：路由 Phase4 cascade 默认关；仅 MANAGER_ROUTE_CASCADE=1 才扩 skip（不调 LLM）。
 */
import {
  applyCascadeSelfCheckSkip,
  isRouteCascadeEnabled
} from '../../../server/graph/core/routing/routeSkipCascade'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-route-cascade-gate] ${msg}`)
}

console.log('smoke-route-cascade-gate: start')

const prev = process.env.MANAGER_ROUTE_CASCADE
delete process.env.MANAGER_ROUTE_CASCADE
assert(isRouteCascadeEnabled() === false, 'default cascade OFF')

const base = { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: [] as string[] }
const off = applyCascadeSelfCheckSkip(base, { selfCheck: { needsSecondPass: false } })
assert(!off.reasons.includes('cascade_no_second_pass'), 'off: no cascade reason')
assert(off.skipAlign === false && off.skipPlane === false, 'off: no expanded skip')

process.env.MANAGER_ROUTE_CASCADE = '1'
assert(isRouteCascadeEnabled() === true, 'env=1 cascade ON')
const onFalse = applyCascadeSelfCheckSkip(base, { selfCheck: { needsSecondPass: false } })
assert(onFalse.reasons.includes('cascade_no_second_pass'), 'on+false: cascade reason')
assert(onFalse.skipAlign && onFalse.skipPlane, 'on+false: skip align+plane')

const onTrue = applyCascadeSelfCheckSkip(base, { selfCheck: { needsSecondPass: true } })
assert(onTrue.reasons.includes('cascade_needs_second_pass'), 'on+true: second pass')
assert(onTrue.skipAlign === true && onTrue.skipPlane === false, 'on+true: keep plane')

const blocked = applyCascadeSelfCheckSkip(
  { ...base, reasons: ['ambiguous'] },
  { selfCheck: { needsSecondPass: false } }
)
assert(!blocked.reasons.includes('cascade_no_second_pass'), 'ambiguous never cascade-expand')

if (prev === undefined) delete process.env.MANAGER_ROUTE_CASCADE
else process.env.MANAGER_ROUTE_CASCADE = prev

console.log('smoke-route-cascade-gate: ok')
