/**
 * 足底压力检测记录查询工具。
 */
import type { DataSource } from "typeorm";
import { DB_AGENT_DEFAULTS } from "../db_agent_env";
import {
  getTableColumns,
  isIdKey,
  isSensitiveKey,
  isSystemAuditKey,
  normalizeValueKeepEmpty,
  pickFootNameColumn,
  pickFootTimeColumn,
} from "./shared";

function isDomainToolsEnabled() {
  return DB_AGENT_DEFAULTS.enableDomainSkills;
}

export async function queryFootPressureReportTool(
  ds: DataSource,
  params: {
    personName: string;
    table: "remote_activity_foot_log" | "remote_activity_foot_measure_log";
    limit?: number;
    /** 链路内确定性快路径调用时跳过 enableDomainSkills 开关 */
    internal?: boolean;
    /** count=只回答次数；detail=明细列表 */
    answerMode?: "count" | "detail";
  },
) {
  if (!params.internal && !isDomainToolsEnabled()) return null;
  const personName = String(params.personName ?? "").trim();
  const table = String(params.table ?? "").trim();
  const limit = Math.max(1, Math.min(20, Number(params.limit ?? 5)));
  if (!personName || !table) return null;

  const cols = await getTableColumns(ds, table);
  if (!cols.length) return null;
  const commentByName: Record<string, string> = {};
  for (const cc of cols) if (cc?.name) commentByName[String(cc.name)] = String(cc.comment ?? "");

  const nameCol = pickFootNameColumn(cols);
  if (!nameCol) return null;
  const available = new Set(cols.map((c) => String(c.name || "")));
  if (!available.has(nameCol)) return null;

  const timeCol = pickFootTimeColumn(cols);
  const safeTime = timeCol && available.has(timeCol) ? timeCol : null;

  const countRows = await ds.query(
    `SELECT COUNT(*) AS c FROM \`${table}\` WHERE \`${nameCol}\` = ? OR \`${nameCol}\` LIKE ? LIMIT 1`,
    [personName, `%${personName}%`],
  );
  let c = Array.isArray(countRows) && countRows[0] ? Number((countRows[0] as any).c) : 0;

  let nameFilter = personName;
  let likeArg = `%${personName}%`;
  if ((!Number.isFinite(c) || c <= 0) && personName.length >= 3) {
    const prefix = personName.slice(0, 2);
    const prefixRows = await ds.query(
      `SELECT COUNT(*) AS c FROM \`${table}\` WHERE \`${nameCol}\` LIKE ? LIMIT 1`,
      [`%${prefix}%`],
    );
    c = Array.isArray(prefixRows) && prefixRows[0] ? Number((prefixRows[0] as any).c) : 0;
    if (c > 0) {
      likeArg = `%${prefix}%`;
      nameFilter = personName;
    }
  }
  const count = Number.isFinite(c) && c > 0 ? Math.floor(c) : 0;

  // 查数：0 次是合法结论（≠查失败）；明细模式无行仍返回 null
  if (params.answerMode === "count") {
    const label =
      table === "remote_activity_foot_measure_log" ? "足底压力区域检测" : "足底压力检测";
    return `${personName} 的${label}次数：${count} 次。`;
  }

  if (count <= 0) return null;

  const sql = `SELECT * FROM \`${table}\` WHERE \`${nameCol}\` = ? OR \`${nameCol}\` LIKE ?${
    safeTime ? ` ORDER BY \`${safeTime}\` DESC` : ""
  } LIMIT ${limit}`;
  const rows = await ds.query(sql, [nameFilter, likeArg]);
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const title =
    table === "remote_activity_foot_measure_log"
      ? `${personName} 的足底压力区域信息如下（最近 ${Math.min(limit, rows.length)} 条）：`
      : `${personName} 的足底压力测试报告明细如下（最近 ${Math.min(limit, rows.length)} 条）：`;
  const lines: string[] = [title, ""];

  const orderedKeys = cols.map((c) => String(c.name || "")).filter(Boolean);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    lines.push(`记录 ${i + 1}：`);
    for (const k of orderedKeys) {
      if (!k) continue;
      if (isIdKey(k) || isSensitiveKey(k)) continue;
      const label = String(commentByName[k] || k);
      if (isSystemAuditKey(k, label)) continue;
      const v = normalizeValueKeepEmpty((r as any)[k]);
      lines.push(`- ${label}：${v}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
