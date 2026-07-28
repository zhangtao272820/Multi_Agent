import { getLobsterRuntimeMetrics } from '../../services/lobsterRuntime'
import { buildExpertPrometheusText } from '../../utils/expertPrometheus'

/** E1：Prometheus scrape 不加 internal auth（与 JSON /api/metrics 区分） */
export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/plain; version=0.0.4; charset=utf-8')
  const m = getLobsterRuntimeMetrics() as {
    sli?: Record<string, unknown>
    runs?: { total?: number; running?: number; error?: number; done?: number; queued?: number }
    queue_depth?: number
  }
  const sli = m.sli || {
    sampleCount: Number(m.runs?.total || 0),
    queueDepth: Number(m.queue_depth || 0),
    errorRate:
      (Number(m.runs?.done || 0) + Number(m.runs?.error || 0)) > 0
        ? Number(m.runs?.error || 0) / (Number(m.runs?.done || 0) + Number(m.runs?.error || 0))
        : 0,
  }
  return buildExpertPrometheusText({
    prefix: 'lobster_agent',
    sli,
    extraGauges: {
      runs_total: Number(m.runs?.total || 0),
      runs_running: Number(m.runs?.running || 0),
      runs_queued: Number(m.runs?.queued || 0),
      runs_error: Number(m.runs?.error || 0),
    },
  })
})
