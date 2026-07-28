import { aggregateCrawlMetrics, getCrawlMetricCounters, getExtractorSliSummary, readRecentCrawlMetrics } from '../utils/crawl_metrics'
import { getExtractorAgentEnv } from '../utils/extractor_agent_env'

export default defineEventHandler(async () => {
  const limit = getExtractorAgentEnv().metricsRecentLimit
  const recent = readRecentCrawlMetrics(limit)
  const sli = getExtractorSliSummary(limit)
  return {
    ok: true,
    counters: getCrawlMetricCounters(),
    recent,
    aggregate: aggregateCrawlMetrics(recent),
    // E2
    sli,
    capabilityAudit: {
      CAP_ROUTE: process.env.CAP_ROUTE || null,
      CAP_REASON: process.env.CAP_REASON || null,
      silent_upgrade_forbidden: true,
    },
  }
})
