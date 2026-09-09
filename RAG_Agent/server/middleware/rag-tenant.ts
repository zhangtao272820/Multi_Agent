/**
 * Nitro：每个请求把 JWT/header 租户写入 event.context，供向量库与会话隔离。
 */
import { resolveRagHttpUser } from "../utils/ragRequestUser";

export default defineEventHandler((event) => {
  const path = String(event.path || "");
  if (!path.startsWith("/api/")) return;

  let tenantId = "default";
  let userId: string | undefined;
  try {
    const auth = resolveRagHttpUser(event);
    tenantId = String(auth.tenantId || "default").trim() || "default";
    userId = String(auth.userId || "").trim() || undefined;
  } catch {
    const h = getHeader(event, "x-tenant-id") || getHeader(event, "x-tenantId");
    if (h) tenantId = String(h).trim() || "default";
    const u = getHeader(event, "x-user-id");
    if (u) userId = String(u).trim() || undefined;
  }

  event.context.ragTenantId = tenantId;
  event.context.ragUserId = userId;
});
