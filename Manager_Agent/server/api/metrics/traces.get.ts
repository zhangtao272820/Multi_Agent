import {
  buildOtelTracesFromMetrics,
  isManagerOtelExportEnabled,
  readRecentRunMetrics
} from '../../graph/core/runtime/otelExport'
import { buildTraceDeepLinks } from '../../graph/core/runtime/traceDeepLinks'

export default defineEventHandler(async (event) => {
  if (!isManagerOtelExportEnabled()) {
    throw createError({ statusCode: 404, statusMessage: 'OTel export disabled (set MANAGER_OTEL_EXPORT=1)' })
  }

  const q = getQuery(event)
  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50))
  const runId = String(q.runId || q.trace_id || q.traceId || '').trim()
  const rows = await readRecentRunMetrics()
  const traces = buildOtelTracesFromMetrics(rows, limit)

  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  return {
    ok: true,
    format: 'manager-otel-v1',
    traceCount: traces.length,
    traces,
    ...(runId ? { deepLinks: buildTraceDeepLinks(runId) } : {})
  }
})
