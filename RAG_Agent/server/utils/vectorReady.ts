/**
 * R3：向量就绪探针（供 retrieve/chat 在检索前标准化失败码）
 */
import { auditVectorStoreHealth, getVectorStore } from "./vectorStore";

export type VectorReadyStatus = {
  ready: boolean;
  detail: string;
  error_code?: "vector_not_ready";
};

/** 轻量探针：init 失败或 metadata/vector drift → vector_not_ready */
export async function probeVectorReady(): Promise<VectorReadyStatus> {
  try {
    await getVectorStore();
    const audit = await auditVectorStoreHealth({ reconcile: false });
    const vectorReady =
      audit.consistent || (audit.metadataDocCount === 0 && (audit.vectorRowCount ?? 0) === 0);
    if (!vectorReady) {
      return {
        ready: false,
        detail: `vector_drift meta=${audit.metadataDocCount} vec=${audit.vectorRowCount ?? 0}`,
        error_code: "vector_not_ready",
      };
    }
    return { ready: true, detail: "vector_ok" };
  } catch (e: unknown) {
    const detail = String(e instanceof Error ? e.message : e ?? "vector_init_failed").slice(0, 240);
    return { ready: false, detail, error_code: "vector_not_ready" };
  }
}

export function classifyRagThrownError(error: unknown): "timeout" | "vector_not_ready" | "business" {
  const msg = String(error instanceof Error ? error.message : error ?? "")
    .trim()
    .toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("aborted") ||
    msg.includes("abort")
  ) {
    return "timeout";
  }
  if (
    msg.includes("vector") ||
    msg.includes("embedding") ||
    msg.includes("pgvector") ||
    msg.includes("not ready") ||
    msg.includes("econnrefused")
  ) {
    return "vector_not_ready";
  }
  return "business";
}
