import { getCodeQueryMetricCounters, getCodeSliSummary, readRecentCodeMetrics } from '../utils/code_metrics'
import { readRecentCodeNluMetrics } from '../utils/code_nlu_metrics'
import { getCodeAgentEnv } from '../utils/code_agent_env'

export default defineEventHandler(async () => {
  const sli = getCodeSliSummary()
  return {
    ok: true,
    counters: getCodeQueryMetricCounters(),
    recent: readRecentCodeMetrics(),
    nlu_recent: readRecentCodeNluMetrics(),
    // §2.8.5：总管可消费的 SLI
    sli: {
      p95Ms: sli.p95Ms,
      p50Ms: sli.p50Ms,
      sampleCount: sli.sampleCount,
      failRate: sli.failRate,
      errorCodes: sli.errorCodes,
      maxToolRounds: sli.maxToolRounds,
    },
    capabilityAudit: {
      CAP_CODER: process.env.CAP_CODER || process.env.OPENAI_MODEL || null,
      CAP_REASON: process.env.CAP_REASON || null,
      CAP_ROUTE: process.env.CAP_ROUTE || null,
      maxToolRounds: getCodeAgentEnv().maxToolRounds,
      silent_upgrade_forbidden: true,
    },
  }
})
