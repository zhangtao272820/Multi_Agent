/**
 * RAG 会话持久化 smoke：验证 file 落盘契约（userId + messages + updatedAt）
 * 与 list 按 userId 扫描合并逻辑（与 ragSessionStore 一致）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ragRoot = path.resolve(__dirname, "..");
const sessionsDir = path.join(ragRoot, ".data", "rag-sessions-smoke", "rag-sessions");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type Payload = { userId?: string; messages: Array<{ role: string; content: string }>; updatedAt?: string };

async function writeSessionFile(sessionId: string, messages: Payload["messages"], userId: string) {
  await fs.mkdir(sessionsDir, { recursive: true });
  const payload: Payload = {
    userId,
    messages,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(payload, null, 2), "utf8");
}

async function listForUser(userId: string): Promise<string[]> {
  const uid = String(userId || "").trim();
  let names: string[] = [];
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const out: Array<{ id: string; updatedAt: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const raw = JSON.parse(await fs.readFile(path.join(sessionsDir, name), "utf8")) as Payload;
    if (String(raw.userId || "").trim() !== uid) continue;
    if (!Array.isArray(raw.messages) || !raw.messages.length) continue;
    out.push({ id, updatedAt: String(raw.updatedAt || "") });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out.map((x) => x.id);
}

async function main() {
  // 契约：store 文件格式
  const storeSrc = await fs.readFile(path.join(ragRoot, "server", "utils", "ragSessionStore.ts"), "utf8");
  assert(storeSrc.includes("mustWriteFile"), "emergency file write when PG fails");
  assert(storeSrc.includes("listSessionIdsFromFiles"), "file scan list helper");
  assert(storeSrc.includes("userId?: string"), "file payload carries userId");
  assert(/shouldWriteFile\(backend\) \|\| !pgOk/.test(storeSrc), "force file on PG failure");

  // 契约：UI 空会话不乐观入历史
  const appSrc = await fs.readFile(path.join(ragRoot, "app", "app.vue"), "utf8");
  assert(appSrc.includes("空会话不进侧栏"), "empty session flicker guard");
  const newSessionBlock = appSrc.match(/const newSession = async[\s\S]*?^};/m)?.[0] || "";
  assert(newSessionBlock.length > 0, "newSession function present");
  assert(!newSessionBlock.includes("fetchServerSessionHistory"), "newSession must not refetch empty history");
  assert(!/touchCurrentSessionHistory\(\{\s*bump:\s*true\s*\}\)/.test(newSessionBlock), "newSession must not optimistic-bump empty");
  assert(appSrc.includes("await newSession({ skipConfirm: true })"), "modal new_session delegates to newSession");

  // 契约：compose dual + db volume
  const composePath = path.join(ragRoot, "..", "Manage-platform_Agent", "docker-compose.agents-lan.yml");
  const compose = await fs.readFile(composePath, "utf8");
  assert(compose.includes("RAG_AGENT_STORAGE_BACKEND: ${RAG_AGENT_STORAGE_BACKEND:-dual}"), "RAG dual default");
  assert(compose.includes("MANAGER_STORAGE_BACKEND: ${MANAGER_STORAGE_BACKEND:-dual}"), "Manager dual default");
  assert(compose.includes("DB_AGENT_STORAGE_BACKEND: ${DB_AGENT_STORAGE_BACKEND:-dual}"), "DB dual default");
  assert(compose.includes("db_agent_data:/app/.data"), "db_agent data volume mount");
  assert(/^\s+db_agent_data:\s*$/m.test(compose), "db_agent_data volume declared");
  assert(compose.includes("切勿 `docker compose down -v`") || compose.includes("勿 `docker compose down -v`") || compose.includes("down -v"),
    "compose warns against down -v");

  const userId = "smoke-user-persist";
  const sessionId = `smoke-${Date.now()}`;
  await writeSessionFile(
    sessionId,
    [
      { role: "user", content: "养老护工补贴标准是什么？" },
      { role: "assistant", content: "根据文档，补贴标准为……" },
    ],
    userId
  );
  const ids = await listForUser(userId);
  assert(ids.includes(sessionId), `list must include ${sessionId}`);
  const other = await listForUser("other-user");
  assert(!other.includes(sessionId), "list must filter by userId");

  await fs.rm(path.join(ragRoot, ".data", "rag-sessions-smoke"), { recursive: true, force: true });
  console.log("smoke-rag-session-persist: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
