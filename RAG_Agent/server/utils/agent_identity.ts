/**
 * P5/P6/P7 用户身份：OIDC Bearer、总管 session 映射、角色策略。
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getRagAgentEnv } from "./rag_agent_env";
import { resolveOidcIdentity } from "./oidc_identity";

export function sanitizeUserId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return s;
}

type SessionMap = Record<string, { userId: string; updatedAt?: string }>;

type IdentityPolicy = {
  defaultAllow?: boolean;
  users?: Record<string, { roles?: string[]; disabled?: boolean }>;
};

const oidcRolesByUser = new Map<string, string[]>();

let cachedUserId: { sessionId: string; userId: string; at: number } | null = null;

async function fetchUserIdFromManager(sessionId: string): Promise<string | null> {
  const base = String(process.env.MANAGER_AGENT_HTTP_URL || "").trim();
  const token = String(process.env.CLAWHIVE_INTERNAL_TOKEN || process.env.AGENT_INTERNAL_TOKEN || "").trim();
  if (!base || !token) return null;
  if (cachedUserId && cachedUserId.sessionId === sessionId && Date.now() - cachedUserId.at < 60_000) {
    return cachedUserId.userId;
  }
  try {
    const url = `${base.replace(/\/$/, "")}/api/internal/resolve-user?session_id=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, {
      headers: { "x-clawhive-internal-token": token, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { userId?: string | null };
    const uid = sanitizeUserId(body.userId);
    if (uid) cachedUserId = { sessionId, userId: uid, at: Date.now() };
    return uid;
  } catch {
    return null;
  }
}

function sharedDataDir(): string | null {
  const custom = String(process.env.AGENT_SHARED_DATA_DIR ?? "").trim();
  if (custom) return custom;
  const manager = join(process.cwd(), "..", "Manager_Agent", ".data");
  if (existsSync(join(manager, "user-session-map.json"))) return manager;
  return null;
}

function loadSessionMap(): SessionMap {
  const dir = sharedDataDir();
  if (!dir) return {};
  const p = join(dir, "user-session-map.json");
  if (!existsSync(p)) return {};
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    return o && typeof o === "object" ? (o as SessionMap) : {};
  } catch {
    return {};
  }
}

function loadIdentityPolicy(): IdentityPolicy {
  const dir = sharedDataDir();
  const custom = String(process.env.RAG_IDENTITY_POLICY_PATH ?? "").trim();
  const p = custom || (dir ? join(dir, "agent-identity-policy.json") : "");
  if (!p || !existsSync(p)) return { defaultAllow: true };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as IdentityPolicy;
  } catch {
    return { defaultAllow: true };
  }
}

export function resolveSharedUserId(sessionId?: string): string | null {
  const env = getRagAgentEnv();
  if (!env.enableSharedIdentity) return null;
  const sid = String(sessionId ?? "").trim();
  if (!sid) return null;
  const mapped = loadSessionMap()[sid]?.userId;
  const fromFile = sanitizeUserId(mapped) ?? sanitizeUserId(sid);
  return fromFile;
}

export async function resolveSharedUserIdAsync(sessionId?: string): Promise<string | null> {
  const env = getRagAgentEnv();
  if (!env.enableSharedIdentity) return null;
  const sid = String(sessionId ?? "").trim();
  if (!sid) return null;
  const fromManager = await fetchUserIdFromManager(sid);
  if (fromManager) return fromManager;
  return resolveSharedUserId(sid);
}

export async function resolveAgentUserId(parts: {
  userId?: string;
  headerUserId?: string;
  bodyUserId?: string;
  sessionId?: string;
  conversationId?: string;
  authorization?: string;
  /** ClawHive browser JWT.sub（来自 middleware context）；优先于 body/header */
  clawhiveUserId?: string;
  authMode?: "browser" | "internal" | "open";
}): Promise<string | undefined> {
  const oidc = await resolveOidcIdentity(parts.authorization);
  if (oidc.userId) {
    if (oidc.roles.length) oidcRolesByUser.set(oidc.userId, oidc.roles);
    return oidc.userId;
  }

  // ClawHive browser：强制 JWT.sub，禁止 body/header 覆盖
  const claw = sanitizeUserId(parts.clawhiveUserId);
  if (parts.authMode === "browser" && claw) {
    for (const v of [parts.headerUserId, parts.bodyUserId, parts.userId]) {
      const claimed = sanitizeUserId(v);
      if (claimed && claimed !== claw) return claw;
    }
    return claw;
  }
  if (claw) return claw;

  for (const v of [parts.headerUserId, parts.bodyUserId, parts.userId]) {
    const uid = sanitizeUserId(v);
    if (uid) return uid;
  }

  const sid = String(parts.sessionId ?? parts.conversationId ?? "").trim();
  const shared = await resolveSharedUserIdAsync(sid);
  if (shared) return shared;

  return undefined;
}

export function getUserRoles(userId: string): string[] {
  const uid = sanitizeUserId(userId);
  if (!uid) return [];
  const fromOidc = oidcRolesByUser.get(uid);
  if (fromOidc?.length) return fromOidc;
  const policy = loadIdentityPolicy();
  return policy.users?.[uid]?.roles ?? [];
}

export function isUserDisabled(userId: string): boolean {
  const uid = sanitizeUserId(userId);
  if (!uid) return false;
  return Boolean(loadIdentityPolicy().users?.[uid]?.disabled);
}

export function checkUserAccess(userId?: string): { allowed: boolean; reason?: string } {
  const env = getRagAgentEnv();
  if (!env.enforceIdentityRoles || !env.requiredIdentityRoles.length) {
    return { allowed: true };
  }

  const uid = sanitizeUserId(userId);
  if (!uid) return { allowed: false, reason: "missing_user_id" };
  if (isUserDisabled(uid)) return { allowed: false, reason: "user_disabled" };

  const roles = getUserRoles(uid);
  const required = env.requiredIdentityRoles;
  const policy = loadIdentityPolicy();
  if (policy.defaultAllow !== false && !roles.length) return { allowed: true };
  const ok = required.some((r) => roles.includes(r));
  return ok ? { allowed: true } : { allowed: false, reason: "insufficient_role" };
}

export function getSharedIdentitySummary() {
  const env = getRagAgentEnv();
  const map = loadSessionMap();
  const policy = loadIdentityPolicy();
  return {
    enabled: env.enableSharedIdentity,
    oidcEnabled: env.enableOidc,
    enforceRoles: env.enforceIdentityRoles,
    requiredRoles: env.requiredIdentityRoles,
    sharedDataDir: sharedDataDir(),
    mappedSessions: Object.keys(map).length,
    policyUsers: Object.keys(policy.users ?? {}).length,
  };
}
