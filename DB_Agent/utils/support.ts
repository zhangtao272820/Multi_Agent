/**
 * 文件用途：Agent 辅助工具与兜底回复策略。
 *
 * 主要职责：
 * - normalizeAgentStep / isSqlRowsToolName：兼容 LangChain 多种 intermediateSteps 结构，稳定识别 SQL 行集工具。
 * - getAgentSqlQueryStats：统计 SQL 执行次数与非空结果次数。
 * - extractLastSqlRows：从最后一步成功的 SQL 工具中提取 rows，供确定性展示（不依赖模型最终话术）。
 * - friendlyFallbackMessage：失败时的友好兜底。
 */
export type NormalizedAgentStep = {
  tool: string;
  toolInput: string;
  observation: string;
};

function stringifyToolInput(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v).trim();
    }
  }
  return String(v).trim();
}

export function normalizeAgentStep(step: unknown): NormalizedAgentStep | null {
  if (step == null) return null;
  if (Array.isArray(step) && step.length >= 2) {
    const action = step[0] as Record<string, unknown> | undefined;
    const obs = step[1];
    const rawTool = action?.tool;
    const toolName =
      typeof rawTool === "string"
        ? rawTool
        : rawTool && typeof rawTool === "object"
          ? String((rawTool as Record<string, unknown>)?.name ?? "").trim()
          : "";
    const tool = String(toolName || action?.name || "").trim();
    return {
      tool,
      toolInput: stringifyToolInput(action?.toolInput ?? action?.input),
      observation: typeof obs === "string" ? obs.trim() : String(obs ?? "").trim(),
    };
  }
  const s = step as Record<string, unknown>;
  const action = (s?.action ?? s) as Record<string, unknown> | undefined;
  const rawTool = action?.tool;
  const toolName =
    typeof rawTool === "string"
      ? rawTool
      : rawTool && typeof rawTool === "object"
        ? String((rawTool as Record<string, unknown>)?.name ?? "").trim()
        : "";
  return {
    tool: String(toolName || action?.name || s?.tool || "").trim(),
    toolInput: stringifyToolInput(action?.toolInput ?? action?.input),
    observation: String(s?.observation ?? "").trim(),
  };
}

/** 判断是否为“返回行集”的 SQL 类工具（不含 EXPLAIN / schema 结构工具）。 */
export function isSqlRowsToolName(tool: string): boolean {
  const raw = String(tool ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (!raw) return false;
  if (raw.includes("explain")) return false;
  if (raw.includes("introspect") || raw.includes("schem")) return false;
  const exact = new Set(["sql_db_query", "query_sql", "mysql_select_safe", "mysql_select"]);
  if (exact.has(raw)) return true;
  if (raw.includes("sql_db_query") || raw.includes("mysql_select_safe")) return true;
  if (raw.includes("query") && raw.includes("sql")) return true;
  return false;
}

export function getAgentSqlQueryStats(intermediateSteps: any) {
  const steps = Array.isArray(intermediateSteps) ? intermediateSteps : [];
  let queryCount = 0;
  let nonEmptyResultCount = 0;
  for (const step of steps) {
    const n = normalizeAgentStep(step);
    if (!n) continue;
    const tool = n.tool.toLowerCase();
    if (!isSqlRowsToolName(tool)) continue;
    queryCount += 1;
    const out = n.observation;
    if (!out) continue;
    if (out.startsWith("Error:")) continue;
    const lower = out.toLowerCase();
    if (lower === "[]") continue;
    if (lower === "{}") continue;
    try {
      const maybeJson = out.startsWith("{") || out.startsWith("[") ? JSON.parse(out) : null;
      if (Array.isArray(maybeJson) && maybeJson.length === 0) continue;
      if (maybeJson && typeof maybeJson === "object") {
        const rows = (maybeJson as any)?.rows;
        if (Array.isArray(rows) && rows.length === 0) continue;
      }
    } catch {}
    nonEmptyResultCount += 1;
  }
  return { queryCount, nonEmptyResultCount };
}

function parseJsonLoose(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  const sStart = t.indexOf("[");
  const sEnd = t.lastIndexOf("]");
  try {
    if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  } catch {}
  try {
    if (start !== -1 && end !== -1 && end > start) return JSON.parse(t.slice(start, end + 1));
  } catch {}
  try {
    if (sStart !== -1 && sEnd !== -1 && sEnd > sStart) return JSON.parse(t.slice(sStart, sEnd + 1));
  } catch {}
  return null;
}

function parseTableFromSql(sql: string) {
  const s = String(sql ?? "");
  const m =
    s.match(/\bfrom\s+`([^`]+)`/i) ||
    s.match(/\bfrom\s+([a-z0-9_]+)\b/i) ||
    s.match(/\bjoin\s+`([^`]+)`/i) ||
    s.match(/\bjoin\s+([a-z0-9_]+)\b/i);
  const name = (m?.[1] ?? "").trim();
  return name || null;
}

function parseTableFromKv(input: string) {
  const m = String(input ?? "").match(/(?:^|[;\n])\s*table\s*=\s*([^\s;]+)\s*(?:$|[;\n])/i);
  const name = (m?.[1] ?? "").trim();
  return name || null;
}

/** 列名是否像「人员姓名」业务字段 */
export function isLikelyPersonNameColumn(columnName: string): boolean {
  const k = String(columnName ?? "").trim();
  if (!k) return false;
  if (/姓名|人员名|老人名|长者名|住户名|客户名|长者姓名|老人姓名/.test(k)) return true;
  const s = k.toLowerCase();
  if (s === "name" || s === "fullname" || s === "full_name") return true;
  if (
    s.includes("person_name") ||
    s.includes("cus_name") ||
    s.includes("user_name") ||
    s.includes("resident_name") ||
    s.includes("elder_name")
  )
    return true;
  if (s.endsWith("_name") && !s.includes("user_name") && !s.includes("file_name") && !s.includes("class_name")) return true;
  return false;
}

/** 行是否在任一「姓名类」列上命中用户问题里的中文名 */
export function rowMatchesAnyNameHint(row: unknown, nameHints: string[]): boolean {
  const hints = (nameHints || []).map((h) => String(h ?? "").trim()).filter(Boolean);
  if (!hints.length) return true;
  const obj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  for (const col of Object.keys(obj)) {
    if (!isLikelyPersonNameColumn(col)) continue;
    const v = String(obj[col] ?? "").trim();
    if (!v) continue;
    for (const h of hints) {
      if (h.length >= 2 && v.includes(h)) return true;
    }
  }
  return false;
}

/** SQL 工具入参文本中是否已包含所有人名子串（用于判断行内无姓名列时是否仍信任 WHERE 已过滤） */
export function sqlTextContainsAllNameHints(sql: string, nameHints: string[]): boolean {
  const s = String(sql ?? "");
  if (!s.trim()) return false;
  const hints = (nameHints || []).map((h) => String(h ?? "").trim()).filter((h) => h.length >= 2);
  if (!hints.length) return false;
  return hints.every((h) => s.includes(h));
}

function scoreSqlStepForNameHints(toolInput: string, rows: any[], nameHints: string[]): number {
  const hints = nameHints.filter(Boolean);
  if (!hints.length) return 0;
  const ti = String(toolInput ?? "");
  let s = 0;
  for (const h of hints) {
    if (h.length >= 2 && ti.includes(h)) s += 120;
  }
  const matched = rows.filter((r) => rowMatchesAnyNameHint(r, hints));
  s += matched.length * 8;
  if (rows.length > 0 && matched.length === rows.length) s += 60;
  if (rows.length > 0 && matched.length === 0) s -= 150;
  return s;
}

export function extractLastSqlRows(intermediateSteps: any, opts?: { nameHints?: string[] }) {
  const steps = Array.isArray(intermediateSteps) ? intermediateSteps : [];
  if (steps.length === 0) return null;
  const nameHints = (opts?.nameHints || []).map((h) => String(h ?? "").trim()).filter((h) => h.length >= 2);

  const tryParseStep = (step: unknown) => {
    const n = normalizeAgentStep(step);
    if (!n?.tool) return null;
    const toolLc = n.tool.trim().toLowerCase();
    if (!isSqlRowsToolName(toolLc)) return null;
    const observation = n.observation;
    if (!observation || observation.startsWith("Error:")) return null;
    const parsed = parseJsonLoose(observation);
    let rows: any[] | null = null;
    let meta: any = null;
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).rows)) {
      rows = (parsed as any).rows;
      meta = (parsed as any).meta ?? null;
    }
    if (!rows || rows.length === 0) return null;
    const toolInput = n.toolInput;
    const table = parseTableFromSql(toolInput) || parseTableFromKv(toolInput);
    return { rows, table, tool: toolLc || null, toolInput: toolInput || null, meta };
  };

  if (!nameHints.length) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const got = tryParseStep(steps[i]);
      if (!got) continue;
      return { rows: got.rows, table: got.table, tool: got.tool, toolInput: got.toolInput, meta: got.meta };
    }
    return null;
  }

  let best: { rows: any[]; table: string | null; tool: string | null; toolInput: string | null; meta: any; score: number; index: number } | null = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const got = tryParseStep(steps[i]);
    if (!got) continue;
    const score = scoreSqlStepForNameHints(got.toolInput || "", got.rows, nameHints) + i * 0.001;
    if (!best || score > best.score) {
      best = {
        rows: got.rows,
        table: got.table,
        tool: got.tool,
        toolInput: got.toolInput,
        meta: got.meta,
        score,
        index: i,
      };
    }
  }
  if (!best) return null;
  return { rows: best.rows, table: best.table, tool: best.tool, toolInput: best.toolInput, meta: best.meta };
}

export function friendlyFallbackMessage(params: {
  question: string;
  routedIntent: string;
  confidence: number;
  reason: string;
}) {
  const { question, routedIntent, reason } = params;
  const q = String(question || "").trim();
  const intent = String(routedIntent || "").trim();
  if (reason === "agent_no_sql_query") {
    if (intent === "person_info") {
      return "我没能查到您想问的人员信息。要查询更准确，您可以告诉我完整的姓名，以及想查询的字段（如“龙奶奶的基本信息”）。";
    }
    if (intent === "statistics") {
      return "我没能完成这个统计查询。您可以试试更明确的统计口径，例如“老人的年龄分布”、“不同人群分类的统计”等。";
    }
    return "抱歉，我没能处理您的问题。您可以换个问法，或者告诉我更具体的需求。";
  }
  if (reason === "agent_empty_result") {
    if (intent === "person_info") {
      return "我没有在数据库里查到你要的信息。请确认姓名是否正确，或尝试其他人的信息。";
    }
    return "数据库里没有查到您需要的数据。您可以检查一下查询条件，或者换个问题试试。";
  }
  return "抱歉，我暂时无法回答您的问题。您可以换个问法，或者告诉我更具体的需求。";
}
