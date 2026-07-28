import { getDbSliSummary, getQueryMetricCounters } from '../../../utils/query_metrics'
import { buildExpertPrometheusText } from '../../utils/expertPrometheus'

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/plain; version=0.0.4; charset=utf-8')
  const sli = getDbSliSummary()
  const counters = getQueryMetricCounters()
  const directOk = counters['sql_direct:ok'] ?? 0
  const agentOk = counters['sql_agent:ok'] ?? 0
  return buildExpertPrometheusText({
    prefix: 'db_agent',
    sli: {
      p95Ms: sli.p95Ms,
      p50Ms: sli.p50Ms,
      samples: sli.samples,
      errorCodes: sli.errorCodes,
    },
    errorCodes: sli.errorCodes,
    extraGauges: {
      sql_direct_ok: directOk,
      sql_agent_ok: agentOk,
    },
  })
})
