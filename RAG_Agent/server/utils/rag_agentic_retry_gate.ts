/**
 * Agentic 再检闸门（纯函数，供 smoke / document_retrieval）。
 * 与 rewriteQuery 解耦，避免契约测试拉起 LLM SDK。
 */
export function shouldAttemptAgenticRetry(params: {
  enabled: boolean;
  attempt: number;
  maxRounds: number;
  clarifyReason?: string;
  turboRetrieval?: boolean;
  /** 总管 Brief / force_deep：弱证据仍允许有界再检（不突破 maxRounds） */
  coverageCritical?: boolean;
}): boolean {
  if (params.attempt >= params.maxRounds) return false;
  const critical = Boolean(params.coverageCritical);
  if (!params.enabled && !critical) return false;
  // coverageCritical 时即使 turbo 也允许 zero/weak 再跳一轮（控成本：仍受 maxRounds）
  if (params.turboRetrieval && !critical && params.clarifyReason !== "zero_hits") return false;
  return (
    params.clarifyReason === "zero_hits" ||
    params.clarifyReason === "weak_evidence" ||
    params.clarifyReason === "ambiguous_low_confidence" ||
    params.clarifyReason === "evidence_filtered_off_topic" ||
    params.clarifyReason === "false_negative_miss"
  );
}
