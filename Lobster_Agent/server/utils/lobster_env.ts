/** Lobster 运行时环境：执行模式与 Playwright MCP / Stagehand 配置 */

import { execSync } from 'node:child_process'

export type LobsterExecutionMode = 'classic' | 'mcp' | 'stagehand' | 'auto'

export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'streamable-http' | 'sse'; url: string; headers?: Record<string, string> }

export type McpServersConfig = Record<string, McpServerConfig>

const FORM_TASK_RE = /(登录|填表|提交|OA|后台|表单|注册)/i

export function resolveLobsterExecutionMode(): LobsterExecutionMode {
  const raw = String(process.env.LOBSTER_EXECUTION_MODE ?? 'auto').trim().toLowerCase()
  if (raw === 'classic' || raw === 'mcp' || raw === 'stagehand' || raw === 'auto') return raw
  return 'auto'
}

export function isLobsterMcpEnabled(_headlessFallback = true): boolean {
  const mode = resolveLobsterExecutionMode()
  if (mode === 'classic') return false
  if (String(process.env.LOBSTER_MCP_ENABLED ?? '1').trim() === '0') return false
  return true
}

/** 对外暴露 lobster-gui MCP（POST /api/mcp） */
export function isLobsterMcpExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LOBSTER_MCP_EXPORT ?? '1').trim() !== '0'
}

export function isStagehandEnabled(): boolean {
  if (String(process.env.LOBSTER_STAGEHAND_ENABLED ?? '1').trim() === '0') return false
  const mode = resolveLobsterExecutionMode()
  if (mode === 'classic' || mode === 'mcp') return false
  return true
}

/** Stagehand v3 要求 provider/model（如 openai/gpt-4o）；DashScope 兼容模式用 openai/qwen-* */
export function formatStagehandModelName(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return 'openai/qwen-plus'
  if (s.includes('/')) {
    const [prov, ...rest] = s.split('/')
    const name = sanitizeStagehandModelId(rest.join('/'))
    return `${prov}/${name}`
  }
  return `openai/${sanitizeStagehandModelId(s)}`
}

/**
 * DashScope + Stagehand(AI SDK) 对带日期的快照 id 常报 Unsupported model。
 * 网页 act 需要稳定模型 id（如 qwen-plus），而非 qwen-plus-2025-04-28。
 */
export function sanitizeStagehandModelId(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return 'qwen-plus'
  // qwen-plus-2025-04-28 → qwen-plus；qwen-turbo-latest 等保留
  const dated = s.match(/^(qwen-(?:plus|turbo|max|flash))-\d{4}-\d{2}-\d{2}$/i)
  if (dated) return dated[1]!.toLowerCase()
  if (/^qwen-plus-/i.test(s)) return 'qwen-plus'
  return s
}

export function resolveStagehandModelName(config?: { lobster?: { decisionModel?: string; plannerModel?: string } }): string {
  const fromCfg = String(config?.lobster?.decisionModel || config?.lobster?.plannerModel || '').trim()
  const raw = fromCfg || String(process.env.LOBSTER_STAGEHAND_MODEL || process.env.LOBSTER_DECISION_MODEL || process.env.OPENAI_MODEL || 'qwen-plus').trim()
  return formatStagehandModelName(raw)
}

/** 默认 Playwright-first；设 1 时优先 Stagehand LLM act（Qwen 常解析失败，不推荐） */
export function isStagehandLlmActPreferred(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LOBSTER_STAGEHAND_LLM_ACT ?? '0').trim() === '1'
}

function isX11DisplayReachable(): boolean {
  const display = String(process.env.DISPLAY ?? '').trim()
  if (!display) return false
  try {
    execSync(`xdpyinfo -display ${display}`, { stdio: 'ignore', timeout: 2500 })
    return true
  } catch {
    return false
  }
}

/** Headed Chromium on Linux 需要可用 X11；无 DISPLAY 或 Xvfb 未就绪时自动 headless */
export function resolveEffectiveHeadless(configHeadless: boolean): boolean {
  if (configHeadless) return true
  const p = process.platform
  if (p === 'win32' || p === 'darwin') return false
  const display = String(process.env.DISPLAY ?? '').trim()
  if (!display) return true
  return !isX11DisplayReachable()
}

function parseHeadlessFlag(): boolean {
  const v = String(process.env.LOBSTER_HEADLESS ?? 'true').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function parseJsonServers(raw: string): McpServersConfig | null {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as McpServersConfig) : null
  } catch {
    return null
  }
}

export type LobsterMcpTransport = 'sidecar-http' | 'stdio-headless' | 'stdio-headed'

/** 容器内 Xvfb 有头 MCP（覆盖 LOBSTER_MCP_URL sidecar，noVNC 可见同一 DISPLAY） */
export function shouldUseLocalHeadedMcp(env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.LOBSTER_MCP_USE_LOCAL_HEADED ?? '').trim() === '1') return true
  if (String(env.LOBSTER_MCP_USE_LOCAL_HEADED ?? '').trim() === '0') return false
  return false
}

export function lobsterMcpTransportMode(env: NodeJS.ProcessEnv = process.env): LobsterMcpTransport {
  if (shouldUseLocalHeadedMcp(env)) return 'stdio-headed'
  const httpUrl = String(env.LOBSTER_MCP_URL ?? '').trim()
  if (httpUrl) return 'sidecar-http'
  return parseHeadlessFlag() ? 'stdio-headless' : 'stdio-headed'
}

/** 默认 stdio 启动官方 @playwright/mcp；也可用 LOBSTER_MCP_URL 连独立 HTTP 服务 */
export function resolveLobsterMcpServers(): McpServersConfig | null {
  const fromEnv =
    parseJsonServers(String(process.env.LOBSTER_MCP_SERVERS ?? '')) ||
    parseJsonServers(String(process.env.MCP_SERVERS ?? process.env.MCP_SERVERS_JSON ?? ''))
  if (fromEnv && Object.keys(fromEnv).length > 0) return fromEnv

  const useLocalHeaded = shouldUseLocalHeadedMcp()
  const httpUrl = useLocalHeaded ? '' : String(process.env.LOBSTER_MCP_URL ?? '').trim()
  if (httpUrl) {
    const headers: Record<string, string> = {}
    const token = String(process.env.LOBSTER_MCP_TOKEN ?? '').trim()
    if (token) headers.Authorization = `Bearer ${token}`
    // Docker 内网访问 playwright_mcp sidecar 时需 Host=localhost（MCP 默认仅允许 localhost）
    if (/playwright_mcp/i.test(httpUrl)) {
      try {
        const u = new URL(httpUrl)
        headers.Host = `localhost:${u.port || '8931'}`
      } catch {
        headers.Host = 'localhost:8931'
      }
    }
    return { playwright: { type: 'streamable-http', url: httpUrl, headers } }
  }

  const args = ['-y', '@playwright/mcp@latest']
  const headed = useLocalHeaded || !parseHeadlessFlag()
  if (!headed) args.push('--headless')
  const browser = String(process.env.LOBSTER_MCP_BROWSER ?? 'chromium').trim()
  if (browser) args.push(`--browser=${browser}`)
  const configPath = String(process.env.LOBSTER_MCP_CONFIG ?? '').trim()
  if (configPath) args.push('--config', configPath)

  const mcpEnv: Record<string, string> = {}
  const display = String(process.env.DISPLAY ?? '').trim()
  if (headed && display) mcpEnv.DISPLAY = display
  const home = String(process.env.HOME ?? '').trim()
  if (home) mcpEnv.HOME = home
  const xdgConfig = String(process.env.XDG_CONFIG_HOME ?? '').trim()
  if (xdgConfig) mcpEnv.XDG_CONFIG_HOME = xdgConfig
  const xdgCache = String(process.env.XDG_CACHE_HOME ?? '').trim()
  if (xdgCache) mcpEnv.XDG_CACHE_HOME = xdgCache

  return {
    playwright: {
      command: String(process.env.LOBSTER_MCP_COMMAND ?? 'npx').trim() || 'npx',
      args,
      ...(Object.keys(mcpEnv).length ? { env: mcpEnv } : {}),
    }
  }
}

export function lobsterMcpMaxSteps(task?: string, startUrl?: string): number {
  const isForm = FORM_TASK_RE.test(String(task || ''))
  const envKey = isForm ? process.env.LOBSTER_MCP_MAX_STEPS_FORM : process.env.LOBSTER_MCP_MAX_STEPS
  const fallback = isForm ? 32 : 24
  let n = Number(envKey ?? fallback)
  if (!Number.isFinite(n) || n < 4) n = fallback
  const complexBonus = Number(process.env.LOBSTER_MCP_COMPLEX_STEP_BONUS ?? 8)
  const blob = `${task || ''} ${startUrl || ''}`
  const complex =
    /(iframe|shadow|SPA|懒加载|分页|验证码|弹窗|Ant\s*Design|github|w3school|动态)/i.test(blob) ||
    String(process.env.LOBSTER_MCP_FORCE_COMPLEX ?? '') === '1'
  if (complex && Number.isFinite(complexBonus) && complexBonus > 0) {
    n += Math.floor(complexBonus)
  }
  return Math.min(56, Math.floor(n))
}

export function lobsterMcpScreenshotEverySteps(): number {
  const n = Number(process.env.LOBSTER_MCP_SCREENSHOT_EVERY ?? 3)
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3
}

export function lobsterMcpFinishMinAnswerChars(): number {
  const n = Number(process.env.LOBSTER_MCP_FINISH_MIN_CHARS ?? 8)
  return Number.isFinite(n) && n >= 1 ? Math.min(80, Math.floor(n)) : 8
}

/** MCP 单步 tool 结果写入 LLM 上下文的上限（字符） */
export function lobsterMcpToolResultMaxChars(): number {
  const n = Number(process.env.LOBSTER_MCP_TOOL_RESULT_MAX_CHARS ?? 3200)
  return Number.isFinite(n) && n >= 800 ? Math.min(12_000, Math.floor(n)) : 3200
}

/** MCP ReAct 保留的最近消息条数（system + 首条 user 除外） */
export function lobsterMcpMessageWindow(): number {
  const n = Number(process.env.LOBSTER_MCP_MESSAGE_WINDOW ?? 10)
  return Number.isFinite(n) && n >= 4 ? Math.min(24, Math.floor(n)) : 10
}

/** MCP 工具目录最多展示条数 */
export function lobsterMcpToolCatalogMax(): number {
  const n = Number(process.env.LOBSTER_MCP_TOOL_CATALOG_MAX ?? 20)
  return Number.isFinite(n) && n >= 8 ? Math.min(40, Math.floor(n)) : 20
}

export function stagehandMaxActSteps(task?: string): number {
  const base = Number(process.env.LOBSTER_STAGEHAND_MAX_STEPS ?? 12)
  const n = Number.isFinite(base) && base >= 3 ? Math.floor(base) : 12
  const isForm = FORM_TASK_RE.test(String(task || ''))
  return Math.min(24, isForm ? n + 4 : n)
}

export function lobsterMcpProbeTimeoutMs(): number {
  const n = Number(process.env.LOBSTER_MCP_PROBE_MS ?? 12_000)
  return Number.isFinite(n) && n >= 2000 ? Math.min(60_000, Math.floor(n)) : 12_000
}

/** Docker 内独立 playwright_mcp sidecar（无头，noVNC 不可见） */
export function isLobsterMcpHeadlessSidecar(env: NodeJS.ProcessEnv = process.env): boolean {
  const mcpUrl = String(env.LOBSTER_MCP_URL ?? '').trim()
  if (mcpUrl && /playwright_mcp|:8931/i.test(mcpUrl)) return true
  if (String(env.LOBSTER_MCP_HEADLESS_SIDECAR ?? '').trim() === '1') return true
  return false
}

export function lobsterSessionDirEnv(): string {
  return String(process.env.LOBSTER_SESSION_DIR ?? '').trim()
}

export function lobsterCdpUrl(): string {
  return String(process.env.LOBSTER_CDP_URL ?? '').trim()
}

export type BrowserProfileMode = 'managed' | 'user'

export function resolveBrowserProfile(env: NodeJS.ProcessEnv = process.env): BrowserProfileMode {
  const v = String(env.LOBSTER_BROWSER_PROFILE ?? 'managed').trim().toLowerCase()
  return v === 'user' ? 'user' : 'managed'
}

export function resolveBrowserCdpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.LOBSTER_BROWSER_CDP_URL ?? env.LOBSTER_CDP_URL ?? '').trim()
}

/** Windows 桌面 MCP sidecar（仅 Win 宿主机；Docker 内默认关闭） */
export function isLobsterDesktopMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LOBSTER_DESKTOP_MCP_ENABLED ?? '0').trim() === '1'
}

export function resolveLobsterDesktopMcpServers(env: NodeJS.ProcessEnv = process.env): McpServersConfig | null {
  if (!isLobsterDesktopMcpEnabled(env)) return null
  const fromEnv =
    parseJsonServers(String(env.LOBSTER_DESKTOP_MCP_SERVERS ?? '')) ||
    parseJsonServers(String(env.MCP_DESKTOP_SERVERS ?? ''))
  if (fromEnv && Object.keys(fromEnv).length > 0) return fromEnv
  if (process.platform !== 'win32') return null
  return {
    windows: {
      command: String(env.LOBSTER_DESKTOP_MCP_COMMAND ?? 'uvx').trim() || 'uvx',
      args: ['windows-mcp'],
    },
  }
}

export function lobsterDesktopMcpMaxSteps(): number {
  const n = Number(process.env.LOBSTER_DESKTOP_MCP_MAX_STEPS ?? 14)
  return Number.isFinite(n) && n >= 3 ? Math.min(32, Math.floor(n)) : 14
}

/** Android ADB / MCP sidecar（演示级；需 adb device） */
export function isLobsterAndroidMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LOBSTER_ANDROID_MCP_ENABLED ?? '0').trim() === '1'
}

export function resolveLobsterAndroidMcpServers(env: NodeJS.ProcessEnv = process.env): McpServersConfig | null {
  if (!isLobsterAndroidMcpEnabled(env)) return null
  const fromEnv =
    parseJsonServers(String(env.LOBSTER_ANDROID_MCP_SERVERS ?? '')) ||
    parseJsonServers(String(env.MCP_ANDROID_SERVERS ?? ''))
  if (fromEnv && Object.keys(fromEnv).length > 0) return fromEnv
  return null
}

export function lobsterAndroidMcpMaxSteps(): number {
  const n = Number(process.env.LOBSTER_ANDROID_MCP_MAX_STEPS ?? 12)
  return Number.isFinite(n) && n >= 3 ? Math.min(24, Math.floor(n)) : 12
}
