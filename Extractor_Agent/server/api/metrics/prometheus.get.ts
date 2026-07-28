import { getExtractorSliSummary } from '../../utils/crawl_metrics'
import { buildExpertPrometheusText } from '../../utils/expertPrometheus'

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/plain; version=0.0.4; charset=utf-8')
  const sli = getExtractorSliSummary()
  return buildExpertPrometheusText({
    prefix: 'extractor_agent',
    sli,
    errorCodes: (sli.errorCodes || undefined) as Record<string, number> | undefined,
  })
})
