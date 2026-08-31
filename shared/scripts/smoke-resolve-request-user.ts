/**
 * 契约 smoke：权威 userId / 会话归属（纯函数，不调 LLM / 不连库）
 * 用法：npx tsx shared/scripts/smoke-resolve-request-user.ts
 */
import {
  evaluateSessionOwnership,
  pickAuthoritativeUserId
} from '../resolveRequestUser.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[smoke-resolve-request-user] ${msg}`)
}

// browser：强制 JWT.sub
{
  const ok = pickAuthoritativeUserId({
    mode: 'browser',
    jwtUserId: 'admin',
    claimedUserId: 'admin'
  })
  assert(ok.ok && ok.userId === 'admin', 'browser match')
}

{
  const bad = pickAuthoritativeUserId({
    mode: 'browser',
    jwtUserId: 'admin',
    claimedUserId: 'other'
  })
  assert(!bad.ok && bad.statusCode === 403, 'browser mismatch → 403')
}

{
  const noJwt = pickAuthoritativeUserId({
    mode: 'browser',
    jwtUserId: '',
    claimedUserId: 'admin'
  })
  assert(!noJwt.ok && noJwt.statusCode === 401, 'browser no jwt → 401')
}

{
  const ignoreClaim = pickAuthoritativeUserId({
    mode: 'browser',
    jwtUserId: 'admin',
    claimedUserId: null
  })
  assert(ignoreClaim.ok && ignoreClaim.userId === 'admin', 'browser uses jwt only')
}

// internal：允许 header / claimed
{
  const h = pickAuthoritativeUserId({
    mode: 'internal',
    headerUserId: 'mgr_user',
    claimedUserId: 'ignored_if_header'
  })
  assert(h.ok && h.userId === 'mgr_user', 'internal prefers X-User-Id')
}

{
  const c = pickAuthoritativeUserId({
    mode: 'internal',
    claimedUserId: 'from_body'
  })
  assert(c.ok && c.userId === 'from_body', 'internal claimed')
}

// open：fallback local
{
  const o = pickAuthoritativeUserId({ mode: 'open' })
  assert(o.ok && o.userId === 'local', 'open fallback local')
}

{
  const o2 = pickAuthoritativeUserId({
    mode: 'open',
    claimedUserId: 'uid_abc'
  })
  assert(o2.ok && o2.userId === 'uid_abc', 'open claimed')
}

// ownership
{
  const own = evaluateSessionOwnership({ userId: 'admin', ownerUserId: 'admin' })
  assert(own.ok && !own.unbound, 'owner match')
}

{
  const steal = evaluateSessionOwnership({ userId: 'admin', ownerUserId: 'other' })
  assert(!steal.ok && steal.statusCode === 403, 'owner mismatch')
}

{
  const unbound = evaluateSessionOwnership({ userId: 'admin', ownerUserId: null })
  assert(unbound.ok && unbound.unbound, 'unbound allowed')
}

{
  const deny = evaluateSessionOwnership({
    userId: 'admin',
    ownerUserId: null,
    allowUnbound: false
  })
  assert(!deny.ok && deny.statusCode === 403, 'unbound denied')
}

console.log('smoke-resolve-request-user: OK')
