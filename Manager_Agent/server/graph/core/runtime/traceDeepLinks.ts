/**
 * Wave6 K5：Trace 深链（Langfuse / Tempo）— 与控制面 trace_links 对齐的 Manager 侧形态。
 */
export type TraceDeepLinks = {
  runId: string
  langfuseUrl: string | null
  tempoUrl: string | null
  otelEnabled: boolean
}

export function buildTraceDeepLinks(
  runId: string,
  env: NodeJS.ProcessEnv = process.env
): TraceDeepLinks {
  const rid = String(runId || '').trim()
  const langfusePublic = String(env.LANGFUSE_PUBLIC_URL || env.MANAGER_LANGFUSE_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  const tempoUi = String(env.TEMPO_UI_URL || env.MANAGER_TEMPO_UI_URL || '').trim().replace(/\/+$/, '')
  const otelEnabled =
    String(env.MANAGER_OTEL_EXPORT || '').trim() === '1' ||
    Boolean(String(env.MANAGER_OTLP_ENDPOINT || env.MANAGER_LANGFUSE_OTLP_ENDPOINT || '').trim())

  let langfuseUrl: string | null = null
  if (langfusePublic && rid) {
    langfuseUrl = `${langfusePublic}/trace/${encodeURIComponent(rid)}`
  }
  let tempoUrl: string | null = null
  if (tempoUi && rid) {
    // Grafana Explore style query param (best-effort)
    tempoUrl = `${tempoUi}?traceId=${encodeURIComponent(rid)}`
  }
  return { runId: rid, langfuseUrl, tempoUrl, otelEnabled }
}
