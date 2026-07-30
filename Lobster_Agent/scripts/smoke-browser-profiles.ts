/**
 * P2-C1：浏览器双 Profile smoke（纯函数，不启动浏览器）
 */
import path from 'node:path'
import {
  browserProfileLabel,
  isUserBrowserProfile,
  managedBrowserProfileDir,
  resolveBrowserCdpUrl,
  resolveBrowserProfile,
} from '../server/services/browserProfiles'
import { reorderChainForBrowserProfile, reorderChainForHeadlessMcpSidecar } from '../server/services/lobsterTaskSpec'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(resolveBrowserProfile({ LOBSTER_BROWSER_PROFILE: 'managed' }) === 'managed', 'default managed')
assert(resolveBrowserProfile({ LOBSTER_BROWSER_PROFILE: 'user' }) === 'user', 'user mode')

const managedDir = managedBrowserProfileDir('demo_user')
assert(managedDir.includes('managed'), 'managed path segment')
assert(managedDir.includes('demo_user'), 'profile id in path')
assert(path.isAbsolute(managedDir) || managedDir.includes('browser-profiles'), 'managed dir shape')

assert(!isUserBrowserProfile({ LOBSTER_BROWSER_PROFILE: 'managed' }), 'managed not user cdp')
assert(
  !isUserBrowserProfile({ LOBSTER_BROWSER_PROFILE: 'user' }),
  'user without cdp url → not active user profile',
)
assert(
  isUserBrowserProfile({
    LOBSTER_BROWSER_PROFILE: 'user',
    LOBSTER_BROWSER_CDP_URL: 'ws://127.0.0.1:9222/devtools/browser/abc',
  }),
  'user + cdp url active',
)

assert(
  resolveBrowserCdpUrl({ LOBSTER_BROWSER_CDP_URL: 'ws://a', LOBSTER_CDP_URL: 'ws://b' }) === 'ws://a',
  'CDP url priority',
)
assert(browserProfileLabel('managed') === 'managed', 'label managed')
assert(browserProfileLabel('user', 'ws://127.0.0.1:9222').startsWith('user-cdp:'), 'label user')

const chain = ['mcp', 'stagehand', 'classic'] as const
const prevProfile = process.env.LOBSTER_BROWSER_PROFILE
const prevCdp = process.env.LOBSTER_BROWSER_CDP_URL
process.env.LOBSTER_BROWSER_PROFILE = 'user'
process.env.LOBSTER_BROWSER_CDP_URL = 'ws://127.0.0.1:9222/devtools/browser/test'
try {
  const reordered = reorderChainForBrowserProfile([...chain], 'user')
  assert(reordered[0] === 'classic', 'user+cdp prefers classic first')
} finally {
  if (prevProfile === undefined) delete process.env.LOBSTER_BROWSER_PROFILE
  else process.env.LOBSTER_BROWSER_PROFILE = prevProfile
  if (prevCdp === undefined) delete process.env.LOBSTER_BROWSER_CDP_URL
  else process.env.LOBSTER_BROWSER_CDP_URL = prevCdp
}

process.env.LOBSTER_MCP_HEADLESS_SIDECAR = '1'
// Stagehand-only：Docker 无头不再改写引擎链
const baiduChain = reorderChainForHeadlessMcpSidecar(
  ['stagehand'],
  '打开 https://www.baidu.com/ 搜索 Python',
  'https://www.baidu.com/',
)
assert(baiduChain[0] === 'stagehand' && baiduChain.length === 1, 'web chain stays stagehand-only')

const loginChain = reorderChainForHeadlessMcpSidecar(
  ['stagehand'],
  '登录后打开后台',
  'https://example.com/login',
  {
    canonical_task: '登录后打开后台',
    engine_hint: 'auto',
    task_kind: 'login',
    browser_profile: 'managed',
    needs_login: true,
    explicitly_avoid_login: false,
    confidence: 0.8,
    rationale: 'smoke',
    source: 'llm',
    plan_steps: [],
    goals: {},
  },
)
assert(loginChain[0] === 'stagehand', 'needs_login no longer injects classic')

console.log('smoke-browser-profiles: PASS')
