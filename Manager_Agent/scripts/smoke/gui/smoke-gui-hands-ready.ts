/**
 * GUI Hands 就绪分流：desktop 未起 → hands_not_ready，禁止假成功
 */
import assert from 'node:assert/strict'
import { resolveIsDesktopGuiTask } from '../../../server/graph/core/agent/guiTaskPayload'
import {
  HANDS_NOT_READY_ERROR_CODE,
  HANDS_NOT_READY_MESSAGE,
  httpBaseFromLobsterWsUrl,
  isDesktopEngineReady,
  resolveGuiDesktopWsUrl,
  resolveLobsterHandsHttpBase,
  resolveLobsterHandsWsUrl,
  type LobsterReadyProbe,
} from '../../../server/utils/gui/guiHandsReady'

assert.equal(resolveLobsterHandsWsUrl({} as NodeJS.ProcessEnv), '')
assert.equal(
  resolveLobsterHandsWsUrl({ LOBSTER_HANDS_WS_URL: 'ws://127.0.0.1:13109/_ws' } as NodeJS.ProcessEnv),
  'ws://127.0.0.1:13109/_ws',
)

assert.equal(httpBaseFromLobsterWsUrl('ws://127.0.0.1:13109/_ws'), 'http://127.0.0.1:13109')
assert.equal(
  resolveLobsterHandsHttpBase({ LOBSTER_HANDS_HTTP_URL: 'http://host:13109/' } as NodeJS.ProcessEnv),
  'http://host:13109',
)
assert.equal(
  resolveLobsterHandsHttpBase({
    LOBSTER_HANDS_WS_URL: 'ws://127.0.0.1:13109/_ws',
  } as NodeJS.ProcessEnv),
  'http://127.0.0.1:13109',
)

assert.equal(
  resolveGuiDesktopWsUrl({
    lobsterAgentWsUrl: 'ws://127.0.0.1:13108/_ws',
    env: { LOBSTER_HANDS_WS_URL: 'ws://127.0.0.1:13109/_ws' } as NodeJS.ProcessEnv,
  }),
  'ws://127.0.0.1:13109/_ws',
)
assert.equal(
  resolveGuiDesktopWsUrl({
    lobsterAgentWsUrl: 'ws://127.0.0.1:13108/_ws',
    env: {} as NodeJS.ProcessEnv,
  }),
  'ws://127.0.0.1:13108/_ws',
)

// task_kind=desktop_app → Hands 路径（与关键词无关）
assert.equal(
  resolveIsDesktopGuiTask({
    taskKind: 'desktop_app',
    task: '帮我处理一下这个文件',
  }),
  true,
  'desktop_app → Hands',
)
assert.equal(
  resolveIsDesktopGuiTask({
    taskKind: 'navigate',
    task: '打开记事本输入 Hello',
  }),
  false,
  'web task_kind 不被桌面关键词抢路由',
)
assert.equal(
  resolveIsDesktopGuiTask({
    taskKind: 'mobile_app',
    task: '打开微信',
  }),
  false,
  'mobile_app 不走 Windows Hands',
)
assert.equal(
  resolveIsDesktopGuiTask({
    taskKind: 'desktop_app',
    task: 'x',
  })
    ? resolveGuiDesktopWsUrl({
        lobsterAgentWsUrl: 'ws://127.0.0.1:13108/_ws',
        env: { LOBSTER_HANDS_WS_URL: 'ws://127.0.0.1:13109/_ws' } as NodeJS.ProcessEnv,
      })
    : '',
  'ws://127.0.0.1:13109/_ws',
  'desktop_app 使用 Hands WS',
)

const down: LobsterReadyProbe = { ok: false, error: 'fetch failed' }
assert.equal(isDesktopEngineReady(down), false)

const up: LobsterReadyProbe = {
  ok: true,
  ready: true,
  handsOnly: true,
  engines: { desktop: { ok: true, toolCount: 3 } },
}
assert.equal(isDesktopEngineReady(up), true)

const softDown: LobsterReadyProbe = {
  ok: true,
  ready: false,
  engines: { desktop: { ok: false, error: 'disabled' } },
  desktop: { ok: false, enabled: true },
}
assert.equal(isDesktopEngineReady(softDown), false)

assert.ok(HANDS_NOT_READY_MESSAGE.includes('Hands'))
assert.equal(HANDS_NOT_READY_ERROR_CODE, 'hands_not_ready')

console.log('smoke: gui hands-ready ok')
