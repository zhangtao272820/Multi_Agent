import fs from "node:fs/promises";
import path from "node:path";
import { agentPgQuery } from "#agent-shared/agentPgClient";
import { AMP_TTL } from "#agent-shared/agentMemoryPolicy";
import {
  isPostgresStorageEnabled,
  resolveStorageBackend,
  shouldWriteFile,
  shouldWritePostgres,
} from "#agent-shared/storageBackend";

export type RagSessionMessage = { role: "user" | "assistant"; content: string };
export type RagSession = { messages: RagSessionMessage[] };

const SESSION_MAX_TURNS = AMP_TTL.sessionTurnsMax;

function sessionsDir(): string {
  return path.join(process.cwd(), ".data", "rag-sessions");
}

function sessionFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function normalizeMessages(raw: unknown): RagSessionMessage[] {
  const arr = Array.isArray((raw as { messages?: unknown })?.messages)
    ? (raw as { messages: unknown[] }).messages
    : Array.isArray(raw)
      ? raw
      : [];
  return arr
    .map((m: { role?: string; content?: string }) => ({
      role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(m?.content ?? "").trim(),
    }))
    .filter((m) => m.content)
    .slice(-SESSION_MAX_TURNS);
}

export function resolveRagStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.RAG_AGENT_STORAGE_BACKEND, "file");
}

async function readSessionFromFile(sessionId: string): Promise<RagSession> {
  const sid = String(sessionId || "").trim();
  if (!sid) return { messages: [] };
  try {
    const text = await fs.readFile(sessionFile(sid), "utf8").catch(() => "");
    if (!text.trim()) return { messages: [] };
    return { messages: normalizeMessages(JSON.parse(text)) };
  } catch {
    return { messages: [] };
  }
}

async function writeSessionToFile(sessionId: string, messages: RagSessionMessage[]): Promise<void> {
  const sid = String(sessionId || "").trim();
  if (!sid) return;
  await fs.mkdir(sessionsDir(), { recursive: true }).catch(() => undefined);
  await fs.writeFile(
    sessionFile(sid),
    JSON.stringify({ messages: messages.slice(-SESSION_MAX_TURNS) }, null, 2),
    "utf8"
  );
}

async function readSessionFromPg(sessionId: string): Promise<RagSession | null> {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const res = await agentPgQuery<{ role: string; content: string }>(
    `SELECT role, content FROM rag_session_turns
     WHERE session_id = $1
     ORDER BY turn_index ASC
     LIMIT $2`,
    [sid, SESSION_MAX_TURNS]
  );
  if (!res) return null;
  const messages = res.rows
    .map((r) => ({
      role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(r.content ?? "").trim(),
    }))
    .filter((m) => m.content);
  return { messages };
}

async function writeSessionToPg(
  sessionId: string,
  messages: RagSessionMessage[],
  userId?: string
): Promise<boolean> {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;
  const capped = messages.slice(-SESSION_MAX_TURNS);
  const uid = String(userId || "").trim() || null;

  const upsertSession = await agentPgQuery(
    `INSERT INTO rag_sessions (id, user_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, rag_sessions.user_id),
       updated_at = NOW()`,
    [sid, uid]
  );
  if (!upsertSession) return false;

  const del = await agentPgQuery(`DELETE FROM rag_session_turns WHERE session_id = $1`, [sid]);
  if (!del) return false;

  for (let i = 0; i < capped.length; i++) {
    const m = capped[i]!;
    const ins = await agentPgQuery(
      `INSERT INTO rag_session_turns (session_id, turn_index, role, content)
       VALUES ($1, $2, $3, $4)`,
      [sid, i, m.role, m.content]
    );
    if (!ins) return false;
  }
  return true;
}

export async function readRagSession(sessionId: string): Promise<RagSession> {
  const backend = resolveRagStorageBackend();
  if (isPostgresStorageEnabled(backend)) {
    const pg = await readSessionFromPg(sessionId);
    if (pg && pg.messages.length) return pg;
    if (backend === "postgres" && pg) return pg;
  }
  return readSessionFromFile(sessionId);
}

export async function writeRagSession(
  sessionId: string,
  session: RagSession,
  opts?: { userId?: string }
): Promise<void> {
  const backend = resolveRagStorageBackend();
  const messages = session.messages.slice(-SESSION_MAX_TURNS);

  if (shouldWritePostgres(backend)) {
    try {
      await writeSessionToPg(sessionId, messages, opts?.userId);
    } catch {
      /* file fallback below */
    }
  }

  if (shouldWriteFile(backend)) {
    try {
      await writeSessionToFile(sessionId, messages);
    } catch {
      /* ignore */
    }
  }
}

export async function appendRagSessionTurns(
  sessionId: string,
  turns: RagSessionMessage[],
  opts?: { userId?: string }
): Promise<void> {
  const sid = String(sessionId || "").trim();
  if (!sid || !turns.length) return;
  const existing = await readRagSession(sid);
  await writeRagSession(sid, { messages: [...existing.messages, ...turns] }, opts);
}

/** 从第 fromUserIndex 条用户消息起截断（含该条及之后所有轮次） */
export async function truncateRagSessionFromUserIndex(
  sessionId: string,
  fromUserIndex: number,
  opts?: { userId?: string; replaceUserText?: string; fallbackUserText?: string }
): Promise<{ messages: RagSessionMessage[]; userCount: number; ok: boolean; resolvedUserIndex: number }> {
  const sid = String(sessionId || "").trim();
  if (!sid) return { messages: [], userCount: 0, ok: false, resolvedUserIndex: -1 };
  const existing = await readRagSession(sid);
  const msgs = existing.messages;
  const normalize = (s: string) =>
    String(s || "")
      .replace(/\n\[附件:[^\]]+\]\s*$/i, "")
      .replace(/^\[附件:[^\]]+\]\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  let userIdx = 0;
  let cutAt = -1;
  let resolvedUserIndex = -1;
  const wantIdx = Number.isFinite(fromUserIndex) && fromUserIndex >= 0 ? Math.floor(fromUserIndex) : -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role === "user") {
      if (wantIdx >= 0 && userIdx === wantIdx) {
        cutAt = i;
        resolvedUserIndex = userIdx;
        break;
      }
      userIdx++;
    }
  }
  const needle = normalize(opts?.fallbackUserText || opts?.replaceUserText || "");
  if (cutAt < 0 && needle) {
    const hits: Array<{ i: number; uidx: number }> = [];
    let nth = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]!.role !== "user") continue;
      if (normalize(msgs[i]!.content) === needle) hits.push({ i, uidx: nth });
      nth++;
    }
    if (hits.length) {
      const best =
        wantIdx >= 0
          ? hits.reduce((a, b) => (Math.abs(a.uidx - wantIdx) <= Math.abs(b.uidx - wantIdx) ? a : b))
          : hits[hits.length - 1]!;
      cutAt = best.i;
      resolvedUserIndex = best.uidx;
    }
  }
  if (cutAt < 0) {
    return {
      messages: msgs,
      userCount: msgs.filter((m) => m.role === "user").length,
      ok: false,
      resolvedUserIndex: -1,
    };
  }
  let kept = msgs.slice(0, cutAt);
  const replace = String(opts?.replaceUserText ?? "").trim();
  if (replace) {
    kept = [...kept, { role: "user", content: replace }];
  }
  await writeRagSession(sid, { messages: kept }, { userId: opts?.userId });
  const userCount = kept.filter((m) => m.role === "user").length;
  return { messages: kept, userCount, ok: true, resolvedUserIndex };
}

export async function deleteRagSession(sessionId: string): Promise<{ pg: boolean }> {
  const sid = String(sessionId || "").trim();
  if (!sid) return { pg: false };
  const backend = resolveRagStorageBackend();

  if (isPostgresStorageEnabled(backend)) {
    const del = await agentPgQuery(`DELETE FROM rag_sessions WHERE id = $1`, [sid]);
    if (del) {
      try {
        await fs.unlink(sessionFile(sid));
      } catch {
        /* ignore */
      }
      return { pg: true };
    }
  }

  try {
    await fs.unlink(sessionFile(sid));
  } catch {
    /* ignore */
  }
  return { pg: false };
}

export async function listRagSessionsForUser(userId: string): Promise<string[]> {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const backend = resolveRagStorageBackend();
  if (isPostgresStorageEnabled(backend)) {
    const res = await agentPgQuery<{ id: string }>(
      `SELECT id FROM rag_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 80`,
      [uid]
    );
    if (res) return res.rows.map((r) => r.id);
  }
  return [];
}
