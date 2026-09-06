/**
 * 总管 → 子 Agent 入站协议 SSOT（RAG / DB / Admin 对齐）。
 *
 * 约定（passthrough 优先）：
 * - **单源 db/rag**：outbound message/content ≡ 用户末轮原文；不传 managerTask / 编排头；history=[]；
 *   conversationId/sessionId 用步进隔离（mgr-{runId}-{agent}[-{step}]），禁止复用 Manager session。
 * - **真 multi**：每步 = 该 clause / queryFocus（一次切分）；禁止二次 LLM refine；sanitize 仅剥 planner 痕迹。
 * - **结构化侧车** manager_*_task_json：可选；happy path 不发送（与独立端同构）。
 * - **编排标记**：仅在显式编排模式使用 HTTP `x-manager-orchestrated: 1` + `x-trace-id`。
 */

import {
  buildTurnScopePayload,
  parseTurnKind,
  parseTurnScopeMode,
  parseTurnScopePayload,
  type TurnScopeMode,
  type TurnScopePayload,
} from "./turnScope.ts";

export type { TurnScopeMode, TurnScopePayload };

export const MANAGER_ORCHESTRATED_HEADER = "x-manager-orchestrated";
export const MANAGER_TRACE_HEADER = "x-trace-id";
export const MANAGER_SESSION_HEADER = "x-session-id";

/** RAG buildRagRetrievalMessage 块标记（协议级，非业务 regex） */
export const RAG_MANAGER_MARKERS = ["【检索任务】", "【核心问句】", "【输出要求】", "【索引线索】"] as const;

/** 规划器上下文块（DB/RAG/Admin 共用） */
export const PLANNER_BLOCK_MARKERS = ["\n\n[约束", "\n\n[上下文", "\n\n[上游", "\n\n[步骤", "\n\n[总管"] as const;

export const CONSTRAINT_SUFFIX_MARKERS = ["\n\n约束：", "\n\n约束:", "\n约束：", "\n约束:"] as const;

/** Admin 总管 WS message 中的约束块标记（入站剥离；协议级） */
export const ADMIN_MANAGER_MARKERS = [
  "【总管约束】",
  "【总管执行约束】",
  "【只读编排】",
  "（强制）不要等待人工确认",
  "已知信息（来自上游步骤",
  "仅处理下列个人助理能力",
] as const;

/** 总管 → Admin 结构化侧车（对齐 ManagerAdminTaskPayload / client_context.manager_task） */
export type ManagerAdminTaskPayload = {
  source: "manager";
  action_text: string;
  intent_hint?: string;
  tool_plan?: Array<{ name: string; args: Record<string, unknown> }>;
  read_only?: boolean;
  /** 复合 admin 多子句（对齐 RAG sub_queries） */
  sub_queries?: string[];
  turn_scope?: TurnScopePayload;
};

/** Admin WS / buildAdminStepQuery 前置说明行（非用户子任务） */
const ADMIN_PREAMBLE_LINE_PREFIXES = [
  "仅处理下列个人助理能力",
  "勿混入搜索",
  "勿混入知识库",
  "会议与日程须",
  "路线/地图问题必须",
  "路线/地图必须",
  "用户说「从这",
  "若已给出会议",
  "· 邮件",
  "· 联系人",
  "· 待办",
  "· 日程",
  "· 天气",
  "· 高德",
  "· 飞书",
  "【总管约束】",
  "【总管执行约束】",
  "【只读编排】",
  "（强制）不要等待人工确认",
  "已知信息（来自上游步骤",
] as const;

function isAdminPreambleLine(line: string): boolean {
  const l = String(line || "").trim();
  if (!l) return true;
  if (ADMIN_PREAMBLE_LINE_PREFIXES.some((p) => l.startsWith(p))) return true;
  if (l.startsWith("· ")) return true;
  return false;
}

/** 按行拆分；若整段被逗号拼成一行且以 preamble 开头，再按中英文逗号切开 */
function splitAdminGuardCandidates(s: string): string[] {
  const byNl = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 4);
  if (byNl.length > 1) return byNl;
  const one = byNl[0] || s.trim();
  if (!one) return [];
  if (isAdminPreambleLine(one) || one.includes("仅处理下列个人助理能力")) {
    const parts = one
      .split(/[，,]/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 4);
    if (parts.length > 1) return parts;
  }
  return byNl.length ? byNl : [one];
}

/** 剥离总管注入的 Admin 步骤 guard / 上游块，保留真实子任务行（全部拼接，勿只取末行） */
export function stripAdminManagerGuards(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // 尾部约束块：仅当标记出现在正文之后才截断（i>0）。
  // 旧逻辑 i>=0 会在「仅处理下列…」位于开头时把整段切成空串，导致 action_text 回退成带 guard 原文。
  for (const m of ADMIN_MANAGER_MARKERS) {
    const i = s.indexOf(m);
    if (i > 0) s = s.slice(0, i).trim();
  }
  for (const m of PLANNER_BLOCK_MARKERS) {
    const i = s.indexOf(m);
    if (i > 0) s = s.slice(0, i).trim();
  }

  const lines = splitAdminGuardCandidates(s);
  const taskish = lines.filter((l) => !isAdminPreambleLine(l));
  if (taskish.length) return taskish.join("，");
  if (lines.length) {
    const last = lines[lines.length - 1]!;
    return isAdminPreambleLine(last) ? "" : last;
  }
  return isAdminPreambleLine(s) ? "" : s;
}

/**
 * Admin 入站结果是否为协议垃圾（能力 preamble / 纯 guard），不得喂给 synth。
 * 结构判定：剥 guard 后为空，或整段几乎全是 preamble 行。
 */
export function isAdminResultProtocolGarbage(answer: string): boolean {
  const raw = String(answer || "").trim();
  if (!raw) return true;
  const withoutError = raw.replace(/^(error|错误|失败)\s*[:：]\s*/i, "").trim();
  if (!withoutError) return true;
  if (withoutError.includes("仅处理下列个人助理能力")) {
    const peeled = stripAdminManagerGuards(withoutError);
    if (!peeled.trim() || peeled.length < 12) return true;
    const lines = withoutError
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2 && lines.every((l) => isAdminPreambleLine(l) || /^error\s*[:：]/i.test(l))) {
      return true;
    }
  }
  const peeledOnly = stripAdminManagerGuards(withoutError);
  if (!peeledOnly.trim() && (withoutError.startsWith("· ") || withoutError.startsWith("【总管"))) {
    return true;
  }
  return false;
}

/** 人审未通过时的用户可读文案（禁止改写成「权限不足」） */
export const ADMIN_WRITE_UNCONFIRMED_USER_MSG =
  "未确认，未写入日程/待办。如需执行请重新发起并点击确认。";

/** DB 总管步骤常见前缀（入站剥离） */
export const DB_MANAGER_PREFIXES = [
  "从数据库查询相关记录并返回结构化结果：",
  "从数据库查询相关记录并返回结构化结果:",
  "从数据库查询相关记录：",
  "从数据库查询相关记录:",
  "从数据库查询：",
  "从数据库查询:",
  "在数据库中查询：",
  "在数据库中查询:",
  "在数据库中查询 ",
] as const;

/** 剥离总管注入的 DB 步骤模板前缀（协议级，非业务 regex） */
export function stripDbManagerPrefixes(raw: string): string {
  let s = String(raw ?? "").trim();
  for (const p of DB_MANAGER_PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length).trim();
      break;
    }
  }
  return s;
}

/** 总管 → RAG 结构化侧车（对齐 DB manager_task_json） */
export type ManagerRagTaskPayload = {
  source: "manager";
  /** 用于 embedding / 检索的核心问句（不含输出要求与索引线索） */
  lean_query: string;
  /** 检索范围说明（来自 scopeHintJudge） */
  scope_hint?: string;
  /** 总管已拆好的子问句；有则 RAG 应走 compound 而非盲 fast */
  sub_queries?: string[];
  /** 多轮/规划上下文锚点，供 condense 补全指代 */
  dialog_anchor?: string;
  /** 总管或 probe 给出的检索关键词扩展 */
  retrieval_keywords?: string[];
  /** 查询意图 hint：multi_part / fact_lookup / comparison 等 */
  query_intent?: string;
  /** true 时 RAG 编排模式走 standard 深度检索 */
  force_deep_retrieval?: boolean;
  /** manager_bullets = 要点列表+来源；conversational = 对话体 */
  output_style?: "manager_bullets" | "conversational";
  exclude_hints?: string[];
  /** 轮次范围：下游据此决定是否携带 history / 锚点 / 经验回放 */
  turn_scope?: TurnScopePayload;
};

/** 总管 → DB 结构化侧车（与 ManagerDbTaskPayload 字段对齐） */
export type ManagerDbTaskPayload = {
  source?: "manager";
  refined_question?: string;
  must_filters?: string[];
  schema_search_keywords?: string;
  sql_intent_summary?: string;
  risk_notes?: string[];
  hint_tables?: string[];
  hint_fields?: string[];
  schema_fk_hints?: string;
  query_plan_json?: string;
  prefetch_reuse?: boolean;
  prefetch_schema_ground_json?: string;
  turn_scope?: TurnScopePayload;
  /** 允许进入写库预览路径（仍须 HITL confirm_token 才执行） */
  write_allowed?: boolean;
  /** HITL 确认令牌（T2）；无 token 时写 SQL 仅 pending */
  confirm_token?: string;
  /** 待确认写操作 id（decide 路径） */
  pending_id?: string;
  /** 高影响写须显式确认（与 Vanna impact_estimate.requires_ack 对齐） */
  impact_ack?: boolean;
  /** 写后可选校验 SELECT */
  verify_sql?: string;
};

function parseTurnScopeField(o: Record<string, unknown>): TurnScopePayload | undefined {
  const embedded = parseTurnScopePayload(o.turn_scope);
  if (embedded) return embedded;
  const mode = parseTurnScopeMode(o.turn_scope_mode ?? o.turnScopeMode);
  const turnKind = parseTurnKind(
    (o.turn_scope && typeof o.turn_scope === "object"
      ? (o.turn_scope as Record<string, unknown>).turn_kind
      : undefined) ??
      o.turn_kind ??
      o.turnKind
  );
  return mode ? buildTurnScopePayload(mode, turnKind) : undefined;
}

export function extractManagerCoreQuestion(raw: string): string | null {
  const t = String(raw ?? "");
  const marker = "【核心问句】";
  const idx = t.indexOf(marker);
  if (idx < 0) return null;
  let rest = t.slice(idx + marker.length).trimStart();
  const blockIdx = rest.indexOf("【");
  if (blockIdx >= 0) rest = rest.slice(0, blockIdx);
  const line = rest.split("\n")[0]?.trim();
  return line || null;
}

export function looksLikeManagerRetrievalTask(raw: string): boolean {
  const t = String(raw ?? "");
  return RAG_MANAGER_MARKERS.some((m) => t.includes(m));
}

export function stripPlanConstraintsFromQuery(query: string): string {
  const s = String(query ?? "").trim();
  if (!s) return s;
  let cut = s.length;
  for (const m of CONSTRAINT_SUFFIX_MARKERS) {
    const i = s.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  if (cut >= s.length) return s;
  const head = s.slice(0, cut).trim();
  if (head) return head;
  for (const m of CONSTRAINT_SUFFIX_MARKERS) {
    const i = s.indexOf(m);
    if (i >= 0) {
      const after = s.slice(i + m.length).trim();
      if (after) return after;
    }
  }
  return s;
}

export function stripPlannerContextBlock(q: string): string {
  let out = String(q ?? "").trim();
  for (const m of PLANNER_BLOCK_MARKERS) {
    const i = out.indexOf(m);
    if (i >= 0) out = out.slice(0, i).trim();
  }
  return out;
}

function isConstraintOnlyFragment(s: string): boolean {
  const t = String(s ?? "").trim();
  if (!t) return true;
  if (/^约束[:：]/.test(t)) return true;
  if (/^保留(对象|时间)约束[:：]/.test(t)) return true;
  return false;
}

/** 从候选串中解析 lean 检索/查数问句（总管与子 Agent 共用） */
export function resolveLeanSubAgentQuery(candidates: string[], lastUserFallback = ""): string {
  const last = String(lastUserFallback ?? "").trim();
  for (const c of candidates) {
    const q = String(c ?? "").trim();
    if (q.length < 2 || isConstraintOnlyFragment(q)) continue;
    if (q.length > 900 && last.length >= 4 && last.length <= 600) return last;
    return q;
  }
  return last;
}

/** 结构性复合问句拆分（中英混合，供总管与 RAG 共用） */
export function splitCompoundQueries(text: string): string[] {
  const s = String(text || "").trim();
  if (s.length < 10) return [];
  const rawParts = s
    .split(/[，,；;、。．\n]+|[与及和且]\s*/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 4 && p.length <= 140);
  if (rawParts.length < 2) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of rawParts.sort((a, b) => b.length - a.length)) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= 6) break;
  }
  return out;
}

/** 总管侧：从用户原话与 lean 问句推断 RAG 子问句 */
export function inferManagerRagSubQueries(userTask: string, leanQuery: string): string[] {
  const lean = String(leanQuery || "").trim();
  const task = String(userTask || "").trim();
  const fromLean = splitCompoundQueries(lean);
  if (fromLean.length >= 2) return fromLean;
  const fromTask = splitCompoundQueries(task);
  if (fromTask.length >= 2) return fromTask;
  const dualField = lean.match(/(.{4,40}?)(?:和|与|及|以及)(.{4,40}?)(?:分别)?(?:是|为|多少|什么)/);
  if (dualField) {
    const a = dualField[1]!.trim();
    const b = dualField[2]!.trim();
    if (a.length >= 4 && b.length >= 4) return [a, b];
  }
  return [];
}

export function parseManagerRagTaskFromJson(raw: string | null | undefined): ManagerRagTaskPayload | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const lean = String(o.lean_query ?? "").trim();
    if (!lean && o.source !== "manager") return null;
    const sub = Array.isArray(o.sub_queries)
      ? o.sub_queries.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 6)
      : undefined;
    const exclude = Array.isArray(o.exclude_hints)
      ? o.exclude_hints.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 8)
      : undefined;
    const keywords = Array.isArray(o.retrieval_keywords)
      ? o.retrieval_keywords.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
      : undefined;
    const style = o.output_style === "conversational" ? "conversational" : "manager_bullets";
    if (!lean && !sub?.length) return null;
    const turn_scope = parseTurnScopeField(o);
    return {
      source: "manager",
      lean_query: lean || sub![0]!,
      scope_hint: String(o.scope_hint ?? "").trim() || undefined,
      sub_queries: sub?.length ? sub : undefined,
      dialog_anchor: turn_scope?.suppress_anchor ? undefined : String(o.dialog_anchor ?? "").trim() || undefined,
      retrieval_keywords: keywords?.length ? keywords : undefined,
      query_intent: String(o.query_intent ?? "").trim() || undefined,
      force_deep_retrieval: o.force_deep_retrieval === true ? true : undefined,
      output_style: style,
      exclude_hints: exclude?.length ? exclude : undefined,
      turn_scope,
    };
  } catch {
    return null;
  }
}

export function parseManagerDbTaskFromJson(raw: string | null | undefined): ManagerDbTaskPayload | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
    const must_filters = arr(o.must_filters).slice(0, 12);
    const hint_tables = arr(o.hint_tables).slice(0, 8);
    const hint_fields = arr(o.hint_fields).slice(0, 12);
    const risk_notes = arr(o.risk_notes).slice(0, 8);
    const write_allowed = o.write_allowed === true;
    const confirm_token = String(o.confirm_token ?? "").trim() || undefined;
    const pending_id = String(o.pending_id ?? "").trim() || undefined;
    const impact_ack = o.impact_ack === true;
    const verify_sql = String(o.verify_sql ?? "").trim() || undefined;
    const hasAny =
      String(o.refined_question ?? "").trim() ||
      must_filters.length ||
      String(o.schema_search_keywords ?? "").trim() ||
      String(o.query_plan_json ?? "").trim() ||
      hint_tables.length ||
      o.prefetch_reuse === true ||
      write_allowed ||
      Boolean(confirm_token) ||
      Boolean(pending_id) ||
      impact_ack;
    const turn_scope = parseTurnScopeField(o);
    if (!hasAny && !turn_scope) return null;
    return {
      source: typeof o.source === "string" ? o.source : undefined,
      refined_question: String(o.refined_question ?? "").trim() || undefined,
      must_filters: must_filters.length ? must_filters : undefined,
      schema_search_keywords: String(o.schema_search_keywords ?? "").trim() || undefined,
      sql_intent_summary: String(o.sql_intent_summary ?? "").trim() || undefined,
      risk_notes: risk_notes.length ? risk_notes : undefined,
      hint_tables: hint_tables.length ? hint_tables : undefined,
      hint_fields: hint_fields.length ? hint_fields : undefined,
      schema_fk_hints: String(o.schema_fk_hints ?? "").trim() || undefined,
      query_plan_json: String(o.query_plan_json ?? "").trim() || undefined,
      prefetch_reuse: o.prefetch_reuse === true ? true : undefined,
      prefetch_schema_ground_json: String(o.prefetch_schema_ground_json ?? "").trim() || undefined,
      turn_scope,
      write_allowed: write_allowed ? true : undefined,
      confirm_token,
      pending_id,
      impact_ack: impact_ack ? true : undefined,
      verify_sql,
    };
  } catch {
    return null;
  }
}
