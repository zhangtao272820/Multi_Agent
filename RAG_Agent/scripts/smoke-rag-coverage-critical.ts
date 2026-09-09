/**
 * RAG coverageCritical → agentic retry 闸门（不调 LLM）。
 */
import { shouldAttemptAgenticRetry } from "../server/utils/rag_agentic_retry_gate.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-rag-coverage-critical] ${msg}`);
}

console.log("smoke-rag-coverage-critical: start");

assert(
  shouldAttemptAgenticRetry({
    enabled: false,
    attempt: 0,
    maxRounds: 1,
    clarifyReason: "weak_evidence",
    coverageCritical: true,
  }) === true,
  "critical forces retry when disabled",
);

assert(
  shouldAttemptAgenticRetry({
    enabled: false,
    attempt: 0,
    maxRounds: 1,
    clarifyReason: "weak_evidence",
    coverageCritical: false,
  }) === false,
  "no critical + disabled = no retry",
);

assert(
  shouldAttemptAgenticRetry({
    enabled: true,
    attempt: 1,
    maxRounds: 1,
    clarifyReason: "zero_hits",
    coverageCritical: true,
  }) === false,
  "still respects maxRounds",
);

assert(
  shouldAttemptAgenticRetry({
    enabled: true,
    attempt: 0,
    maxRounds: 2,
    clarifyReason: "weak_evidence",
    turboRetrieval: true,
    coverageCritical: true,
  }) === true,
  "critical overrides turbo weak block",
);

console.log("smoke-rag-coverage-critical: ok");
