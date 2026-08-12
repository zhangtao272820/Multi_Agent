/**
 * 请求级 Agentic 工具环模式（chat 入口判定后注入）。
 */
export type RagRetrievalModeKind = "pipeline" | "agentic";

let requestRetrievalMode: RagRetrievalModeKind = "pipeline";
let requestToolRounds = 0;

export function setRagChatRetrievalMode(mode: RagRetrievalModeKind | null) {
  requestRetrievalMode = mode === "agentic" ? "agentic" : "pipeline";
  requestToolRounds = 0;
}

export function getRagChatRetrievalMode(): RagRetrievalModeKind {
  return requestRetrievalMode;
}

export function isRagAgenticToolLoopActive(): boolean {
  return requestRetrievalMode === "agentic";
}

export function bumpRagAgenticToolRound(): number {
  requestToolRounds += 1;
  return requestToolRounds;
}

export function getRagAgenticToolRounds(): number {
  return requestToolRounds;
}

export function resetRagAgenticToolRounds() {
  requestToolRounds = 0;
}
