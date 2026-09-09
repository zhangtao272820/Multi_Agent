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

export type RagProcessStep = {
  kind?: string;
  phase?: string;
  text?: string;
  name?: string;
  ms?: number;
  at?: number;
};

export type RagSessionMessage = {
  role: "user" | "assistant";
  content: string;
  processSteps?: RagProcessStep[];
  reasoningText?: string;
};
export type RagSession = { messages: RagSessionMessage[] };

type RagSessionFilePayload = {
  userId?: string;
  messages: RagSessionMessage[];
  updatedAt?: string;
};

const SESSION_MAX_TURNS = AMP_TTL.sessionTurnsMax;
let ragUiMetaColumnReady = false;

function sessionsDir(): string {
  return path.join(process.cwd(), ".data", "rag-sessions");
}

function sessionFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function normalizeProcessSteps(raw: unknown): RagProcessStep[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const steps = raw
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const text = String(o.text ?? "").trim();
      if (!text) return null;
      return {
        kind: o.kind != null ? String(o.kind) : undefined,
        phase: o.phase != null ? String(o.phase) : undefined,
        text,
        name: o.name != null ? String(o.name) : undefined,
        ms: typeof o.ms === "number" && Number.isFinite(o.ms) ? o.ms : undefined,
        at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : undefined,
      } as RagProcessStep;
    })
    .filter(Boolean) as RagProcessStep[];
  return steps.length ? steps.slice(0, 80) : undefined;
}

function thinkingFromUiMeta(meta: unknown): Pick<RagSessionMessage, "processSteps" | "reasoningText"> {
  if (!meta || typeof meta !== "object") return {};
  const o = meta as Record<string, unknown>;
  const processSteps = normalizeProcessSteps(o.processSteps);
  const reasoningText = String(o.reasoningText ?? "").trim();
  return {
    ...(processSteps ? { processSteps } : {}),
    ...(reasoningText ? { reasoningText } : {}),
  };
}

function uiMetaFromMessage(m: RagSessionMessage): Record<string, unknown> | null {
  const processSteps = normalizeProcessSteps(m.processSteps);
  const reasoningText = String(m.reasoningText || "").trim();
  if (!processSteps?.length && !reasoningText) return null;
  return {
    ...(processSteps ? { processSteps } : {}),
    ...(reasoningText ? { reasoningText } : {}),
  };
}

function normalizeMessages(raw: unknown): RagSessionMessage[] {
  const arr = Array.isArray((raw as { messages?: unknown })?.messages)
    ? (raw as { messages: unknown[] }).messages
    : Array.isArray(raw)
      ? raw
      : [];
  return arr
    .map((m: { role?: string; content?: string; processSteps?: unknown; reasoningText?: string; ui_meta?: unknown }) => {
      const content = String(m?.content ?? "").trim();
      if (!content) return null;
      const fromFields = {
        processSteps: normalizeProcessSteps(m?.processSteps),
        reasoningText: String(m?.reasoningText ?? "").trim() || undefined,
      };
      const fromMeta = thinkingFromUiMeta(m?.ui_meta);
      const processSteps = fromFields.processSteps || fromMeta.processSteps;
      const reasoningText = fromFields.reasoningText || fromMeta.reasoningText;
      return {
        role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content,
        ...(processSteps ? { processSteps } : {}),
        ...(reasoningText ? { reasoningText } : {}),
      } as RagSessionMessage;
    })
    .filter(Boolean)
    .slice(-SESSION_MAX_TURNS) as RagSessionMessage[];
}

async function ensureRagUiMetaColumn(): Promise<void> {
  if (ragUiMetaColumnReady) return;
  const res = await agentPgQuery(`ALTER TABLE rag_session_turns ADD COLUMN IF NOT EXISTS ui_meta JSONB`);
  if (res) ragUiMetaColumnReady = true;
}

export function resolveRagStorageBackend(env: NodeJS.ProcessEnv = process.env) {
  return resolveStorageBackend(env.RAG_AGENT_STORAGE_BACKEND, "file");
}

async function readSessionFilePayload(sessionId: string): Promise<RagSessionFilePayload | null> {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  try {
    const text = await fs.readFile(sessionFile(sid), "utf8").catch(() => "");
    if (!text.trim()) return null;
    const parsed = JSON.parse(text) as RagSessionFilePayload | RagSessionMessage[];
    if (Array.isArray(parsed)) {
      return { messages: normalizeMessages(parsed) };
    }
    if (!parsed || typeof parsed !== "object") return null;
    return {
      userId: String(parsed.userId || "").trim() || undefined,
      messages: normalizeMessages(parsed),
      updatedAt: String(parsed.updatedAt || "").trim() || undefined,
    };
  } catch {
    return null;
  }
}

async function readSessionFromFile(sessionId: string): Promise<RagSession> {
  const payload = await readSessionFilePayload(sessionId);
  return { messages: payload?.messages || [] };
}

async function writeSessionToFile(
  sessionId: string,
  messages: RagSessionMessage[],
  userId?: string
): Promise<void> {
  const sid = String(sessionId || "").trim();
  if (!sid) return;
  await fs.mkdir(sessionsDir(), { recursive: true }).catch(() => undefined);

  let prevUserId = "";
  try {
    const prev = await readSessionFilePayload(sid);
    prevUserId = String(prev?.userId || "").trim();
  } catch {
    /* ignore */
  }
  const uid = String(userId || "").trim() || prevUserId || undefined;
  const payload: RagSessionFilePayload = {
    ...(uid ? { userId: uid } : {}),
    messages: messages.slice(-SESSION_MAX_TURNS),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(sessionFile(sid), JSON.stringify(payload, null, 2), "utf8");
}

async function readSessionFromPg(sessionId: string): Promise<RagSession | null> {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  await ensureRagUiMetaColumn();
  const res = await agentPgQuery<{ role: string; content: string; ui_meta?: unknown }>(
    `SELECT role, content, ui_meta FROM rag_session_turns
     WHERE session_id = $1
     ORDER BY turn_index ASC
     LIMIT $2`,
    [sid, SESSION_MAX_TURNS]
  );
  if (!res) return null;
  const messages = res.rows
    .map((r) => {
      const content = String(r.content ?? "").trim();
      if (!content) return null;
      const thinking = thinkingFromUiMeta(r.ui_meta);
      return {
        role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content,
        ...thinking,
      } as RagSessionMessage;
    })
    .filter(Boolean) as RagSessionMessage[];
  return { messages };
}

async function writeSessionToPg(
  sessionId: string,
  messages: RagSessionMessage[],
  userId?: string,
  tenantId?: string
): Promise<boolean> {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;
  const capped = messages.slice(-SESSION_MAX_TURNS);
  const uid = String(userId || "").trim() || null;
  // rag_sessions.tenant_id 为 NOT NULL DEFAULT 'default'；显式传 NULL 会绕过默认值并写失败
  const tid = String(tenantId || "").trim() || "default";
  await ensureRagUiMetaColumn();

  const upsertSession = await agentPgQuery(
    `INSERT INTO rag_sessions (id, user_id, tenant_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, rag_sessions.user_id),
       tenant_id = COALESCE(NULLIF(EXCLUDED.tenant_id, ''), rag_sessions.tenant_id, 'default'),
       updated_at = NOW()`,
    [sid, uid, tid]
  );
  if (!upsertSession) return false;

  const del = await agentPgQuery(`DELETE FROM rag_session_turns WHERE session_id = $1`, [sid]);
  if (!del) return false;

  for (let i = 0; i < capped.length; i++) {
    const m = capped[i]!;
    const meta = uiMetaFromMessage(m);
    const ins = await agentPgQuery(
      `INSERT INTO rag_session_turns (session_id, turn_index, role, content, ui_meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [sid, i, m.role, m.content, meta ? JSON.stringify(meta) : null]
    );
    if (!ins) return false;
  }
  return true;
}

async function listSessionIdsFromFiles(userId: string): Promise<Array<{ id: string; updatedAt: string }>> {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  let names: string[] = [];
  try {
    names = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }
  const out: Array<{ id: string; updatedAt: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!id) continue;
    const filePath = sessionFile(id);
    try {
      const payload = await readSessionFilePayload(id);
      if (!payload) continue;
      if (String(payload.userId || "").trim() !== uid) continue;
      if (!payload.messages.length) continue;
      let updatedAt = String(payload.updatedAt || "").trim();
      if (!updatedAt) {
        const st = await fs.stat(filePath).catch(() => null);
        updatedAt = st?.mtime?.toISOString?.() || "";
      }
      out.push({ id, updatedAt: updatedAt || new Date(0).toISOString() });
    } catch {
      /* skip corrupt file */
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
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
  opts?: { userId?: string; tenantId?: string }
): Promise<void> {
  const backend = resolveRagStorageBackend();
  const messages = session.messages.slice(-SESSION_MAX_TURNS);
  let pgOk = !shouldWritePostgres(backend);

  if (shouldWritePostgres(backend)) {
    try {
      pgOk = await writeSessionToPg(sessionId, messages, opts?.userId, opts?.tenantId);
      if (!pgOk) {
        console.error("[ragSessionStore] postgres write returned false", { sessionId });
      }
    } catch (err) {
      pgOk = false;
      console.error("[ragSessionStore] postgres write failed", { sessionId, err });
    }
  }

  // dual/file 正常写文件；postgres-only 在 PG 失败时强制落盘，避免静默丢对话
  const mustWriteFile = shouldWriteFile(backend) || !pgOk;
  if (mustWriteFile) {
    try {
      await writeSessionToFile(sessionId, messages, opts?.userId);
    } catch (err) {
      console.error("[ragSessionStore] file write failed", { sessionId, err });
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

/** 回写最近一条助手消息的思考过程（独立端 SSE 结束后由前端补齐） */
export async function patchLastAssistantThinking(
  sessionId: string,
  thinking: { processSteps?: RagProcessStep[]; reasoningText?: string },
  opts?: { userId?: string }
): Promise<boolean> {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;
  const existing = await readRagSession(sid);
  const msgs = [...existing.messages];
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "assistant") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return false;
  const prev = msgs[idx]!;
  const processSteps = normalizeProcessSteps(thinking.processSteps);
  const reasoningText = String(thinking.reasoningText || "").trim();
  msgs[idx] = {
    role: "assistant",
    content: prev.content,
    ...(processSteps ? { processSteps } : {}),
    ...(reasoningText ? { reasoningText } : {}),
  };
  await writeRagSession(sid, { messages: msgs }, opts);
  return true;
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

export async function listRagSessionsForUser(
  userId: string,
  tenantId?: string
): Promise<string[]> {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const tid = String(tenantId || "").trim() || null;
  const backend = resolveRagStorageBackend();
  const seen = new Set<string>();
  const ordered: string[] = [];

  const pushId = (id: string) => {
    const sid = String(id || "").trim();
    if (!sid || seen.has(sid)) return;
    seen.add(sid);
    ordered.push(sid);
  };

  if (isPostgresStorageEnabled(backend)) {
    const res = tid
      ? await agentPgQuery<{ id: string }>(
          `SELECT id FROM rag_sessions WHERE user_id = $1 AND (tenant_id = $2 OR tenant_id IS NULL OR tenant_id = '') ORDER BY updated_at DESC LIMIT 80`,
          [uid, tid]
        )
      : await agentPgQuery<{ id: string }>(
          `SELECT id FROM rag_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 80`,
          [uid]
        );
    if (res) {
      for (const row of res.rows) pushId(row.id);
    }
  }

  // 文件镜像补齐：PG 空/挂掉或 postgres-only 应急落盘后，侧栏仍可恢复
  if (shouldWriteFile(backend) || backend === "postgres" || !ordered.length) {
    const fromFiles = await listSessionIdsFromFiles(uid);
    for (const row of fromFiles) pushId(row.id);
  }

  return ordered.slice(0, 80);
}

export async function getRagSessionUserId(sessionId: string): Promise<string | null> {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const res = await agentPgQuery<{ user_id: string | null }>(
    `SELECT user_id FROM rag_sessions WHERE id = $1`,
    [sid]
  ).catch(() => null);
  const uid = String(res?.rows?.[0]?.user_id || "").trim();
  return uid || null;
}

export async function getRagSessionTenantId(sessionId: string): Promise<string | null> {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const res = await agentPgQuery<{ tenant_id: string | null }>(
    `SELECT tenant_id FROM rag_sessions WHERE id = $1`,
    [sid]
  ).catch(() => null);
  const tid = String(res?.rows?.[0]?.tenant_id || "").trim();
  return tid || null;
}

export async function bindRagSessionUser(
  sessionId: string,
  userId: string,
  tenantId?: string
): Promise<void> {
  const sid = String(sessionId || "").trim();
  const uid = String(userId || "").trim();
  // rag_sessions.tenant_id NOT NULL：禁止显式 NULL
  const tid = String(tenantId || "").trim() || "default";
  if (!sid || !uid) return;
  await agentPgQuery(
    `INSERT INTO rag_sessions (id, user_id, tenant_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id = COALESCE(rag_sessions.user_id, EXCLUDED.user_id),
       tenant_id = COALESCE(NULLIF(rag_sessions.tenant_id, ''), EXCLUDED.tenant_id, 'default'),
       updated_at = NOW()`,
    [sid, uid, tid]
  ).catch(() => undefined);
}
