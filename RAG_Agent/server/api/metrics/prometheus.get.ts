import { getRagSliSummary } from '../../utils/query_metrics'
import { buildExpertPrometheusText } from '../../utils/expertPrometheus'

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/plain; version=0.0.4; charset=utf-8')
  const sli = getRagSliSummary()
  return buildExpertPrometheusText({
    prefix: 'rag_agent',
    sli: {
      refusalRate: sli.refusalRate,
      emptyEvidenceRate: sli.emptyEvidenceRate,
      retrieveP95Ms: sli.retrieveP95Ms,
      retrieveP50Ms: sli.retrieveP50Ms,
      sampleCount: sli.sampleCount,
    },
  })
})
