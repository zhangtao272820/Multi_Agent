import { getRagQueryMetricCounters, getRagSliSummary, readRecentRagMetrics } from "../utils/query_metrics";

export default defineEventHandler(async () => {
  const sli = getRagSliSummary();
  return {
    ok: true,
    counters: getRagQueryMetricCounters(),
    recent: readRecentRagMetrics(30),
    // R2：总管可消费的 SLI 字段
    sli: {
      refusalRate: sli.refusalRate,
      emptyEvidenceRate: sli.emptyEvidenceRate,
      retrieveP95Ms: sli.retrieveP95Ms,
      retrieveP50Ms: sli.retrieveP50Ms,
      sampleCount: sli.sampleCount,
      retrieveSamples: sli.retrieveSamples,
    },
    capabilityAudit: {
      CAP_EMBEDDING: process.env.CAP_EMBEDDING || process.env.CAP_EMBEDDING_RAG || null,
      CAP_RERANK: process.env.CAP_RERANK || null,
      CAP_REASON: process.env.CAP_REASON || null,
      CAP_ROUTE: process.env.CAP_ROUTE || null,
    },
  };
});
