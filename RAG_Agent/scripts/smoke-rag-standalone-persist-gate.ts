/**
 * 文曲独立端落库门控 smoke（无 LLM）：总管穿透不得写入侧栏。
 * 用法：cd RAG_Agent && npm run smoke:standalone-persist
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRagSidebarHiddenSessionId,
  shouldSkipRagStandalonePersist,
} from "../server/utils/ragStandalonePersistGate.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

assert(
  !shouldSkipRagStandalonePersist({ sessionId: "user-standalone-uuid" }),
  "standalone uuid must persist",
);
assert(
  shouldSkipRagStandalonePersist({
    sessionId: "mgr-run1-rag",
  }),
  "mgr-*-rag must skip",
);
assert(
  shouldSkipRagStandalonePersist({
    sessionId: "mgr-run1-db",
  }),
  "mgr-*-db must skip (any agent token)",
);
assert(
  shouldSkipRagStandalonePersist({
    sessionId: "mgr-run1-rag-db_supplement",
  }),
  "mgr step with stepId must skip",
);
assert(
  shouldSkipRagStandalonePersist({
    sessionId: "user-uuid",
    isManagerOrchestrated: true,
  }),
  "orchestrated must skip",
);
assert(
  shouldSkipRagStandalonePersist({
    sessionId: "user-uuid",
    hasManagerTrace: true,
  }),
  "manager trace header must skip (UUID bypass defense)",
);
assert(
  isRagSidebarHiddenSessionId("mgr-abc-rag-fix"),
  "sidebar hides mgr step sessions",
);
assert(
  !isRagSidebarHiddenSessionId("user-standalone-uuid"),
  "sidebar keeps standalone sessions",
);

const chatSrc = readFileSync(join(root, "server/api/chat.post.ts"), "utf8");
assert(chatSrc.includes("shouldSkipRagStandalonePersist"), "chat.post uses persist gate");
assert(chatSrc.includes("hasManagerTrace"), "chat.post detects manager trace");
assert(chatSrc.includes("skipStandaloneSessionState"), "chat.post skips standalone session state");

const sessionsSrc = readFileSync(join(root, "server/api/rag/sessions.get.ts"), "utf8");
assert(
  sessionsSrc.includes("isRagSidebarHiddenSessionId"),
  "sessions.get filters mgr-* from sidebar",
);

console.log("smoke-rag-standalone-persist: OK");
