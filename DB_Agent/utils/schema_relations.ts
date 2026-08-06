/**
 * 从 information_schema 推断表间关联（不解析用户问句，仅依据表名/列名/注释）。
 */
import type { DataSource } from "typeorm";
import { clipText } from "./nlu/text";
import type { QueryPlan } from "./nlu/query_plan";
import { getFootPressureConfig, getFootPressureMarkers } from "./domain_patch";

export type SchemaRelation = {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  note: string;
};

export type TableSchemaMeta = {
  name: string;
  comment: string;
  columns: { name: string; comment: string; dataType: string }[];
};

export async function loadTablesMeta(ds: DataSource, tables: string[]): Promise<TableSchemaMeta[]> {
  const out: TableSchemaMeta[] = [];
  for (const table of tables) {
    const t = String(table ?? "").trim();
    if (!t) continue;
    try {
      const [tRows, cRows] = await Promise.all([
        ds.query(
          `SELECT COALESCE(table_comment,'') AS comment FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
          [t],
        ),
        ds.query(
          `SELECT column_name AS name, COALESCE(column_comment,'') AS comment, COALESCE(data_type,'') AS dataType
           FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
          [t],
        ),
      ]);
      const comment = Array.isArray(tRows) && tRows[0] ? String((tRows[0] as any).comment ?? "") : "";
      const columns = Array.isArray(cRows)
        ? (cRows as any[]).map((r) => ({
            name: String(r?.name ?? ""),
            comment: String(r?.comment ?? ""),
            dataType: String(r?.dataType ?? ""),
          })).filter((c) => c.name)
        : [];
      out.push({ name: t, comment, columns });
    } catch {
      /* skip */
    }
  }
  return out;
}

function commentIncludesAny(comment: string, parts: readonly string[]): boolean {
  const c = String(comment ?? "");
  return parts.some((p) => c.includes(p));
}

function tableLooksLikePersonMaster(meta: TableSchemaMeta): boolean {
  const n = meta.name.toLowerCase();
  const c = meta.comment;
  if (n === "person_info" || n.endsWith("_info")) return true;
  if (commentIncludesAny(c, ["人员"]) && commentIncludesAny(c, ["基本", "信息", "档案"])) return true;
  return false;
}

export function tableNameLooksLikePersonMaster(table: string): boolean {
  const n = String(table ?? "").toLowerCase();
  if (!n) return false;
  if (n === "person_info") return true;
  if (n.endsWith("_info") && !n.includes("health")) return true;
  return false;
}

export function tableCommentLooksLikeExtensionDetail(comment: string): boolean {
  return commentIncludesAny(comment, ["区域信息", "分区信息", "子表", "从表", "扩展表", "明细扩展", "附属"]);
}

export function tableCommentLooksLikeMainRecord(comment: string): boolean {
  const c = String(comment ?? "");
  if (tableCommentLooksLikeExtensionDetail(c)) return false;
  if (commentIncludesAny(c, ["检测记录", "主记录", "测试记录", "业务记录", "测量记录", "就诊记录", "仪检测", "仪测量"])) return true;
  return c.includes("记录") && !c.includes("区域");
}

/** 从 information_schema 批量读取表注释（prefetch hint 路径也须对齐注释） */
export async function loadTableCommentsMap(
  ds: DataSource,
  tables: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const raw of tables) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    try {
      const rows = (await ds.query(
        `SELECT COALESCE(table_comment,'') AS comment FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
        [t],
      )) as { comment?: string }[];
      if (Array.isArray(rows) && rows[0]) out[t] = String(rows[0].comment ?? "");
    } catch {
      /* skip */
    }
  }
  return out;
}

/** 查询计划是否明确要求扩展从表（区域/分区等）维度 — 仅看 plan 槽位，不解析用户问句 */
export function planWantsTableExtension(
  queryPlan: QueryPlan | null | undefined,
  extensionTableComment: string,
): boolean {
  if (!queryPlan) return false;
  const planText = [...queryPlan.metrics, ...queryPlan.dimensions, ...queryPlan.filters.where].join(" ");
  if (!planText.trim()) return false;
  if (queryPlanWantsFootAreaDetail(queryPlan)) return true;
  const segments = String(extensionTableComment ?? "")
    .split(/[-—、，,]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const extensionMarkers = segments.filter((s) => commentIncludesAny(s, ["区域", "分区", "重心", "坐标", "热力"]));
  if (!extensionMarkers.length) return false;
  return extensionMarkers.some((m) => planText.includes(m));
}

/** 查询计划槽位是否要求足底区域/分区明细（来自 NLU plan 槽位，非用户问句正则） */
export function queryPlanWantsFootAreaDetail(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  const planText = [...plan.metrics, ...plan.dimensions, ...plan.filters.where].join(" ");
  if (!planText.trim()) return false;
  const markers = getFootPressureConfig().area_detail_markers ?? [];
  return markers.some((m) => planText.includes(m));
}

/** 查询计划槽位是否与足底域配置标记对齐（域配置驱动，非用户原话正则） */
export function queryPlanAlignsWithFootDomain(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  if (queryPlanWantsFootAreaDetail(plan)) return true;
  const planText = [
    ...plan.metrics,
    ...plan.dimensions,
    ...plan.filters.where,
    String(plan.data_domain || ""),
    String(plan.subject || ""),
  ].join(" ");
  if (!planText.trim()) return false;
  const markers = getFootPressureMarkers();
  return markers.some((m) => m && planText.includes(m));
}

/** 候选表含足底相关表时，确保主记录表在列表中 */
export function getFootLogTable(): string {
  return getFootPressureConfig().main_table;
}

export function getFootMeasureTable(): string {
  return getFootPressureConfig().measure_table;
}

/** @deprecated 使用 getFootLogTable()；补丁 data/domains/<db>/relations.json */
export const FOOT_LOG_TABLE = "remote_activity_foot_log";
/** @deprecated 使用 getFootMeasureTable() */
export const FOOT_MEASURE_LOG_TABLE = "remote_activity_foot_measure_log";

export function ensureFootPressureCandidates(tables: string[]): string[] {
  const hasAnyFoot = tables.some((t) => tableNameLooksLikeFootPressure(t));
  if (!hasAnyFoot) return tables;
  const main = getFootLogTable();
  const out = [...tables];
  if (!out.includes(main)) out.unshift(main);
  return out;
}

/** 足底主从表同时出现且 plan 对齐足底域时，主表在前（除非 plan 明确要求区域维度） */
export function reorderFootPressureCandidates(
  tables: string[],
  comments: Record<string, string>,
  queryPlan?: QueryPlan | null,
): string[] {
  if (!queryPlanAlignsWithFootDomain(queryPlan)) return tables;
  const main = getFootLogTable();
  const measure = getFootMeasureTable();
  let out = ensureFootPressureCandidates(tables);
  if (!out.includes(main) || !out.includes(measure)) return out;
  const extComment = comments[measure] || "区域信息";
  if (planWantsTableExtension(queryPlan, extComment) || queryPlanWantsFootAreaDetail(queryPlan)) return out;
  const rest = out.filter((t) => t !== main && t !== measure);
  return [main, measure, ...rest];
}

/** 足底压力 / 活动检测类表（与 person_health_records 体征档案不同域） */
export function tableLooksLikeFootPressure(meta: TableSchemaMeta): boolean {
  const n = meta.name.toLowerCase();
  const c = meta.comment;
  if (n.includes("foot") || n.includes("activity_foot")) return true;
  if (commentIncludesAny(c, ["足底", "足压", "压力测试", "步态", "平衡测量"])) return true;
  return false;
}

export function tableNameLooksLikeFootPressure(table: string): boolean {
  const n = String(table ?? "").toLowerCase();
  return n.includes("foot") || n.includes("activity_foot");
}

/** 老年护理 / 慢性病实训检测表（与 person_health_records 健康档案不同域） */
export function tableLooksLikeNursingChronic(meta: TableSchemaMeta): boolean {
  if (tableNameLooksLikeNursingChronic(meta.name)) return true;
  const c = meta.comment;
  if (commentIncludesAny(c, ["老年护理", "慢性病", "慢病", "护理实训", "护理检测"])) return true;
  return false;
}

export function tableNameLooksLikeNursingChronic(table: string): boolean {
  const n = String(table ?? "").toLowerCase();
  if (!n) return false;
  if (n.includes("nursing") && n.includes("chronic")) return true;
  return n.includes("nursing_chronic");
}

/** 个人健康体征明细表（person_health 快路径仅针对此类表） */
export function tableLooksLikePersonHealthRecords(meta: TableSchemaMeta): boolean {
  const n = meta.name.toLowerCase();
  if (n === "person_health_records") return true;
  if (n.includes("health") && n.includes("record") && !tableLooksLikeFootPressure(meta)) return true;
  const c = meta.comment;
  if (commentIncludesAny(c, ["健康记录", "健康档案", "生命体征", "血压", "血糖", "心率", "体检"])) {
    if (!commentIncludesAny(c, ["足底", "足压", "压力测试"])) return true;
  }
  return false;
}

export function tableNameLooksLikePersonHealthRecords(table: string): boolean {
  const n = String(table ?? "").toLowerCase();
  if (n === "person_health_records") return true;
  if (tableNameLooksLikeFootPressure(n)) return false;
  return n.includes("health") && n.includes("record");
}

function tableLooksLikeHealthDetail(meta: TableSchemaMeta): boolean {
  if (tableLooksLikeFootPressure(meta)) return false;
  return tableLooksLikePersonHealthRecords(meta);
}

function hasIdColumn(meta: TableSchemaMeta, col = "id") {
  return meta.columns.some((c) => c.name.toLowerCase() === col.toLowerCase());
}

function findPersonIdLink(meta: TableSchemaMeta): string | null {
  const direct = meta.columns.find((c) => c.name.toLowerCase() === "person_id");
  if (direct) return direct.name;
  const byComment = meta.columns.find(
    (c) => (c.comment.includes("人员") || c.comment.toLowerCase().includes("person")) && c.name.toLowerCase().endsWith("id"),
  );
  return byComment?.name ?? null;
}

/** 推断主从关联：明细表.foreign_id → 主表.id */
export function inferSchemaRelations(metas: TableSchemaMeta[]): SchemaRelation[] {
  const relations: SchemaRelation[] = [];
  const masters = metas.filter((m) => tableLooksLikePersonMaster(m) && hasIdColumn(m));
  const details = metas.filter((m) => tableLooksLikeHealthDetail(m) || findPersonIdLink(m));

  for (const detail of details) {
    const linkCol = findPersonIdLink(detail);
    if (!linkCol) continue;
    for (const master of masters) {
      if (!hasIdColumn(master, "id")) continue;
      relations.push({
        from_table: detail.name,
        from_column: linkCol,
        to_table: master.name,
        to_column: "id",
        note: tableLooksLikeFootPressure(detail)
          ? `「${detail.comment || detail.name}」.${linkCol} 关联 「${master.comment || master.name}」.id；按姓名查检测/活动记录时先定位人员再 JOIN`
          : `「${detail.comment || detail.name}」.${linkCol} 关联 「${master.comment || master.name}」.id；按姓名查时先在主表定位人员，再 JOIN 明细表取健康指标`,
      });
    }
  }

  // 通用 *_id → *_info / 同名主表
  for (const detail of metas) {
    for (const col of detail.columns) {
      const cn = col.name.toLowerCase();
      if (!cn.endsWith("_id") || cn === "id") continue;
      const stem = cn.slice(0, -3);
      if (!stem) continue;
      const parent =
        metas.find((m) => m.name.toLowerCase() === `${stem}_info`) ||
        metas.find((m) => m.name.toLowerCase() === stem) ||
        metas.find((m) => m.name.toLowerCase().endsWith(`_${stem}`)) ||
        metas.find((m) => m.name.toLowerCase().includes(stem) && hasIdColumn(m));
      if (!parent || !hasIdColumn(parent)) continue;
      const dup = relations.some(
        (r) => r.from_table === detail.name && r.from_column === col.name && r.to_table === parent.name,
      );
      if (!dup) {
        relations.push({
          from_table: detail.name,
          from_column: col.name,
          to_table: parent.name,
          to_column: "id",
          note: `${detail.name}.${col.name} → ${parent.name}.id`,
        });
      }
    }
  }

  // 扩展从表 → 主记录表（依据外键 + 表注释，不绑定具体业务表名）
  const footMains = metas.filter((m) => tableCommentLooksLikeMainRecord(m.comment) && hasIdColumn(m));
  const footMeasures = metas.filter((m) => tableCommentLooksLikeExtensionDetail(m.comment));
  for (const measure of footMeasures) {
    for (const main of footMains) {
      const linkCol =
        measure.columns.find((c) => c.name.toLowerCase() === "foot_log_id") ||
        measure.columns.find((c) => c.name.toLowerCase() === "activity_foot_log_id") ||
        measure.columns.find((c) => c.name.toLowerCase().endsWith("_log_id") && c.name.toLowerCase() !== "id") ||
        measure.columns.find((c) => commentIncludesAny(c.comment, ["关联", "主表", "记录"]) && c.name.toLowerCase().endsWith("_id"));
      if (!linkCol) continue;
      const dup = relations.some(
        (r) => r.from_table === measure.name && r.from_column === linkCol.name && r.to_table === main.name,
      );
      if (!dup) {
        relations.push({
          from_table: measure.name,
          from_column: linkCol.name,
          to_table: main.name,
          to_column: "id",
          note: `「${measure.comment || measure.name}」为扩展从表；默认查主记录表「${main.comment || main.name}」，仅当查询计划需要其维度时才 JOIN`,
        });
      }
    }
  }

  return relations.slice(0, 12);
}

export function formatSchemaRelationsForAgent(relations: SchemaRelation[]): string {
  if (!relations.length) return "";
  const lines = ["[表关联]（编写 JOIN 须遵守；按姓名查询时先过滤主表人员，再关联明细表）"];
  for (const r of relations) {
    lines.push(`- ${r.from_table}.${r.from_column} = ${r.to_table}.${r.to_column}：${r.note}`);
  }
  return clipText(lines.join("\n"), 900);
}

export async function discoverSchemaRelations(
  ds: DataSource,
  candidateTables: string[],
): Promise<SchemaRelation[]> {
  const tables = Array.from(new Set(candidateTables.filter(Boolean)));
  if (!tables.length) return [];
  const metas = await loadTablesMeta(ds, tables);
  return inferSchemaRelations(metas);
}

function pickPersonNameColumn(meta: TableSchemaMeta): string | null {
  const direct = meta.columns.find((c) => c.name.toLowerCase() === "name");
  if (direct) return direct.name;
  const byComment = meta.columns.find((c) => c.comment.includes("姓名"));
  return byComment?.name ?? null;
}

function pickHealthTimeColumn(meta: TableSchemaMeta): string | null {
  const preferred = ["record_time", "health_time", "measure_time", "check_time", "create_time", "update_time"];
  for (const p of preferred) {
    const hit = meta.columns.find((c) => c.name.toLowerCase() === p);
    if (hit) return hit.name;
  }
  const byComment = meta.columns.find((c) => c.comment.includes("时间") || c.comment.includes("日期"));
  return byComment?.name ?? null;
}

function isSensitiveOrIdKey(k: string) {
  const s = k.toLowerCase();
  return s === "id" || s.endsWith("_id") || ["password", "secret", "token", "身份证", "手机"].some((m) => k.includes(m));
}

/**
 * 按 schema 关联 + 查询计划中的姓名，确定性 JOIN 查健康明细（不依赖问句正则）。
 */
export async function tryPersonHealthJoinQuery(
  ds: DataSource,
  opts: {
    personName: string;
    relations: SchemaRelation[];
    tableMetas?: TableSchemaMeta[];
  },
): Promise<string | null> {
  const personName = String(opts.personName ?? "").trim();
  if (!personName || !opts.relations.length) return null;

  const metas = opts.tableMetas ?? [];
  const metaByTable = new Map(metas.map((m) => [m.name, m]));

  const healthRel = opts.relations.find((r) => {
    const detail = metaByTable.get(r.from_table);
    return detail ? tableLooksLikeHealthDetail(detail) : r.from_table.toLowerCase().includes("health");
  });
  if (!healthRel) return null;

  const masterMeta = metaByTable.get(healthRel.to_table);
  const detailMeta = metaByTable.get(healthRel.from_table);
  if (!masterMeta || !detailMeta) return null;

  const nameCol = pickPersonNameColumn(masterMeta);
  if (!nameCol) return null;

  const timeCol = pickHealthTimeColumn(detailMeta);
  const selectCols = detailMeta.columns
    .filter((c) => !isSensitiveOrIdKey(c.name))
    .slice(0, 24)
    .map((c) => {
      const label = c.comment || c.name;
      return `h.\`${c.name}\` AS \`${label}\``;
    });

  if (!selectCols.length) return null;

  const q = (id: string) => `\`${id.replace(/`/g, "")}\``;
  const order = timeCol ? ` ORDER BY h.${q(timeCol)} DESC` : "";
  const sql = `SELECT ${selectCols.join(", ")}
FROM ${q(healthRel.from_table)} h
INNER JOIN ${q(healthRel.to_table)} p ON h.${q(healthRel.from_column)} = p.${q(healthRel.to_column)}
WHERE p.${q(nameCol)} = ?
${order}
LIMIT 5`;

  let rows: any[];
  try {
    rows = (await ds.query(sql, [personName])) as any[];
  } catch {
    try {
      rows = (await ds.query(
        sql.replace(`p.${q(nameCol)} = ?`, `p.${q(nameCol)} LIKE ?`),
        [`%${personName}%`],
      )) as any[];
    } catch {
      return null;
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) return null;

  const lines: string[] = [`${personName} 的个人健康情况如下（最近 ${rows.length} 条）：`, ""];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    lines.push(`记录 ${i + 1}：`);
    for (const [k, v] of Object.entries(r)) {
      if (v === null || v === undefined || String(v).trim() === "") continue;
      lines.push(`- ${k}：${String(v)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** 明细表姓名列：schema 实际列 ∩ 偏好序；含 cus_name（护理/慢病表 SSOT） */
export function pickDetailNameColumn(meta: TableSchemaMeta): string | null {
  const preferred = [
    "person_name",
    "name",
    "cus_name",
    "elder_name",
    "patient_name",
    "user_name",
    "username",
  ];
  for (const p of preferred) {
    const hit = meta.columns.find((c) => c.name.toLowerCase() === p);
    if (hit) return hit.name;
  }
  const byComment = meta.columns.find(
    (c) => c.comment.includes("姓名") || c.comment.includes("使用者") || c.comment.includes("人员"),
  );
  return byComment?.name ?? null;
}

function pickDetailTimeColumn(meta: TableSchemaMeta): string | null {
  const preferred = [
    "test_time",
    "measure_time",
    "determination_time",
    "record_time",
    "check_time",
    "report_time",
    "create_time",
    "update_time",
    "time",
    "date",
  ];
  for (const p of preferred) {
    const hit = meta.columns.find((c) => c.name.toLowerCase() === p);
    if (hit) return hit.name;
  }
  const byComment = meta.columns.find((c) => c.comment.includes("时间") || c.comment.includes("日期"));
  return byComment?.name ?? null;
}

/** 按姓名在主查表做 SELECT * 明细快路径（不依赖问句正则，仅 schema + 姓名） */
export async function tryPrimaryTableDetailByName(
  ds: DataSource,
  opts: { table: string; personName: string; limit?: number },
): Promise<{ rows: any[]; sql: string; table: string } | null> {
  const personName = String(opts.personName ?? "").trim();
  const table = String(opts.table ?? "").trim();
  const limit = Math.max(1, Math.min(20, Number(opts.limit ?? 5)));
  if (!personName || !table) return null;

  const metas = await loadTablesMeta(ds, [table]);
  const meta = metas[0];
  if (!meta) return null;

  const nameCol = pickDetailNameColumn(meta);
  if (!nameCol) return null;

  const timeCol = pickDetailTimeColumn(meta);
  const q = (id: string) => `\`${id.replace(/`/g, "")}\``;
  const order = timeCol ? ` ORDER BY ${q(timeCol)} DESC` : "";
  const base = `SELECT * FROM ${q(table)} WHERE ${q(nameCol)}`;
  const sqlExact = `${base} = ?${order} LIMIT ${limit}`;
  const sqlLike = `${base} LIKE ?${order} LIMIT ${limit}`;

  let rows: any[] = [];
  let usedSql = sqlExact;
  try {
    rows = (await ds.query(sqlExact, [personName])) as any[];
  } catch {
    return null;
  }
  if (!rows.length) {
    try {
      rows = (await ds.query(sqlLike, [`%${personName}%`])) as any[];
      usedSql = sqlLike;
    } catch {
      return null;
    }
  }
  if (!rows.length && personName.length >= 3) {
    const prefix = personName.slice(0, 2);
    const sqlPrefix = `${base} LIKE ?${order} LIMIT ${limit}`;
    try {
      rows = (await ds.query(sqlPrefix, [`%${prefix}%`])) as any[];
      if (rows.length) usedSql = sqlPrefix;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { rows, sql: usedSql, table };
}
