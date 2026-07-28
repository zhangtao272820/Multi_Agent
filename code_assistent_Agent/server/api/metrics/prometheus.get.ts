import { getCodeSliSummary } from '../../utils/code_metrics'
import { buildExpertPrometheusText } from '../../utils/expertPrometheus'

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/plain; version=0.0.4; charset=utf-8')
  const sli = getCodeSliSummary()
  return buildExpertPrometheusText({
    prefix: 'code_agent',
    sli: {
      p95Ms: sli.p95Ms,
      p50Ms: sli.p50Ms,
      sampleCount: sli.sampleCount,
      failRate: sli.failRate,
      errorCodes: sli.errorCodes,
    },
    errorCodes: sli.errorCodes,
  })
})
