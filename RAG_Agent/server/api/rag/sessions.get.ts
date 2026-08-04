import path from "node:path";
import { z } from "zod";
import { agentPgQuery } from "#agent-shared/agentPgClient";
import { isPostgresStorageEnabled, resolveStorageBackend } from "#agent-shared/storageBackend";
import { readRagSessionMeta, sanitizeRagSessionTitle } from "../../utils/ragSessionMeta";
import { readRagSession, listRagSessionsForUser } from "../../utils/ragSessionStore";

function previewTitle(messages: Array<{ role?: string; content?: string }>) {
  const firstUser = messages.find((m) => String(m?.role || "").toLowerCase() === "user");
  const raw = String(firstUser?.content || "").trim();
  if (!raw) return "新会话";
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

async function sessionUpdatedAt(sessionId: string): Promise<string | undefined> {
  if (!isPostgresStorageEnabled(resolveStorageBackend(process.env.RAG_AGENT_STORAGE_BACKEND, "file"))) {
    return undefined;
  }
  const res = await agentPgQuery<{ updated_at: Date | string }>(
    `SELECT updated_at FROM rag_sessions WHERE id = $1`,
    [sessionId]
  );
  const ts = res?.rows?.[0]?.updated_at;
  if (!ts) return undefined;
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const userId = String(query.userId ?? "").trim();
  const dataRoot = path.join(process.cwd(), ".data");
  // 会话列表仅服务端权威：忽略客户端 historyIds，禁止前端拼装权威列表

  const sessionIdSet = new Set<string>();
  if (userId) {
    for (const id of await listRagSessionsForUser(userId)) sessionIdSet.add(id);
  }

  const items: Array<{
    id: string;
    title: string;
    updatedAt: string;
    messageCount: number;
    userMessageCount: number;
    customTitle?: boolean;
  }> = [];

  for (const sid of sessionIdSet) {
    const id = String(sid || "").trim();
    if (!id) continue;
    const session = await readRagSession(id);
    const messages = session.messages || [];
    const meta = await readRagSessionMeta(dataRoot, id);
    const pgUpdated = await sessionUpdatedAt(id);
    const userMessageCount = messages.filter((m) => m.role === "user").length;
    const autoTitle = previewTitle(messages);

    if (!messages.length && !(meta.customTitle && meta.title)) continue;

    items.push({
      id,
      title: meta.customTitle && meta.title ? meta.title : autoTitle,
      updatedAt: meta.updatedAt || pgUpdated || new Date().toISOString(),
      messageCount: messages.length,
      userMessageCount,
      customTitle: Boolean(meta.customTitle && meta.title),
    });
  }

  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { items };
});
