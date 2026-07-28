/**
 * 文件用途：SQL Agent 构建与复用（LangChain Classic SQL Agent）。
 *
 * 主要职责：
 * - 负责初始化大模型（ChatOpenAI）与数据库连接（TypeORM DataSource → SqlDatabase）。
 * - 组装并注册工具：Schema 检索/样例查看、安全查询，以及可选的 MCP 工具（若启用）。
 * - 提供 getAgent()，在进程内缓存同一个 Agent 实例，避免每次请求重复初始化带来的性能开销。
 *
 * 重要约束：
 * - Agent 只允许执行 SELECT，且最终对用户的回复不应包含数据库表名/库名/SQL/ID 等内部信息（由提示与输出清洗共同保障）。
 */
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { SqlDatabase } from "@langchain/classic/sql_db";
import { SQL_PREFIX, createSqlAgent, SqlToolkit } from "@langchain/classic/agents/toolkits/sql";
import { DynamicTool } from "@langchain/core/tools";
import { createError } from "h3";
import { introspectSchemaWithComments, mysqlSelectSafe } from "./schema";
import { getDataSource } from "./db";
import { createMcpTools } from "./mcp";
import { withQwenModelKwargs } from "#agent-shared/qwenModelKwargs";
import {
  readAgentLlmJsonMaxTokens,
  readAgentLlmMaxRetries,
  readAgentLlmRequestTimeoutMs,
  readAgentLlmSynthMaxTokens,
} from "#agent-shared/agentLlmSpeed";
import { PGVECTOR_DIM } from "#agent-shared/agentVectorPg";

function createDbChatOpenAI(input: {
  apiKey: string;
  model: string;
  baseURL: string;
  maxTokens?: number;
  jsonTask?: boolean;
}): ChatOpenAI {
  return new ChatOpenAI(
    withQwenModelKwargs(
      input.model,
      {
        apiKey: input.apiKey,
        model: input.model,
        configuration: { baseURL: input.baseURL },
        temperature: 0,
        timeout: readAgentLlmRequestTimeoutMs(),
        maxRetries: readAgentLlmMaxRetries(),
        maxTokens:
          typeof input.maxTokens === "number"
            ? input.maxTokens
            : input.jsonTask
              ? readAgentLlmJsonMaxTokens()
              : readAgentLlmSynthMaxTokens(),
      },
      { enableThinking: false },
    ) as ConstructorParameters<typeof ChatOpenAI>[0],
  );
}

function isReadOnlySelectSql(sql: string) {
  const raw = String(sql ?? "").trim();
  if (!raw) return { ok: false as const, reason: "empty" as const };
  const normalized = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const s = normalized.replace(/;+\s*$/g, "").trim();
  if (!s) return { ok: false as const, reason: "empty" as const };

  if (/[;][^]*[^\s]/.test(s)) {
    return { ok: false as const, reason: "multi_statement" as const };
  }
  if (!/^(select|with)\b/i.test(s)) {
    return { ok: false as const, reason: "not_select" as const };
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|load)\b/i.test(s)) {
    return { ok: false as const, reason: "write_keyword" as const };
  }
  if (/\binto\s+(outfile|dumpfile)\b/i.test(s) || /\bload_file\s*\(/i.test(s)) {
    return { ok: false as const, reason: "file_io" as const };
  }
  if (/\b(sleep|benchmark)\s*\(/i.test(s)) {
    return { ok: false as const, reason: "time_bomb" as const };
  }
  if (/\b(information_schema|performance_schema|sys)\b/i.test(s) || /\bmysql\s*\./i.test(s)) {
    return { ok: false as const, reason: "system_schema" as const };
  }

  return { ok: true as const, sql: s };
}

function extractFirstTableName(sql: string) {
  const s = String(sql ?? "");
  const m =
    s.match(/\bfrom\s+`([^`]+)`/i) ||
    s.match(/\bfrom\s+([a-z0-9_]+)\b/i) ||
    s.match(/\bjoin\s+`([^`]+)`/i) ||
    s.match(/\bjoin\s+([a-z0-9_]+)\b/i);
  const name = (m?.[1] ?? "").trim();
  return name || null;
}

function hasWhereClause(sql: string) {
  const s = String(sql ?? "").toLowerCase();
  return /\bwhere\b/.test(s);
}

function detectSelectStar(sql: string) {
  const s = String(sql ?? "").replace(/\s+/g, " ").trim();
  return /\bselect\s+\*/i.test(s) || /\bselect\s+distinct\s+\*/i.test(s);
}

function enforceSelectLimit(sql: string, maxLimit: number, defaultLimit: number) {
  const s = String(sql ?? "").trim().replace(/;+\s*$/g, "").trim();
  if (!s) return s;
  const hasLimit = /\blimit\b/i.test(s);
  if (!hasLimit) return `${s} LIMIT ${defaultLimit}`;

  const replaced = s.replace(
    /\blimit\s+(\d+)(\s*,\s*(\d+))?/i,
    (_m, a, commaPart, b) => {
      const n1 = Number(a);
      const n2 = b ? Number(b) : NaN;
      if (commaPart && Number.isFinite(n1) && Number.isFinite(n2)) {
        const safeN2 = Math.max(1, Math.min(maxLimit, Math.floor(n2)));
        return `LIMIT ${Math.max(0, Math.floor(n1))}, ${safeN2}`;
      }
      if (Number.isFinite(n1)) {
        const safe = Math.max(1, Math.min(maxLimit, Math.floor(n1)));
        return `LIMIT ${safe}`;
      }
      return `LIMIT ${Math.max(1, Math.min(maxLimit, defaultLimit))}`;
    },
  );
  return replaced;
}

function injectMysqlMaxExecutionTimeHint(sql: string, ms: number) {
  const s = String(sql ?? "").trim();
  if (!s) return s;
  const already = /max_execution_time\s*\(/i.test(s) || /MAX_EXECUTION_TIME\s*\(/i.test(s);
  if (already) return s;
  const hint = `/*+ MAX_EXECUTION_TIME(${Math.max(1, Math.floor(ms))}) */`;
  return s.replace(/\bselect\b/i, (m) => `${m} ${hint}`);
}

function normalizeMysqlErrorMessage(err: any) {
  const msg = typeof err?.message === "string" ? err.message : String(err ?? "");
  const cleaned = msg.replace(/\s+/g, " ").trim();
  const code = typeof err?.code === "string" ? err.code : null;
  const errno = typeof err?.errno === "number" ? err.errno : null;
  return { message: cleaned, code, errno };
}

function stripSqlStringLiterals(sql: string) {
  const s = String(sql ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < s.length) {
        const c = s[i]!;
        if (c === "\\" && i + 1 < s.length) {
          out += " ";
          i += 2;
          continue;
        }
        if (c === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function levenshtein(a: string, b: string) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const prev = new Array<number>(m + 1);
  const cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j]!;
  }
  return prev[m]!;
}

async function suggestClosestColumn(ds: any, table: string, unknownCol: string) {
  const t = String(table ?? "").trim();
  const raw = String(unknownCol ?? "").trim();
  const col = raw.includes(".") ? raw.split(".").pop() || raw : raw;
  const needle = col.replace(/[`"'“”]/g, "").trim();
  if (!t || !needle) return null;
  try {
    const rows = await ds.query(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
      [t],
    );
    const cols = Array.isArray(rows) ? (rows as any[]).map((r) => String(r?.name ?? "")).filter(Boolean) : [];
    if (!cols.length) return null;
    const nLower = needle.toLowerCase();
    const scored = cols
      .map((c) => {
        const cLower = c.toLowerCase();
        let score = 0;
        if (cLower === nLower) score += 100;
        if (cLower.replace(/_/g, "") === nLower.replace(/_/g, "")) score += 80;
        if (cLower.startsWith(nLower) || nLower.startsWith(cLower)) score += 30;
        if (cLower.includes(nLower) || nLower.includes(cLower)) score += 20;
        const d = levenshtein(cLower, nLower);
        score += Math.max(0, 20 - d * 4);
        return { c, score, d };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return null;
    if (best.score >= 70) return best.c;
    if (best.d <= 2) return best.c;
    return null;
  } catch {
    return null;
  }
}

async function attemptAutoFixAndRetry(params: {
  ds: any;
  sql: string;
  exec: (sql: string) => Promise<any[]>;
  error: any;
}) {
  const { ds, sql, exec, error } = params;
  const norm = normalizeMysqlErrorMessage(error);
  const msg = norm.message;
  const mUnknownCol = msg.match(/Unknown column '([^']+)'/i);
  if (mUnknownCol?.[1]) {
    const unknown = mUnknownCol[1];
    const table = extractFirstTableName(sql);
    if (table) {
      const suggestion = await suggestClosestColumn(ds, table, unknown);
      if (suggestion && suggestion !== unknown) {
        const safeSql = stripSqlStringLiterals(sql);
        const escaped = unknown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\b${escaped}\\b`, "g");
        if (re.test(safeSql)) {
          const fixed = sql.replace(re, suggestion);
          try {
            const rows = await exec(fixed);
            return {
              ok: true as const,
              rows,
              repaired: true,
              repairNote: `已自动更正列名（${unknown} → ${suggestion}）`,
            };
          } catch (e2) {
            return {
              ok: false as const,
              error: e2,
              repaired: true,
              repairNote: `已尝试自动更正列名（${unknown} → ${suggestion}），但仍执行失败`,
            };
          }
        }
      }
    }
  }
  if (norm.errno === 1213 || /deadlock/i.test(msg)) {
    try {
      const rows = await exec(sql);
      return { ok: true as const, rows, repaired: true, repairNote: "检测到死锁/并发冲突，已自动重试" };
    } catch (e2) {
      return { ok: false as const, error: e2, repaired: true, repairNote: "检测到死锁/并发冲突，自动重试失败" };
    }
  }
  return { ok: false as const, error, repaired: false as const, repairNote: "" };
}

function stableJsonStringify(value: any): string {
  const seen = new WeakSet<object>();
  const normalize = (v: any): any => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => normalize(x));
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    const keys = Object.keys(v).sort();
    const out: any = {};
    for (const k of keys) out[k] = normalize(v[k]);
    return out;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

function secretSig(v: unknown, headLen = 6) {
  const s = String(v ?? "");
  const head = s.slice(0, Math.max(0, headLen));
  return `${s.length}:${head}`;
}

// 按配置复用 Agent 实例，避免切库/切模型时缓存不刷新
const agentPromiseByKey = new Map<string, Promise<ReturnType<typeof createSqlAgent>>>();
const AGENT_CACHE_MAX = 8;
const chatModelCache = new Map<string, ChatOpenAI>();

export async function getAgent(config: {
  dbId?: string;
  domain?: string;
  enableDomainSkills?: boolean;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiAgentModel?: string;
  sqlAgentMaxIter?: number;
  sqlAgentTopK?: number;
  mysql: { host: string; port: number; user: string; password: string; database: string };
  mcpServers?: Record<string, any>;
}) {
  if (!config.openaiApiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "缺少 OPENAI_API_KEY（可通过环境变量设置）",
    });
  }
  const resolveSqlAgentMaxIter = () => {
    const fromConfig =
      typeof config.sqlAgentMaxIter === "number" && Number.isFinite(config.sqlAgentMaxIter) && config.sqlAgentMaxIter > 0
        ? Math.floor(config.sqlAgentMaxIter)
        : NaN;
    if (Number.isFinite(fromConfig)) return Math.min(24, Math.max(4, fromConfig));
    return 12;
  };
  const resolvedSqlAgentMaxIter = resolveSqlAgentMaxIter();
  const agentKey = stableJsonStringify({
    db: {
      id: config.dbId ?? "default",
      domain: config.domain ?? "generic",
      enable_domain_skills: Boolean(config.enableDomainSkills),
    },
    mysql: {
      host: config.mysql?.host,
      port: config.mysql?.port,
      user: config.mysql?.user,
      database: config.mysql?.database,
      password_sig: secretSig(config.mysql?.password, 2),
    },
    openai: {
      baseURL: config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: String(config.openaiAgentModel || "").trim() || String(config.openaiModel || "").trim() || "qwen3.5-122b-a10b",
      api_key_sig: secretSig(config.openaiApiKey, 8),
    },
    sql_agent: {
      max_iter: resolvedSqlAgentMaxIter,
      top_k: config.sqlAgentTopK,
    },
    mcpServers: config.mcpServers ?? null,
  });

  const cached = agentPromiseByKey.get(agentKey);
  if (cached) return cached;

  const promise = (async () => {
    const ds = await getDataSource(config);
    const db = await SqlDatabase.fromDataSourceParams({ appDataSource: ds });
    const modelName =
      String(config.openaiAgentModel || "").trim() ||
      String(config.openaiModel || "").trim() ||
      "qwen3.5-122b-a10b";
    const model = createDbChatOpenAI({
      apiKey: config.openaiApiKey,
      model: modelName,
      baseURL: config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    const prefix = `${SQL_PREFIX}

你是一个专业的数据库查询助手（MySQL）。
要求：
1) 只允许 SELECT；优先使用 db_schema_introspect 确认表与字段；简单筛选可用 mysql_select_safe，但"记录/明细/报告"优先使用 query-sql 并尽量返回完整非敏感字段。
2) 明细/记录/报告：默认返回更完整的非敏感业务字段（避免只给少量摘要）；结果过多时按时间倒序 LIMIT 15~20。
3) 最终回复：中文；先简要呼应用户问题，再给结论或列表，末尾可一句提示如何追问更细（不要冗长）；不输出 SQL、不暴露表名/库名；不返回任何 ID/编号；不返回身份证/电话等敏感字段（除非用户明确要求）。
4) 必须基于当前数据库里的表结构与字段注释做判断，不要假设固定业务领域。
5) 字段值翻译：若字段注释包含枚举说明（如"0未知 1男 2女"），必须在回复中将数字翻译为对应中文含义（如"2"显示为"女"），不要输出原始数字或混着注释原文一起输出。
6) 展示格式：对每条记录，使用"字段注释：值"的格式逐项列出；优先展示有值的非空字段，不要遗漏重要业务字段。
7) 主从表与多表：须用 db_schema_introspect 阅读各表**注释与列**判断主记录表与附属表；按用户问题语义选表，附属表仅在问题需要其维度时使用。
8) 若上下文含「[智能选表]」：必须遵守其中的主查表与 sql 约束。
9) 人员过滤：先用 schema/sample 确认当前查询表是否含姓名/人员名列；有则在本表 WHERE/LIKE，勿默认 JOIN 固定主表；仅当本表无人名列且注释表明需关联时再 JOIN。
10) 若输入中带「[查询计划]」：落实姓名、时间、指标、过滤要点为 WHERE/JOIN/ORDER BY/LIMIT。
11) 若上下文含「[数据探索]」样例：结合样例理解列含义编写 SQL，勿把样例当最终回答。
12) 若输入含「[SQL 编排要点]」：与查询计划一并落实为具体表、列与 JOIN。`;
    const toolkit = new SqlToolkit(db, model);
    const topKRaw =
      typeof config.sqlAgentTopK === "number" && Number.isFinite(config.sqlAgentTopK) && config.sqlAgentTopK > 0
        ? Math.floor(config.sqlAgentTopK)
        : 12;
    const safeMaxLimit = Math.max(1, Math.min(100, topKRaw));
    const safeDefaultLimit = Math.max(1, Math.min(20, safeMaxLimit));
    const safeQueryExecutor = async (sqlText: string) => {
      const checked = isReadOnlySelectSql(sqlText);
      if (!checked.ok) {
        const msg =
          checked.reason === "not_select" || checked.reason === "write_keyword"
            ? "只允许执行只读 SELECT 查询。"
            : checked.reason === "multi_statement"
              ? "检测到多条语句，已拒绝执行。"
              : checked.reason === "system_schema"
                ? "系统库/系统表访问已禁用，请使用 db_schema_introspect 获取结构信息。"
                : "SQL 不合法，已拒绝执行。";
        return `Error: ${msg}`;
      }
      const limited = enforceSelectLimit(checked.sql, safeMaxLimit, safeDefaultLimit);
      const withHint = injectMysqlMaxExecutionTimeHint(limited, 6000);
      try {
        const started = Date.now();
        const exec = async (sql: string) => (await ds.query(sql)) as any[];
        let rows: any[] = [];
        let repaired = false;
        let repairNote = "";
        let errorMessage = "";
        try {
          rows = await exec(withHint);
        } catch (e1: any) {
          const attempted = await attemptAutoFixAndRetry({ ds, sql: withHint, exec, error: e1 });
          if (attempted.ok) {
            rows = attempted.rows;
            repaired = attempted.repaired;
            repairNote = attempted.repairNote || "";
          } else {
            const norm = normalizeMysqlErrorMessage(attempted.error);
            errorMessage = norm.message || "查询失败";
            if (attempted.repaired && attempted.repairNote) {
              errorMessage = `${attempted.repairNote}；错误：${errorMessage}`;
            }
            return `Error: ${errorMessage}`;
          }
        }
        const ms = Math.max(0, Date.now() - started);
        const table = extractFirstTableName(checked.sql);
        const warnings: string[] = [];
        if (detectSelectStar(checked.sql)) warnings.push("检测到 SELECT *，建议只选择需要的字段以减少 IO");
        if (!hasWhereClause(checked.sql) && table) {
          try {
            const tr = await ds.query(
              "SELECT table_rows AS rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1",
              [table],
            );
            const approx = Array.isArray(tr) ? Number((tr as any[])[0]?.rows ?? NaN) : NaN;
            if (Number.isFinite(approx) && approx > 10_000) {
              warnings.push("疑似全表查询且数据量较大，建议增加 WHERE 条件或确保 LIMIT 足够小");
            }
          } catch {}
        }
        if (ms >= 1500) warnings.push("本次查询耗时偏长，建议查看执行计划并考虑索引优化");
        const meta = {
          execution_ms: ms,
          row_count: Array.isArray(rows) ? rows.length : 0,
          repaired,
          repair_note: repairNote || undefined,
          warnings: warnings.length ? warnings : undefined,
        };
        return JSON.stringify({ meta, rows });
      } catch (e: any) {
        return `Error: ${e?.message ?? String(e)}`;
      }
    };
    const safeQuerySqlTool = new DynamicTool({
      name: "query-sql",
      description:
        "执行安全的只读 SQL 查询（仅 SELECT/CTE），自动加 LIMIT 与超时保护。输入：一条完整 SQL。",
      func: async (input: string) => safeQueryExecutor(input ?? ""),
    });
    const safeQuerySqlToolCompat = new DynamicTool({
      name: "sql_db_query",
      description: "（兼容别名）等同 query-sql：执行安全的只读 SQL 查询（仅 SELECT/CTE）。",
      func: async (input: string) => safeQueryExecutor(input ?? ""),
    });
    const schemaIntrospectTool = new DynamicTool({
      name: "db_schema_introspect",
      description:
        "查看数据库表结构与注释。输入：list | schema:表名 | sample:表名:3 | search:关键词",
      func: async (input: string) => introspectSchemaWithComments(ds, input ?? ""),
    });
    const schemaIntrospectToolCompat = new DynamicTool({
      name: "db_schem-introspect",
      description:
        "（兼容旧名）查看数据库表结构与注释。输入：list | schema:表名 | sample:表名:3 | search:关键词",
      func: async (input: string) => introspectSchemaWithComments(ds, input ?? ""),
    });
    const mysqlSelectSafeTool = new DynamicTool({
      name: "mysql_select_safe",
      description:
        "安全查询（仅 SELECT）。输入用分号分隔：table=表名; columns=列1,列2; eq.列=值; like.列=关键词; order_by=列; order_dir=ASC|DESC; limit=20; offset=0",
      func: async (input: string) => mysqlSelectSafe(ds, input ?? ""),
    });
    const mysqlExplainTool = new DynamicTool({
      name: "mysql_explain",
      description: "生成 SQL 执行计划（EXPLAIN）。输入：一条完整 SELECT/CTE SQL。",
      func: async (input: string) => {
        const checked = isReadOnlySelectSql(input);
        if (!checked.ok) return `Error: 只允许对只读 SELECT/CTE 生成执行计划。`;
        const limited = enforceSelectLimit(checked.sql, safeMaxLimit, safeDefaultLimit);
        const withHint = injectMysqlMaxExecutionTimeHint(limited, 6000);
        try {
          const rows = await ds.query("EXPLAIN FORMAT=JSON " + withHint.replace(/^\s*(select|with)\b/i, "$1"));
          const firstRow: any = Array.isArray(rows) ? (rows as any[])[0] : null;
          const raw = firstRow ? (firstRow.EXPLAIN ?? firstRow.explain ?? null) : null;
          if (typeof raw === "string" && raw.trim()) {
            try {
              const json = JSON.parse(raw);
              return JSON.stringify({ format: "json", plan: json });
            } catch {
              return JSON.stringify({ format: "json", plan: raw });
            }
          }
        } catch {}
        try {
          const plan = await ds.query("EXPLAIN " + withHint.replace(/^\s*(select|with)\b/i, "$1"));
          return JSON.stringify({ format: "tabular", plan });
        } catch (e: any) {
          return `Error: ${e?.message ?? String(e)}`;
        }
      },
    });
    toolkit.tools = toolkit.tools.filter((t: any) => String(t?.name ?? "").trim() !== "query-sql");
    toolkit.tools = [
      schemaIntrospectTool,
      schemaIntrospectToolCompat,
      mysqlSelectSafeTool,
      mysqlExplainTool,
      safeQuerySqlTool,
      safeQuerySqlToolCompat,
      ...toolkit.tools,
    ];
    try {
      const mcpTools = await createMcpTools({ mcpServers: (config as any)?.mcpServers });
      if (Array.isArray(mcpTools) && mcpTools.length > 0) toolkit.tools.push(...mcpTools);
    } catch {}
    const parseModelB = (() => {
      const m = modelName.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b/);
      if (!m?.[1]) return null;
      const v = Number(m[1]);
      return Number.isFinite(v) ? v : null;
    })();
    const weak = typeof parseModelB === "number" ? parseModelB <= 14 : false;
    const topK = weak ? Math.min(10, safeMaxLimit) : safeMaxLimit;
    const executor = createSqlAgent(model, toolkit, { prefix, topK });
    (executor as any).returnIntermediateSteps = true;
    (executor as any).maxIterations = resolvedSqlAgentMaxIter;
    (executor as any).handleParsingErrors = true;
    return executor;
  })();

  agentPromiseByKey.set(agentKey, promise);
  if (agentPromiseByKey.size > AGENT_CACHE_MAX) {
    const firstKey = agentPromiseByKey.keys().next().value;
    if (firstKey) agentPromiseByKey.delete(firstKey);
  }
  return promise;
}

export function getChatModel(config: { openaiApiKey?: string; openaiBaseUrl?: string; openaiModel?: string }) {
  if (!config.openaiApiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "缺少 OPENAI_API_KEY（可通过环境变量设置）",
    });
  }
  const key = [
    String(config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    String(config.openaiModel ?? "qwen3.5-flash"),
    String(config.openaiApiKey).slice(0, 8),
  ].join("|");
  const cached = chatModelCache.get(key);
  if (cached) return cached;
  const model = createDbChatOpenAI({
    apiKey: config.openaiApiKey,
    model: config.openaiModel ?? "qwen3.5-flash",
    baseURL: config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  chatModelCache.set(key, model);
  return model;
}

type OpenAiClientConfig = {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
};

/** 编排模型：查询计划、路由、选表重排、SQL Preflight；未单独配置时与主模型相同。 */
export function getOrchestrationChatModel(
  config: OpenAiClientConfig & { openaiOrchestrationModel?: string },
): ChatOpenAI {
  if (!config.openaiApiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "缺少 OPENAI_API_KEY（可通过环境变量设置）",
    });
  }
  const baseUrl = String(config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const baseModel = String(config.openaiModel ?? "qwen3.5-flash").trim();
  const orch = String(config.openaiOrchestrationModel ?? "").trim() || baseModel;
  if (orch === baseModel) return getChatModel(config);
  const key = [baseUrl, `orch:${orch}`, String(config.openaiApiKey).slice(0, 8)].join("|");
  const cached = chatModelCache.get(key);
  if (cached) return cached;
  const m = createDbChatOpenAI({
    apiKey: config.openaiApiKey,
    model: orch,
    baseURL: baseUrl,
  });
  chatModelCache.set(key, m);
  return m;
}

export type EmbeddingClientConfig = {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
};

const embeddingModelCache = new Map<string, OpenAIEmbeddings>();

/** 向量经验库用 embedding（DashScope text-embedding-v1 等）。 */
export function getEmbeddingModel(config: EmbeddingClientConfig): OpenAIEmbeddings {
  if (!config.openaiApiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "缺少 OPENAI_API_KEY（可通过环境变量设置）",
    });
  }
  const baseUrl = String(config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const modelName = String(config.embeddingModel ?? "text-embedding-v1").trim() || "text-embedding-v1";
  const dims =
    Number.isFinite(config.embeddingDimensions) && (config.embeddingDimensions ?? 0) > 0
      ? Math.floor(config.embeddingDimensions!)
      : PGVECTOR_DIM;
  const key = [baseUrl, modelName, String(config.openaiApiKey).slice(0, 8), String(dims)].join("|");
  const cached = embeddingModelCache.get(key);
  if (cached) return cached;
  const emb = new OpenAIEmbeddings({
    apiKey: config.openaiApiKey,
    model: modelName,
    dimensions: dims,
    configuration: { baseURL: baseUrl },
    timeout: (() => {
      const n = Number(process.env.AGENT_EMBEDDING_TIMEOUT_MS || 12_000);
      return Number.isFinite(n) && n >= 3_000 ? Math.min(60_000, Math.floor(n)) : 12_000;
    })(),
    maxRetries: 0,
  });
  embeddingModelCache.set(key, emb);
  return emb;
}

/** SQL 生成：sql_direct / sql_plan_direct / QueryIR 修复；默认用 Coder 模型。 */
export function getSqlCoderChatModel(
  config: OpenAiClientConfig & { openaiAgentModel?: string },
): ChatOpenAI {
  if (!config.openaiApiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "缺少 OPENAI_API_KEY（可通过环境变量设置）",
    });
  }
  const baseUrl = String(config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const coder = String(config.openaiAgentModel ?? "").trim() || String(config.openaiModel ?? "qwen3-coder-plus").trim();
  const key = [baseUrl, `sql:${coder}`, String(config.openaiApiKey).slice(0, 8)].join("|");
  const cached = chatModelCache.get(key);
  if (cached) return cached;
  const m = createDbChatOpenAI({
    apiKey: config.openaiApiKey,
    model: coder,
    baseURL: baseUrl,
  });
  chatModelCache.set(key, m);
  return m;
}

/** 轻量 NLU：仅「追问 → 独立问句」改写；未单独配置时与主模型相同。 */
export function getNluChatModel(config: OpenAiClientConfig & { openaiNluModel?: string }): ChatOpenAI {
  if (!config.openaiApiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "缺少 OPENAI_API_KEY（可通过环境变量设置）",
    });
  }
  const baseUrl = String(config.openaiBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const baseModel = String(config.openaiModel ?? "qwen3.5-flash").trim();
  const nlu = String(config.openaiNluModel ?? "").trim() || baseModel;
  if (nlu === baseModel) return getChatModel(config);
  const key = [baseUrl, `nlu:${nlu}`, String(config.openaiApiKey).slice(0, 8)].join("|");
  const cached = chatModelCache.get(key);
  if (cached) return cached;
  const m = createDbChatOpenAI({
    apiKey: config.openaiApiKey,
    model: nlu,
    baseURL: baseUrl,
  });
  chatModelCache.set(key, m);
  return m;
}
