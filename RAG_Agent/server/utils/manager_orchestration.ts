/** 识别总管 / 平台编排请求，用于检索侧跳过用户画像注入等。 */

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const raw = headers[name.toLowerCase()] ?? headers[name];
  return String(Array.isArray(raw) ? raw[0] : raw || "").trim();
}

/**
 * 仅显式编排头视为 Manager 编排态。
 * 不得因仅有 x-trace-id / x-run-id 切入编排管线（透传问句应走独立端 retrieve-first）。
 */
export function isManagerOrchestratedRequest(event: {
  node?: { req?: { headers?: Record<string, string | string[] | undefined> } };
}): boolean {
  const headers = event?.node?.req?.headers || {};
  return headerValue(headers, "x-manager-orchestrated") === "1";
}
