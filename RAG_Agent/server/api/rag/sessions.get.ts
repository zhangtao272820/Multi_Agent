import path from "node:path";
import { agentPgQuery } from "#agent-shared/agentPgClient";
import { isPostgresStorageEnabled, resolveStorageBackend } from "#agent-shared/storageBackend";
import { readRagSessionMeta } from "../../utils/ragSessionMeta";
import { readRagSession, listRagSessionsForUser } from "../../utils/ragSessionStore";
import { assertRagSessionAccess, resolveRagHttpUser } from "../../utils/ragRequestUser";
import { isRagSidebarHiddenSessionId } from "../../utils/ragStandalonePersistGate";

export type RagSessionSidebarItem = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  customTitle?: boolean;
};

function previewTitleFromContent(rawContent: string) {
  const raw = String(rawContent || "").trim();
  if (!raw) return "新会话";
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

function previewTitle(messages: Array<{ role?: string; content?: string }>) {
  const firstUser = messages.find((m) => String(m?.role || "").toLowerCase() === "user");
  return previewTitleFromContent(String(firstUser?.content || ""));
}

type PgSidebarRow = {
  id: string;
  title: string | null;
  custom_title: boolean | null;
  updated_at: Date | string;
  message_count: number | string;
  user_message_count: number | string;
  first_user_content: string | null;
};

/** 一次 SQL 拉齐侧栏摘要，避免按会话 N+1 全量读 turns */
async function listSidebarItemsFromPg(userId: string): Promise<RagSessionSidebarItem[] | null> {
  if (!isPostgresStorageEnabled(resolveStorageBackend(process.env.RAG_AGENT_STORAGE_BACKEND, "file"))) {
    return null;
  }
  const uid = String(userId || "").trim();
  if (!uid) return null;

  const res = await agentPgQuery<PgSidebarRow>(
    `SELECT
       s.id,
       s.title,
       s.custom_title,
       s.updated_at,
       COALESCE(COUNT(t.turn_index), 0)::int AS message_count,
       COALESCE(COUNT(t.turn_index) FILTER (WHERE t.role = 'user'), 0)::int AS user_message_count,
       (
         SELECT t2.content
         FROM rag_session_turns t2
         WHERE t2.session_id = s.id AND t2.role = 'user'
         ORDER BY t2.turn_index ASC
         LIMIT 1
       ) AS first_user_content
     FROM rag_sessions s
     LEFT JOIN rag_session_turns t ON t.session_id = s.id
     WHERE s.user_id = $1
     GROUP BY s.id, s.title, s.custom_title, s.updated_at
     ORDER BY s.updated_at DESC
     LIMIT 80`,
    [uid]
  );
  if (!res) return null;

  const items: RagSessionSidebarItem[] = [];
  for (const row of res.rows) {
    const id = String(row.id || "").trim();
    if (!id || isRagSidebarHiddenSessionId(id)) continue;
    const messageCount = Number(row.message_count) || 0;
    const userMessageCount = Number(row.user_message_count) || 0;
    const titleRaw = String(row.title || "").trim();
    const customTitle = Boolean(row.custom_title && titleRaw);
    const autoTitle = previewTitleFromContent(String(row.first_user_content || ""));
    if (!messageCount && !customTitle) continue;
    const ts = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "");
    items.push({
      id,
      title: customTitle ? titleRaw : autoTitle,
      updatedAt: ts || new Date().toISOString(),
      messageCount,
      userMessageCount,
      customTitle: customTitle || undefined,
    });
  }
  return items;
}

async function listSidebarItemsFallback(
  sessionIds: Iterable<string>,
  dataRoot: string
): Promise<RagSessionSidebarItem[]> {
  const items: RagSessionSidebarItem[] = [];
  for (const sid of sessionIds) {
    const id = String(sid || "").trim();
    if (!id || isRagSidebarHiddenSessionId(id)) continue;
    const session = await readRagSession(id);
    const messages = session.messages || [];
    const meta = await readRagSessionMeta(dataRoot, id);
    const userMessageCount = messages.filter((m) => m.role === "user").length;
    const autoTitle = previewTitle(messages);
    if (!messages.length && !(meta.customTitle && meta.title)) continue;
    items.push({
      id,
      title: meta.customTitle && meta.title ? meta.title : autoTitle,
      updatedAt: meta.updatedAt || new Date().toISOString(),
      messageCount: messages.length,
      userMessageCount,
      customTitle: Boolean(meta.customTitle && meta.title) || undefined,
    });
  }
  return items;
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const auth = resolveRagHttpUser(event, query.userId ? String(query.userId) : undefined);
  const userId = auth.userId;
  const dataRoot = path.join(process.cwd(), ".data");
  const anchor = String(query.sessionId ?? "").trim();

  const sessionIdSet = new Set<string>();
  if (userId) {
    for (const id of await listRagSessionsForUser(userId)) sessionIdSet.add(id);
  }
  if (anchor && userId) {
    await assertRagSessionAccess({ sessionId: anchor, userId }).catch(() => undefined);
    sessionIdSet.add(anchor);
  }

  let items: RagSessionSidebarItem[] = [];
  const fromPg = userId ? await listSidebarItemsFromPg(userId) : null;
  if (fromPg) {
    items = fromPg;
    // 文件镜像 / anchor 补齐：PG 未收录的 id 再走轻量回退
    const seen = new Set(items.map((it) => it.id));
    const missing: string[] = [];
    for (const sid of sessionIdSet) {
      const id = String(sid || "").trim();
      if (!id || seen.has(id) || isRagSidebarHiddenSessionId(id)) continue;
      missing.push(id);
    }
    if (missing.length) {
      const extra = await listSidebarItemsFallback(missing, dataRoot);
      items = items.concat(extra);
    }
  } else {
    items = await listSidebarItemsFallback(sessionIdSet, dataRoot);
  }

  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { items: items.slice(0, 80) };
});
