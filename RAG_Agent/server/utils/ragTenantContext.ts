/**
 * RAG 请求级租户：鉴权派生，贯穿向量库路径 / PG 表名 / 会话写。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeTenantId, requireTenantId } from "#agent-shared/tenantScope";

type RagTenantCtx = { tenantId: string; userId?: string };

const als = new AsyncLocalStorage<RagTenantCtx>();

export function runWithRagTenant<T>(ctx: RagTenantCtx, fn: () => T): T {
  const tenantId = normalizeTenantId(ctx.tenantId);
  return als.run({ tenantId, userId: ctx.userId }, fn);
}

function tenantFromEventContext(): string | undefined {
  try {
    // Nitro / h3：同请求内可读 event.context
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRequestEvent } = require("nitropack/runtime") as {
      getRequestEvent?: () => { context?: Record<string, unknown> } | undefined;
    };
    const ev = getRequestEvent?.();
    const tid = ev?.context?.ragTenantId;
    if (tid != null && String(tid).trim()) return String(tid).trim();
  } catch {
    /* outside request */
  }
  return undefined;
}

export function getRagRequestTenantId(fallback?: string): string {
  const fromAls = als.getStore()?.tenantId;
  if (fromAls) return fromAls;
  const fromEvent = tenantFromEventContext();
  if (fromEvent) return normalizeTenantId(fromEvent);
  try {
    return requireTenantId(fallback);
  } catch {
    return normalizeTenantId(fallback);
  }
}

export function getRagRequestUserId(): string | undefined {
  const fromAls = als.getStore()?.userId;
  if (fromAls) return fromAls;
  try {
    const { getRequestEvent } = require("nitropack/runtime") as {
      getRequestEvent?: () => { context?: Record<string, unknown> } | undefined;
    };
    const ev = getRequestEvent?.();
    const uid = ev?.context?.ragUserId;
    if (uid != null && String(uid).trim()) return String(uid).trim();
  } catch {
    /* ignore */
  }
  return undefined;
}

/** 路径 / 表名安全段 */
export function safeRagTenantSegment(tenantId?: string): string {
  const tid = tenantId ? normalizeTenantId(tenantId) : getRagRequestTenantId();
  const seg = tid
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 48);
  return seg || "default";
}
