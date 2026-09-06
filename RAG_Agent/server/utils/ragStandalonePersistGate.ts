/**
 * 文曲独立端会话落库门控：总管穿透 / 步进会话不得写入 rag_sessions 侧栏。
 * 纯函数，供 chat.post 与契约 smoke 共用。
 */
import { isManagerSubAgentSessionId } from "#agent-shared/managerStepSession";

export function shouldSkipRagStandalonePersist(params: {
  sessionId: string;
  isManagerOrchestrated?: boolean;
  /** Manager buildAgentTraceHeaders 必带 x-run-id / x-trace-id */
  hasManagerTrace?: boolean;
}): boolean {
  if (params.isManagerOrchestrated) return true;
  // 任意 mgr-{run}-{agent}…（不限 rag token），避免旁路误写
  if (isManagerSubAgentSessionId(params.sessionId)) return true;
  if (params.hasManagerTrace) return true;
  return false;
}

/** 历史会话列表：隐藏总管步进会话（即便曾误写入） */
export function isRagSidebarHiddenSessionId(sessionId: string): boolean {
  return isManagerSubAgentSessionId(String(sessionId || "").trim());
}
