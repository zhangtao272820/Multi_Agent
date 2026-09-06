/**
 * 契约：Docker 暖机鉴权 — login 重试 / 401 勿误杀 / 本地 validate / compose depends。
 * 不调 LLM、不连外部服务。
 * 运行：cd Manager_Agent && npx tsx scripts/smoke/gate/smoke-auth-warmup.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shouldForceLogoutOn401 } from '../../../agent-repo-shared/clawhiveAuthForceLogout.ts'
import {
  buildLocalAuthValidateResponse,
  isPublicAgentPath
} from '../../../agent-repo-shared/nitroClawhiveAuth.ts'
import { proxyClawhiveLogin } from '../../../agent-repo-shared/clawhiveLoginProxy.ts'
import { createHmac } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function mintJwt(secret: string, sub: string, expSec = 3600): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      sub,
      role: 'admin',
      tenant_id: 'default',
      exp: Math.floor(Date.now() / 1000) + expSec
    })
  )
  const data = `${header}.${payload}`
  const sig = createHmac('sha256', secret).update(data).digest()
  return `${data}.${b64url(sig)}`
}

console.log('smoke-auth-warmup: start')

// —— shouldForceLogoutOn401 ——
assert.equal(shouldForceLogoutOn401({ status: 500 }), false)
assert.equal(
  shouldForceLogoutOn401({
    status: 401,
    statusMessage: 'invalid_user_token',
    hasLocalToken: true
  }),
  true,
  'invalid token → logout'
)
assert.equal(
  shouldForceLogoutOn401({
    status: 401,
    statusMessage: 'login_required',
    hasLocalToken: true
  }),
  false,
  'login_required with local token → keep'
)
assert.equal(
  shouldForceLogoutOn401({
    status: 401,
    statusMessage: 'login_required',
    hasLocalToken: false
  }),
  true,
  'login_required without token → logout'
)
assert.equal(
  shouldForceLogoutOn401({
    status: 401,
    statusMessage: 'Unauthorized',
    body: { detail: 'something_else' },
    hasLocalToken: true
  }),
  false,
  'arbitrary 401 must not force logout'
)

// —— isPublicAgentPath ——
assert.ok(isPublicAgentPath('/api/auth/validate'))
assert.ok(isPublicAgentPath('/api/auth/login'))
assert.equal(isPublicAgentPath('/api/manager/session'), false)

// —— buildLocalAuthValidateResponse ——
{
  const env = { AGENT_BROWSER_AUTH: '1', JWT_SECRET: 'smoke-secret' } as NodeJS.ProcessEnv
  const noTok = buildLocalAuthValidateResponse({ node: { req: { headers: {} } } }, env)
  assert.equal(noTok.ok, false)
  assert.equal(noTok.reason, 'login_required')

  const token = mintJwt('smoke-secret', 'admin')
  const ok = buildLocalAuthValidateResponse(
    { node: { req: { headers: { authorization: `Bearer ${token}` } } } },
    env
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.user_id, 'admin')

  const bad = buildLocalAuthValidateResponse(
    { node: { req: { headers: { authorization: 'Bearer not.a.jwt' } } } },
    env
  )
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'invalid_user_token')
}

// —— proxyClawhiveLogin retry ——
{
  let n = 0
  const delays: number[] = []
  const fakeFetch = (async () => {
    n += 1
    if (n < 3) throw new Error('ECONNREFUSED')
    return {
      status: 200,
      json: async () => ({ access_token: 'tok', username: 'admin' })
    } as Response
  }) as unknown as typeof fetch

  const r = await proxyClawhiveLogin('admin', 'x', { CLAWHIVE_BACKEND_URL: 'http://example' } as any, {
    attempts: 5,
    baseDelayMs: 5,
    maxDelayMs: 20,
    sleep: async (ms) => {
      delays.push(ms)
    },
    fetchImpl: fakeFetch
  })
  assert.equal(r.status, 200)
  assert.equal(n, 3)
  assert.ok(delays.length >= 2, 'login proxy retried')
}

{
  let n = 0
  const fakeFetch = (async () => {
    n += 1
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  const r = await proxyClawhiveLogin('admin', 'x', { CLAWHIVE_BACKEND_URL: 'http://example' } as any, {
    attempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 5,
    sleep: async () => {},
    fetchImpl: fakeFetch
  })
  assert.equal(r.status, 502)
  assert.equal(r.body.detail, 'clawhive_login_warming')
  assert.equal(n, 3)
}

// —— compose text contract ——
const compose = readSource('Manage-platform_Agent/docker-compose.agents-lan.yml')
for (const svc of ['db_agent', 'rag_agent', 'manager_agent', 'lobster_agent']) {
  const idx = compose.indexOf(`\n  ${svc}:`)
  assert.ok(idx >= 0, `${svc} present`)
  // manager 环境块很长：取到下一顶级服务或更大窗口
  const nextTop = compose.indexOf('\n  ', idx + 4)
  const end = nextTop > idx ? Math.min(nextTop + 8000, compose.length) : Math.min(idx + 12000, compose.length)
  // 更稳：从本服务起向后搜 depends_on + clawhive_backend
  const window = compose.slice(idx, idx + 20000)
  const depIdx = window.indexOf('depends_on:')
  assert.ok(depIdx >= 0, `${svc} has depends_on`)
  const depBlock = window.slice(depIdx, depIdx + 1200)
  assert.ok(depBlock.includes('clawhive_backend:'), `${svc} depends clawhive_backend`)
  assert.ok(depBlock.includes('service_healthy'), `${svc} waits healthy`)
  void end
}

// —— client plugins use shared helper ——
for (const rel of [
  'Manager_Agent/app/plugins/clawhive-auth.client.ts',
  'RAG_Agent/app/plugins/clawhive-auth.client.ts',
  'DB_Agent/app/plugins/clawhive-auth.client.ts',
  'Lobster_Agent/app/plugins/clawhive-auth.client.ts'
]) {
  const src = readSource(rel)
  assert.ok(src.includes('shouldForceLogoutOn401'), `${rel} uses shared force-logout`)
  assert.ok(!src.includes('|| true'), `${rel} must not force logout on any 401`)
}

assert.ok(
  readSource('Manager_Agent/server/api/auth/validate.get.ts').includes('buildLocalAuthValidateResponse'),
  'manager validate route'
)
assert.ok(
  readSource('Manager_Agent/server/utils/platform/managerUserAuth.ts').includes(
    'extractUserTokenFromPeerHeaders'
  ),
  'WS reads peer cookie/header JWT'
)

console.log('smoke-auth-warmup: OK')
