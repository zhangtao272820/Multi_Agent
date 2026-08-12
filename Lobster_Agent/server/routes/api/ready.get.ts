import { chromium } from 'playwright'
import {
  isLobsterDesktopMcpEnabled,
  isLobsterAndroidMcpEnabled,
  isLobsterMcpEnabled,
  isLobsterHandsOnly,
  isStagehandEnabled,
  resolveLobsterExecutionMode,
  lobsterMcpTransportMode,
} from '../../utils/lobster_env'
import { probeLobsterMcpReady } from '../../services/lobsterMcpAgent'
import { probeLobsterDesktopReady } from '../../services/lobsterDesktopMcpAgent'
import { probeLobsterAndroidReady } from '../../services/lobsterAndroidMcpAgent'
import { probeStagehandReady } from '../../services/lobsterStagehandAgent'
import {
  browserProfileLabel,
  isUserBrowserProfile,
  resolveBrowserCdpUrl,
  resolveBrowserProfile,
} from '../../services/browserProfiles'
import { listLobsterMcpToolNames, listLobsterSkillIds, loadLobsterSkillsManifest } from '../../utils/lobsterSkillLoader'
import { resolveLobsterVncLiveView } from '../../utils/lobsterVnc'

/** 总管 probe：health=进程存活，ready=至少一种执行引擎可用 */
export default defineEventHandler(async () => {
  const handsOnly = isLobsterHandsOnly()
  const executionMode = resolveLobsterExecutionMode()
  let browserReady = false
  let detail = 'playwright_missing'
  if (!handsOnly) {
    try {
      const exe = chromium.executablePath()
      browserReady = Boolean(exe)
      detail = browserReady ? 'playwright_installed' : 'playwright_missing'
    } catch {
      detail = 'playwright_check_failed'
    }
  } else {
    detail = 'skipped_hands_only'
  }

  let mcp: { enabled: boolean; ok: boolean; toolCount: number; error?: string } = {
    enabled: !handsOnly && isLobsterMcpEnabled(),
    ok: false,
    toolCount: 0,
    ...(handsOnly ? { error: 'skipped_hands_only' } : {}),
  }
  if (mcp.enabled) {
    const probe = await probeLobsterMcpReady()
    mcp = { enabled: true, ok: probe.ok, toolCount: probe.toolCount, error: probe.error }
  }

  let stagehand: { enabled: boolean; ok: boolean; error?: string } = {
    enabled: !handsOnly && isStagehandEnabled(),
    ok: false,
    ...(handsOnly ? { error: 'skipped_hands_only' } : {}),
  }
  if (stagehand.enabled) {
    const probe = await probeStagehandReady()
    stagehand = { enabled: true, ok: probe.ok, error: probe.error }
  }

  let desktop: {
    enabled: boolean
    ok: boolean
    toolCount: number
    platform: string
    error?: string
  } = {
    // Hands-only 默认视为应启用桌面；仍尊重显式 LOBSTER_DESKTOP_MCP_ENABLED
    enabled: handsOnly ? true : isLobsterDesktopMcpEnabled(),
    ok: false,
    toolCount: 0,
    platform: process.platform,
  }
  if (desktop.enabled || handsOnly) {
    if (!isLobsterDesktopMcpEnabled() && handsOnly) {
      desktop = {
        enabled: true,
        ok: false,
        toolCount: 0,
        platform: process.platform,
        error: 'lobster_desktop_mcp_disabled: set LOBSTER_DESKTOP_MCP_ENABLED=1',
      }
    } else if (isLobsterDesktopMcpEnabled() && handsOnly) {
      // Hands-only：ready 快速返回；Windows-MCP 首连可能数十秒，放到真实桌面任务里暖机
      desktop = {
        enabled: true,
        ok: true,
        toolCount: 0,
        platform: process.platform,
        error: 'deferred_probe',
      }
    } else if (isLobsterDesktopMcpEnabled()) {
      const probe = await Promise.race([
        probeLobsterDesktopReady(45000),
        new Promise<{ ok: false; toolCount: 0; error: string }>((resolve) => {
          setTimeout(() => resolve({ ok: false, toolCount: 0, error: 'desktop_probe_timeout' }), 50000)
        }),
      ])
      desktop = {
        enabled: true,
        ok: probe.ok,
        toolCount: probe.toolCount,
        platform: process.platform,
        error: probe.error,
      }
    }
  } else if (process.platform !== 'win32') {
    desktop.error = 'requires_win32_host'
  }

  let android: {
    enabled: boolean
    ok: boolean
    toolCount: number
    deviceCount: number
    error?: string
    mode?: string
  } = {
    enabled: !handsOnly && isLobsterAndroidMcpEnabled(),
    ok: false,
    toolCount: 0,
    deviceCount: 0,
    ...(handsOnly ? { error: 'skipped_hands_only' } : {}),
  }
  if (android.enabled) {
    const probe = await probeLobsterAndroidReady()
    android = {
      enabled: true,
      ok: probe.ok,
      toolCount: probe.toolCount,
      deviceCount: probe.deviceCount,
      error: probe.error,
      mode: (probe as { mode?: string }).mode,
    }
  }

  const engines = {
    classic: {
      ok: !handsOnly && browserReady,
      detail: handsOnly ? 'skipped_hands_only' : browserReady ? 'playwright_installed' : detail,
    },
    mcp: { ok: mcp.enabled && mcp.ok, toolCount: mcp.toolCount, error: mcp.error },
    stagehand: { ok: stagehand.enabled && stagehand.ok, error: stagehand.error },
    desktop: { ok: desktop.enabled && desktop.ok, toolCount: desktop.toolCount, error: desktop.error },
    mobile: {
      ok: android.enabled && android.ok,
      toolCount: android.toolCount,
      deviceCount: android.deviceCount,
      error: android.error,
    },
  }

  const classicReady = !handsOnly && browserReady
  const mcpReady = mcp.enabled && mcp.ok
  const stagehandReady = stagehand.enabled && stagehand.ok
  const desktopReady = desktop.enabled && desktop.ok
  const mobileReady = android.enabled && android.ok
  const ready = handsOnly
    ? // Hands 侧车进程存活即可；Windows-MCP 首连可能很慢，放进真实桌面任务里暖机
      isLobsterDesktopMcpEnabled()
    : executionMode === 'mcp'
      ? mcpReady
      : executionMode === 'stagehand'
        ? stagehandReady
        : executionMode === 'classic'
          ? classicReady
          : mcpReady || stagehandReady || classicReady || desktopReady || mobileReady

  const browserProfile = resolveBrowserProfile()
  const browserCdpUrl = resolveBrowserCdpUrl()
  const liveView = resolveLobsterVncLiveView()

  return {
    ok: true,
    ready,
    service: handsOnly ? 'lobster-hands' : 'lobster-agent',
    handsOnly,
    executionMode,
    browser: handsOnly ? 'skipped_hands_only' : browserReady ? 'installed' : 'missing',
    browserProfile: {
      mode: browserProfile,
      label: browserProfileLabel(browserProfile, browserCdpUrl || undefined),
      userActive: isUserBrowserProfile(),
      cdpConfigured: Boolean(browserCdpUrl),
    },
    mcpTransport: lobsterMcpTransportMode(),
    skillsManifest: loadLobsterSkillsManifest()
      ? { skills: listLobsterSkillIds(), mcp_tools: listLobsterMcpToolNames() }
      : undefined,
    mcp,
    stagehand,
    desktop,
    android,
    engines,
    /** 总管/前端打开 noVNC；headless 时为空 */
    vncUrl: liveView.vncUrl || null,
    vncHint: liveView.hint || null,
    detail,
    ts: Date.now(),
  }
})
