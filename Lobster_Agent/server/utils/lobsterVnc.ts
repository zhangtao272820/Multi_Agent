/**
 * noVNC 公开地址：供工作台 / ready / Stagehand live_view 同源解析。
 * 浏览器打开的是宿主映射端口，勿返回容器内网主机名。
 */

function parseConfigHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.LOBSTER_HEADLESS ?? 'true').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function resolveLobsterVncPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.LOBSTER_VNC_PORT || env.NOVNC_PORT || '').trim()
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export type LobsterVncLiveView = {
  vncUrl: string
  hint?: string
  headless: boolean
  port: number
}

/**
 * @param hostname 请求 Host（无端口）；缺省用 LOBSTER_PUBLIC_HOST 或 localhost
 */
export function resolveLobsterVncLiveView(opts?: {
  hostname?: string
  env?: NodeJS.ProcessEnv
}): LobsterVncLiveView {
  const env = opts?.env || process.env
  const headless = parseConfigHeadless(env)
  const port = resolveLobsterVncPort(env)
  const publicOverride = String(env.LOBSTER_VNC_PUBLIC_URL || '').trim()
  if (publicOverride) {
    return { vncUrl: publicOverride, headless, port, hint: headless ? '配置为 headless，画面可能为空' : undefined }
  }
  if (headless) {
    return {
      vncUrl: '',
      headless: true,
      port,
      hint: 'LOBSTER_HEADLESS=true：noVNC 看不到浏览器；Docker 演示请设 LOBSTER_HEADLESS=false',
    }
  }
  if (!port) {
    return { vncUrl: '', headless: false, port: 0, hint: '未配置 LOBSTER_VNC_PORT / NOVNC_PORT' }
  }
  const host =
    String(opts?.hostname || env.LOBSTER_PUBLIC_HOST || 'localhost')
      .trim()
      .split(':')[0] || 'localhost'
  return {
    vncUrl: `http://${host}:${port}/vnc.html`,
    headless: false,
    port,
  }
}
