/**
 * Hands 侧车启动后暖机 Windows-MCP，避免首个桌面任务卡在 uvx 冷启动。
 */
export default defineNitroPlugin(() => {
  if (String(process.env.LOBSTER_HANDS_ONLY || '').trim() !== '1') return
  if (String(process.env.LOBSTER_DESKTOP_MCP_ENABLED || '').trim() !== '1') return
  if (process.platform !== 'win32') return

  const delayMs = Number(process.env.LOBSTER_DESKTOP_WARM_DELAY_MS ?? 4000)
  setTimeout(() => {
    void import('../services/lobsterDesktopMcpAgent')
      .then(({ probeLobsterDesktopReady }) => probeLobsterDesktopReady(120_000))
      .then((r) => {
        console.log(
          `[Hands] desktop MCP warm ok=${r.ok} tools=${r.toolCount}${r.error ? ` err=${r.error}` : ''}`,
        )
      })
      .catch((e) => {
        console.warn('[Hands] desktop MCP warm failed:', String((e as Error)?.message || e).slice(0, 200))
      })
  }, Number.isFinite(delayMs) && delayMs >= 0 ? Math.min(60_000, Math.floor(delayMs)) : 4000)
})
