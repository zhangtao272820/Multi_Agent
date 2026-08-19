/** 请求级检索上下文（chat 链路注入 userKey / 编排模式 / condense 上下文） */
import type { BaseMessage } from "@langchain/core/messages";
import type { ManagerRagTaskPayload } from "#agent-shared/managerSubAgentProtocol";
import { setRagRequestIntent } from "./doc_scope_judge";
import type { RagMergedUnderstandResult } from "./rag_merged_understand";
import type { RagQueryPlan } from "./query_plan";

let currentUserKey: string | undefined;
let orchestratedByManager = false;
let managerRagTask: ManagerRagTaskPayload | null = null;
let mergedUnderstand: RagMergedUnderstandResult | null = null;

export type RagPrefetchedUnderstand = {
  plan: RagQueryPlan;
  leanQuery: string;
};

let prefetchedUnderstand: RagPrefetchedUnderstand | null = null;

export type RetrievalCondenseContext = {
  summary?: string;
  messages?: BaseMessage[];
};

let condenseContext: RetrievalCondenseContext = { summary: "", messages: [] };

export function setRetrievalUserKey(key?: string) {
  currentUserKey = key ? String(key).trim() : undefined;
}

export function getRetrievalUserKey(): string | undefined {
  return currentUserKey;
}

export function setOrchestratedByManager(v: boolean) {
  orchestratedByManager = Boolean(v);
}

export function isOrchestratedByManager(): boolean {
  return orchestratedByManager;
}

export function setRetrievalCondenseContext(ctx?: RetrievalCondenseContext) {
  condenseContext = {
    summary: String(ctx?.summary ?? "").trim(),
    messages: Array.isArray(ctx?.messages) ? ctx!.messages! : [],
  };
}

export function getRetrievalCondenseContext(): RetrievalCondenseContext {
  return condenseContext;
}

export function setManagerRagTask(task: ManagerRagTaskPayload | null | undefined) {
  managerRagTask = task && task.source === "manager" ? task : null;
}

export function getManagerRagTask(): ManagerRagTaskPayload | null {
  return managerRagTask;
}

export function setRagMergedUnderstand(result: RagMergedUnderstandResult | null | undefined) {
  mergedUnderstand = result ?? null;
}

export function getRagMergedUnderstand(): RagMergedUnderstandResult | null {
  return mergedUnderstand;
}

export function setRagPrefetchedUnderstand(value: RagPrefetchedUnderstand | null | undefined) {
  prefetchedUnderstand = value ?? null;
}

export function getRagPrefetchedUnderstand(): RagPrefetchedUnderstand | null {
  return prefetchedUnderstand;
}

export function clearRetrievalUserKey() {
  currentUserKey = undefined;
  orchestratedByManager = false;
  managerRagTask = null;
  mergedUnderstand = null;
  prefetchedUnderstand = null;
  condenseContext = { summary: "", messages: [] };
  setRagRequestIntent(null);
}
