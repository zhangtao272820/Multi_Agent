import { useRuntimeConfig } from '#imports'
import { getRequestHeader } from 'h3'
import {
  browserProfileLabel,
  isUserBrowserProfile,
  resolveBrowserCdpUrl,
  resolveBrowserProfile,
} from '../../../services/browserProfiles'
import { isLobsterDesktopMcpEnabled, isLobsterMcpHeadlessSidecar, lobsterMcpTransportMode, shouldUseLocalHeadedMcp } from '../../../utils/lobster_env'
import { resolveLobsterVncLiveView } from '../../../utils/lobsterVnc'
import { probeLobsterDesktopReady } from '../../../services/lobsterDesktopMcpAgent'
import { probeLobsterMcpReady } from '../../../services/lobsterMcpAgent'

/** 工作台启动信息：鉴权是否必需、noVNC 地址、Docker LAN 可选预填 token */
export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig() as any
  const adminToken = String(cfg?.lobster?.adminToken || '').trim()
  const prefill = String(process.env.LOBSTER_WORKBENCH_PREFILL_TOKEN ?? '0').trim() === '1'
  const headless = Boolean(cfg?.lobster?.headless)
  const hostHeader = String(getRequestHeader(event, 'host') || '').trim()
  const hostname = hostHeader.split(':')[0] || 'localhost'
  const live = resolveLobsterVncLiveView({ hostname })
  const vncUrl = live.vncUrl

  const mcpUrl = String(process.env.LOBSTER_MCP_URL || '').trim()
  const mcpSidecar = Boolean(mcpUrl && /playwright_mcp|8931/i.test(mcpUrl)) || String(process.env.LOBSTER_MCP_HEADLESS_SIDECAR ?? '').trim() === '1'
  const mcpTransport = lobsterMcpTransportMode()
  const localHeadedMcp = shouldUseLocalHeadedMcp()

  const browserProfile = resolveBrowserProfile()
  const browserCdpUrl = resolveBrowserCdpUrl()
  const desktopEnabled = isLobsterDesktopMcpEnabled()
  const [playwrightProbe, desktopProbe] = await Promise.all([
    probeLobsterMcpReady().catch(() => ({ ok: false, error: 'probe_failed' })),
    desktopEnabled
      ? probeLobsterDesktopReady().catch(() => ({ ok: false, error: 'probe_failed' }))
      : Promise.resolve({ ok: false, error: 'disabled' as const }),
  ])

  return {
    ok: true,
    authRequired: Boolean(adminToken),
    headless,
    vncUrl,
    /** MCP 在独立 sidecar 无头运行，noVNC 看不到；网页默认 Stagehand（有头/noVNC）；视频/HITL 用 classic */
    mcpSidecar,
    mcpTransport,
    localHeadedMcp,
    mcpSidecarHint: localHeadedMcp
      ? '本地有头 MCP：浏览器与 noVNC 共用 DISPLAY，调试低风控站点可用。'
      : mcpSidecar
        ? 'Docker 无头 MCP sidecar：浏览器不在 noVNC 画面内。网页任务请用 auto/stagehand（有头）；验证码 HITL 后可改 classic。调试 MCP 请开「调试模式」看截图。'
        : undefined,
    browserProfile,
    browserProfileLabel: browserProfileLabel(browserProfile, browserCdpUrl || undefined),
    userBrowserActive: isUserBrowserProfile(),
    desktopMcp: {
      enabled: desktopEnabled,
      ready: desktopProbe.ok,
      toolCount: desktopProbe.toolCount ?? 0,
      error: desktopProbe.error,
    },
    playwrightMcp: {
      ready: playwrightProbe.ok,
      toolCount: (playwrightProbe as { toolCount?: number }).toolCount,
    },
    /** 仅 LOBSTER_WORKBENCH_PREFILL_TOKEN=1 时返回，供 Docker/LAN 工作台自动对齐令牌 */
    token: prefill && adminToken ? adminToken : undefined,
    tokenHint: adminToken
      ? '与 Manage-platform .env.agents-lan 中 LOBSTER_ADMIN_TOKEN / CLAWHIVE_INTERNAL_TOKEN 相同'
      : '未配置 LOBSTER_ADMIN_TOKEN，可留空',
  }
})
