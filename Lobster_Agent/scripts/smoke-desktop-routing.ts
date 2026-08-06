/**
 * P2-C2：desktop 引擎路由 smoke（纯函数，不启动 Windows-MCP）
 */
import { requiresDesktopEngine } from '../server/services/engineSelector'
import {
  buildEngineChainFromPick,
  resolveEngineFromTaskSpec,
} from '../server/services/lobsterTaskSpec'
import { toLobsterTaskSpec } from '../server/services/lobsterTaskUnderstandSchema'
import {
  isLobsterDesktopMcpEnabled,
  isLobsterHandsOnly,
  resolveLobsterDesktopMcpServers,
} from '../server/utils/lobster_env'
import { desktopAutomationPromptAddon } from '../server/utils/lobsterSkillLoader'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(requiresDesktopEngine('打开记事本输入 Hello 并保存到桌面'), 'notepad → desktop guard')
assert(!requiresDesktopEngine('打开百度', 'https://www.baidu.com'), 'http url skips desktop guard')

const spec = toLobsterTaskSpec(
  {
    canonical_task: '打开记事本输入 Hello 并保存到桌面',
    engine_hint: 'desktop',
    task_kind: 'desktop_app',
    target_app: 'Notepad',
    confidence: 0.95,
    rationale: 'desktop smoke',
  },
  'llm',
  'managed',
)
assert(spec.task_kind === 'desktop_app', 'task_kind desktop_app')

const picked = resolveEngineFromTaskSpec({
  spec,
  task: spec.canonical_task,
  hasStorage: false,
})
assert(picked.engine === 'desktop', 'engine desktop from spec')
const chain = buildEngineChainFromPick(picked)
assert(chain.length === 1 && chain[0] === 'desktop', 'desktop chain no fallback')

const forced = resolveEngineFromTaskSpec({
  task: '任意任务',
  engineHint: 'desktop',
  hasStorage: false,
})
assert(forced.engine === 'desktop' && forced.source === 'forced', 'engine_hint desktop forced')

assert(!isLobsterDesktopMcpEnabled({ LOBSTER_DESKTOP_MCP_ENABLED: '0' }), 'default disabled')
assert(isLobsterDesktopMcpEnabled({ LOBSTER_DESKTOP_MCP_ENABLED: '1' }), 'enabled flag')
assert(
  resolveLobsterDesktopMcpServers({ LOBSTER_DESKTOP_MCP_ENABLED: '0' }) === null,
  'servers null when disabled',
)

const addon = desktopAutomationPromptAddon()
assert(addon.includes('执行规则') || addon.includes('Windows'), 'desktop skill loaded')

assert(
  !isLobsterHandsOnly({ LOBSTER_HANDS_ONLY: '0' } as NodeJS.ProcessEnv),
  'hands only default off',
)
assert(isLobsterHandsOnly({ LOBSTER_HANDS_ONLY: '1' } as NodeJS.ProcessEnv), 'hands only on')

console.log('smoke-desktop-routing: PASS')
