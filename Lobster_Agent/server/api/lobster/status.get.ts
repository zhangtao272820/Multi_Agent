import { getQuery } from 'h3'
import { useRuntimeConfig } from '#imports'
import { getRun, getRunStatus } from '../../services/lobsterRuntime'
import { assertLobsterAuth } from '../../utils/auth'
import { buildGuiAgentResult } from '../../utils/agent_result'
import { ensureLobsterGuiFinalPayload } from '../../services/lobsterGuiFinalPayload'

export default defineEventHandler((event) => {
  const cfg = useRuntimeConfig() as any
  assertLobsterAuth(event, cfg)
  const q = getQuery(event) as any
  const runId = String(q?.runId ?? '').trim()
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 runId' })
  }
  const status = getRunStatus(runId)
  if (!status) {
    throw createError({ statusCode: 404, statusMessage: 'runId 不存在' })
  }
  const r = getRun(runId)
  const st = String(status.status || '').toLowerCase()
  const pageUrl = String(r?.state?.pageUrl || '').trim()
  const pageTitle = String((r?.state as any)?.pageTitle || '').trim()
  const hasShot = Boolean(String(r?.lastScreenshotDataUrl || '').trim())
  let resultRaw = r?.result || null
  // error/canceled 且 result 空：从 state/截图 salvage，避免 poll 只见 traceId
  if (
    (st === 'error' || st === 'canceled') &&
    (!resultRaw || typeof resultRaw !== 'object' || !String((resultRaw as any).finalUrl || (resultRaw as any).url || '').trim()) &&
    (pageUrl || hasShot)
  ) {
    const base: Record<string, unknown> = {
      ...(resultRaw && typeof resultRaw === 'object' ? (resultRaw as Record<string, unknown>) : {}),
      task: String((resultRaw as any)?.task || r?.task || ''),
      traceId: String((resultRaw as any)?.traceId || status.traceId || runId),
      ...(pageUrl ? { finalUrl: pageUrl, url: pageUrl } : {}),
      ...(pageTitle ? { pageTitle } : {}),
      ...(hasShot ? { hasScreenshot: true } : {}),
      ...(status.error ? { error: String(status.error).slice(0, 400) } : {}),
    }
    resultRaw = ensureLobsterGuiFinalPayload(base, String(base.task || ''))
  }
  // 与 WS `_ws` 对齐：done/error 时附带 agentResult，避免总管 poll 路径「有执行无 final」
  let agentResult: ReturnType<typeof buildGuiAgentResult> | undefined
  let result = resultRaw
  if (resultRaw && typeof resultRaw === 'object' && (st === 'done' || st === 'error' || st === 'canceled')) {
    const row = ensureLobsterGuiFinalPayload(
      { ...(resultRaw as Record<string, unknown>) },
      String((resultRaw as any).task || r?.task || ''),
    )
    result = row
    const meaningful =
      Boolean(String(row.finalUrl || row.url || '').trim()) ||
      Boolean(String(row.answer || '').trim()) ||
      (Array.isArray(row.data) && row.data.length > 0)
    agentResult = buildGuiAgentResult({
      data: Array.isArray(row.data) ? (row.data as Record<string, unknown>[]) : [],
      finalUrl: String(row.finalUrl || ''),
      task: String(row.task || r?.task || ''),
      trace_id: String(row.traceId || runId),
      latency_ms: Number(row.latencyMs || 0) || undefined,
      answer: String(row.answer || ''),
      failureType: String(row.failureType || ''),
      // error 但已 salvage 出页面证据：agentResult.ok 可按 done 语义（由 buildGuiAgentResult + status 决定）
      status: st === 'done' || (st === 'error' && meaningful) ? 'done' : 'error',
      stats: row.stats && typeof row.stats === 'object' ? (row.stats as Record<string, unknown>) : undefined,
      error_code: st === 'done' || (st === 'error' && meaningful) ? undefined : String(status.error || row.failureType || 'run_error'),
    })
  }
  return {
    ...status,
    screenshotDataUrl: r?.lastScreenshotDataUrl || null,
    result,
    ...(agentResult ? { agentResult } : {}),
  }
})
