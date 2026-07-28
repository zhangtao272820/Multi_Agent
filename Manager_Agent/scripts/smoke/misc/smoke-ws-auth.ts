/**
 * S1：WS 鉴权配置契约（AUTH_MODE=token 须配 token；默认无 AUTH 不强制）
 */
import {
  getManagerWsAuthConfigStatus,
  isManagerWsAuthEnabled,
  resolveManagerWsExpectedToken,
  validateManagerWsAuth
} from '../../../server/graph/core/runtime/wsAuth'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const saved = {
  MANAGER_WS_AUTH: process.env.MANAGER_WS_AUTH,
  MANAGER_AUTH_MODE: process.env.MANAGER_AUTH_MODE,
  MANAGER_WS_TOKEN: process.env.MANAGER_WS_TOKEN,
  CLAWHIVE_INTERNAL_TOKEN: process.env.CLAWHIVE_INTERNAL_TOKEN,
  MANAGER_OPS_TOKEN: process.env.MANAGER_OPS_TOKEN
}

function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function clearAuthEnv() {
  delete process.env.MANAGER_WS_AUTH
  delete process.env.MANAGER_AUTH_MODE
  delete process.env.MANAGER_WS_TOKEN
  delete process.env.CLAWHIVE_INTERNAL_TOKEN
  delete process.env.MANAGER_OPS_TOKEN
}

try {
  clearAuthEnv()
  assert(!isManagerWsAuthEnabled(), 'default: auth off')
  assert(getManagerWsAuthConfigStatus().ok, 'default: config ok')
  assert(validateManagerWsAuth({}).ok, 'default: validate open')

  process.env.MANAGER_AUTH_MODE = 'token'
  assert(isManagerWsAuthEnabled(), 'AUTH_MODE=token enables auth')
  assert(!getManagerWsAuthConfigStatus().ok, 'token mode without token: config not ok')
  assert(getManagerWsAuthConfigStatus().detail === 'auth_token_required_but_missing', 'missing detail')
  assert(!validateManagerWsAuth({ messageToken: 'any' }).ok, 'validate fails without expected token')

  process.env.MANAGER_WS_TOKEN = 'good-token'
  assert(getManagerWsAuthConfigStatus().ok, 'token mode with token: config ok')
  assert(resolveManagerWsExpectedToken() === 'good-token', 'expected token')
  assert(validateManagerWsAuth({ messageToken: 'good-token' }).ok, 'correct token ok')
  assert(!validateManagerWsAuth({ messageToken: 'bad-token' }).ok, 'wrong token rejected')
  assert(
    validateManagerWsAuth({
      headers: { 'x-manager-ws-token': 'good-token' }
    }).ok,
    'header token ok'
  )

  clearAuthEnv()
  process.env.MANAGER_WS_AUTH = '1'
  process.env.CLAWHIVE_INTERNAL_TOKEN = 'claw-tok'
  assert(isManagerWsAuthEnabled(), 'WS_AUTH=1 enables')
  assert(getManagerWsAuthConfigStatus().ok, 'clawhive token satisfies config')
  assert(validateManagerWsAuth({ messageToken: 'claw-tok' }).ok, 'clawhive token validates')

  console.log('smoke-ws-auth: OK')
} finally {
  restoreEnv()
}
