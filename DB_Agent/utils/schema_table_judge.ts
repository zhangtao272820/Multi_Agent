/**
 * 智能选表：由模型阅读用户问题 + 表注释/字段摘要，判断主表/附属表与 SQL 约束。
 */
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { clipText } from "./nlu/text";
import { incrementLlmCallCount } from "./llm_call_counter";
import { formatQueryPlanForSqlAgent, type QueryPlan } from "./nlu/query_plan";
import { resolvePlaybookSectionOrFallback } from "./playbook_skills";
import { getDomainTable } from "./domain_patch";
import {
  getFootLogTable,
  getFootMeasureTable,
  planWantsTableExtension,
  queryPlanAlignsWithFootDomain,
  queryPlanWantsFootAreaDetail,
  tableCommentLooksLikeExtensionDetail,
  tableCommentLooksLikeMainRecord,
  tableNameLooksLikePersonHealthRecords,
  type SchemaRelation,
} from "./schema_relations";

export type TableBrief = {
  name: string;
  comment: string;
  columnsSummary?: string;
};

export type SchemaTableJudgeResult = {
  ranked_tables: string[];
  primary_tables: string[];
  auxiliary_tables: string[];
  reasoning: string;
  sql_hint: string;
  /** 预取/接地：仅 "llm" 表示模型选表，可整段复用；勿用切片伪造成 primary */
  judge_source?: "llm";
};

const judgeCache = new Map<string, { ts: number; value: SchemaTableJudgeResult }>();
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 80;

function cacheKey(question: string, tables: TableBrief[]) {
  return `${question}::${tables
    .map((t) => t.name)
    .sort()
    .join(",")}`;
}

function storeCache(key: string, value: SchemaTableJudgeResult) {
  judgeCache.set(key, { ts: Date.now(), value });
  if (judgeCache.size > CACHE_MAX) {
    const first = judgeCache.keys().next().value;
    if (first) judgeCache.delete(first);
  }
}

export async function judgeTablesForQuestion(
  model: BaseLanguageModel,
  opts: {
    question: string;
    queryPlan?: QueryPlan | null;
    tables: TableBrief[];
  },
): Promise<SchemaTableJudgeResult | null> {
  const tables = (opts.tables || []).filter((t) => t.name).slice(0, 5);
  if (!tables.length) return null;

  if (tables.length === 1) {
    const only = tables[0]!;
    return {
      ranked_tables: [only.name],
      primary_tables: [only.name],
      auxiliary_tables: [],
      reasoning: "仅一张候选表",
      sql_hint: "依据该表注释与列含义编写 SQL；明细类问题返回完整非敏感业务字段。",
    };
  }

  const key = cacheKey(opts.question, tables);
  const hit = judgeCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;

  const planBlock = clipText(formatQueryPlanForSqlAgent(opts.queryPlan), 380);
  const nameSet = new Set(tables.map((t) => t.name));
  const tableBlocks = tables
    .map((t) => {
      const head = `- ${t.name}${t.comment ? ` // ${t.comment}` : ""}`;
      const cols = t.columnsSummary ? clipText(t.columnsSummary, 280) : "";
      return cols ? `${head}\n${cols}` : head;
    })
    .join("\n\n");

  const judgeInstructionInline =
    "根据用户问题与候选表元数据（表注释、字段摘要）选表。区分主记录表与附属/扩展表；用户问记录/明细时优先主表。" +
    "人口/档案/业务记录统计须选注释与列能覆盖过滤条件（地区、年龄等）与维度的业务表；" +
    "疑似系统账号/登录/权限表（见表注释画像）仅在问题明确指向账号体系时才可作主表。" +
    "勿因单列英文名（如 Gender）与维度词巧合而选账号表覆盖业务档案表。" +
    "查询计划含姓名实体、要查人员档案属性（如手机号/地址）时：优先选同时具备姓名列与该属性列的人员主档表；" +
    "设备/物联网/卡片通道表仅作附属，勿因表名含 phone 而抢主表。";
  const judgeJsonInline =
    '只输出 JSON：{"ranked_tables":[],"primary_tables":[],"auxiliary_tables":[],"reasoning":"","sql_hint":""}';
  /** SSOT：skills/table_judge/skill.md § Instruction / OutputFormat */
  const judgeInstruction = resolvePlaybookSectionOrFallback(
    "table_judge",
    "Instruction",
    judgeInstructionInline,
  );
  const judgeJsonFormat = resolvePlaybookSectionOrFallback(
    "table_judge",
    "OutputFormat",
    judgeJsonInline,
  );

  const prompt = [
    judgeInstruction,
    judgeJsonFormat,
    planBlock ? `[查询计划]\n${planBlock}` : "",
    `问题：${clipText(opts.question, 200)}`,
    "候选表：",
    tableBlocks,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    incrementLlmCallCount(1);
    const resp = await model.invoke(prompt);
    const text =
      typeof (resp as any)?.content === "string" ? (resp as any).content : JSON.stringify((resp as any)?.content);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(text.slice(start, end + 1));

    const pick = (arr: unknown) =>
      (Array.isArray(arr) ? arr : [])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x && nameSet.has(x));

    const ranked = pick(obj.ranked_tables);
    const rest = tables.map((t) => t.name).filter((n) => !ranked.includes(n));
    const result: SchemaTableJudgeResult = {
      ranked_tables: [...ranked, ...rest].slice(0, 8),
      primary_tables: pick(obj.primary_tables).length ? pick(obj.primary_tables) : ranked.slice(0, 1),
      auxiliary_tables: pick(obj.auxiliary_tables),
      reasoning: String(obj.reasoning ?? "").trim(),
      sql_hint: clipText(String(obj.sql_hint ?? "").trim(), 360),
    };
    storeCache(key, result);
    return result;
  } catch {
    return null;
  }
}

export function formatSchemaJudgeHint(judge: SchemaTableJudgeResult | null | undefined): string {
  if (!judge) return "";
  const lines = ["[智能选表]（模型根据表注释与问题语义生成；编写 SQL 须遵守）"];
  if (judge.primary_tables.length) lines.push(`- 主查表：${judge.primary_tables.join("、")}`);
  if (judge.auxiliary_tables.length) {
    lines.push(`- 附属表（仅在问题需要其维度时使用，勿替代主查表）：${judge.auxiliary_tables.join("、")}`);
  }
  if (judge.sql_hint) lines.push(`- ${judge.sql_hint}`);
  if (judge.reasoning) lines.push(`- 理由：${judge.reasoning}`);
  return clipText(lines.join("\n"), 560);
}

/** 配置域主从表硬配对：仅当 queryPlan 槽位对齐该域时才跳过 LLM；否则交模型选表 */
export function tryStructuralFootTableJudge(
  briefs: TableBrief[],
  queryPlan?: QueryPlan | null,
): SchemaTableJudgeResult | null {
  if (!queryPlanAlignsWithFootDomain(queryPlan)) return null;
  const mainTable = getFootLogTable();
  const measureTable = getFootMeasureTable();
  const nameSet = new Set(briefs.map((b) => b.name));
  if (!nameSet.has(mainTable) || !nameSet.has(measureTable)) return null;
  const measureBrief = briefs.find((b) => b.name === measureTable);
  const extComment = measureBrief?.comment || "区域信息";
  if (planWantsTableExtension(queryPlan, extComment) || queryPlanWantsFootAreaDetail(queryPlan)) return null;
  const others = briefs.map((b) => b.name).filter((n) => n !== mainTable && n !== measureTable);
  return {
    ranked_tables: [mainTable, measureTable, ...others],
    primary_tables: [mainTable],
    auxiliary_tables: [measureTable],
    reasoning: "配置域主从表：检测记录主表与区域扩展从表（表注释主从关系）",
    sql_hint: `默认只查 ${mainTable}，按姓名与时间过滤；勿单独 FROM ${measureTable}`,
  };
}

/**
 * 依据 schema 主从关联 + 表注释校正选表：记录类问题默认主记录表，扩展从表仅作附属。
 */
export function applyMasterDetailJudgeFromSchema(
  judge: SchemaTableJudgeResult,
  briefs: TableBrief[],
  relations: SchemaRelation[],
  queryPlan?: QueryPlan | null,
): SchemaTableJudgeResult {
  const briefByName = new Map(briefs.map((b) => [b.name, b]));
  let primary = [...judge.primary_tables];
  let auxiliary = [...judge.auxiliary_tables];
  let ranked = [...judge.ranked_tables];
  let sqlHint = judge.sql_hint;
  let reasoning = judge.reasoning;
  let changed = false;

  const mainTable = getFootLogTable();
  const measureTable = getFootMeasureTable();
  if (
    queryPlanAlignsWithFootDomain(queryPlan) &&
    briefByName.has(mainTable) &&
    briefByName.has(measureTable)
  ) {
    const extBrief = briefByName.get(measureTable)!;
    const mainBrief = briefByName.get(mainTable)!;
    if (!planWantsTableExtension(queryPlan, extBrief.comment) && !queryPlanWantsFootAreaDetail(queryPlan)) {
      changed = true;
      primary = [mainTable, ...primary.filter((t) => t !== mainTable && t !== measureTable)];
      auxiliary = [measureTable, ...auxiliary.filter((t) => t !== measureTable && t !== mainTable)];
      ranked = [mainTable, measureTable, ...ranked.filter((t) => t !== mainTable && t !== measureTable)];
      sqlHint = `默认查主记录表 ${mainTable}（${mainBrief.comment || mainBrief.name}），落实查询计划中的姓名/时间过滤；${measureTable} 为区域扩展从表，本问题不需要 JOIN。`;
      reasoning = `${reasoning}；已据配置域主从表注释校正：以 ${mainTable} 为主查表。`.trim();
    }
  }

  for (const rel of relations) {
    const detail = rel.from_table;
    const main = rel.to_table;
    const detailBrief = briefByName.get(detail);
    const mainBrief = briefByName.get(main);
    if (!detailBrief || !mainBrief) continue;

    const isExtension =
      tableCommentLooksLikeExtensionDetail(detailBrief.comment) || rel.note.includes("从表") || rel.note.includes("扩展");
    if (!isExtension) continue;
    if (planWantsTableExtension(queryPlan, detailBrief.comment)) continue;

    changed = true;
    primary = [main, ...primary.filter((t) => t !== main && t !== detail)];
    auxiliary = [detail, ...auxiliary.filter((t) => t !== detail && t !== main)];
    ranked = [main, detail, ...ranked.filter((t) => t !== main && t !== detail)];
    sqlHint = `默认查主记录表 ${main}（${mainBrief.comment || main}），落实查询计划中的姓名/时间过滤；${detail} 为扩展从表，本问题不需要 JOIN。`;
    reasoning = `${reasoning}；已据 schema 主从关联校正：以 ${main} 为主查表。`.trim();
  }

  const extensionBriefs = briefs.filter((b) => tableCommentLooksLikeExtensionDetail(b.comment));
  const mainBriefs = briefs.filter((b) => tableCommentLooksLikeMainRecord(b.comment));
  for (const ext of extensionBriefs) {
    for (const main of mainBriefs) {
      if (ext.name === main.name) continue;
      if (planWantsTableExtension(queryPlan, ext.comment)) continue;
      if (primary.includes(main.name) && auxiliary.includes(ext.name)) continue;
      changed = true;
      primary = [main.name, ...primary.filter((t) => t !== main.name && t !== ext.name)];
      auxiliary = [ext.name, ...auxiliary.filter((t) => t !== ext.name && t !== main.name)];
      ranked = [main.name, ext.name, ...ranked.filter((t) => t !== main.name && t !== ext.name)];
      sqlHint = `默认查主记录表 ${main.name}（${main.comment || main.name}），落实查询计划中的姓名/时间过滤；${ext.name} 为扩展从表，本问题不需要 JOIN。`;
      reasoning = `${reasoning}；已据表注释校正主从：以 ${main.name} 为主查表。`.trim();
    }
  }

  if (!changed) return judge;
  return {
    ranked_tables: ranked,
    primary_tables: [...new Set(primary)],
    auxiliary_tables: [...new Set(auxiliary)],
    reasoning,
    sql_hint: clipText(sqlHint, 360),
  };
}

/** person_basic / 具名人员属性：primary_tables 必须含 person_info（域 patch 主表） */
export function applyPersonBasicPrimaryTableConstraint(
  judge: SchemaTableJudgeResult,
  briefs: TableBrief[],
  queryPlan?: QueryPlan | null,
): SchemaTableJudgeResult {
  if (!queryPlan) return judge;
  const personMaster = getDomainTable("person_info", "person_info");
  const nameSet = new Set(briefs.map((b) => b.name));
  if (!nameSet.has(personMaster)) return judge;

  const aggLike = queryPlan.intent === "aggregation" || queryPlan.intent === "comparison";
  const namedEntity = (queryPlan.entities?.names?.length ?? 0) > 0;
  const wantsPersonBasic =
    queryPlan.data_domain === "person_basic" ||
    queryPlan.subject === "person" ||
    namedEntity ||
    (aggLike && (queryPlan.entities?.locations?.length ?? 0) > 0);
  if (!wantsPersonBasic) return judge;

  let primary = [...judge.primary_tables];
  let ranked = [...judge.ranked_tables];
  let auxiliary = [...(judge.auxiliary_tables ?? [])];
  if (!primary.includes(personMaster)) {
    primary = [personMaster, ...primary.filter((t) => t !== personMaster)];
  }
  ranked = [personMaster, ...ranked.filter((t) => t !== personMaster)];

  // 档案/具名人员：健康体征表不得留在 primary（否则 inferDataDomain 会翻成 person_health）
  const demoteHealth =
    queryPlan.data_domain === "person_basic" ||
    (namedEntity && queryPlan.intent === "detail" && queryPlan.subject === "person");
  if (demoteHealth) {
    const kept: string[] = [];
    for (const t of primary) {
      if (t !== personMaster && tableNameLooksLikePersonHealthRecords(t)) {
        if (!auxiliary.includes(t)) auxiliary.push(t);
        continue;
      }
      kept.push(t);
    }
    primary = kept.length ? kept : [personMaster];
  }

  const why = namedEntity ? "具名人员属性" : "person_basic 聚合";
  const reasoning = judge.reasoning
    ? `${judge.reasoning}；${why}已锁主表 ${personMaster}${demoteHealth ? "，健康表降为附属" : ""}。`
    : `${why}已锁主表 ${personMaster}${demoteHealth ? "，健康表降为附属" : ""}。`;
  return {
    ...judge,
    ranked_tables: [...new Set(ranked)],
    primary_tables: [...new Set(primary)],
    auxiliary_tables: [...new Set(auxiliary)],
    reasoning: clipText(reasoning, 480),
  };
}

export function reorderTablesByJudge(tables: string[], judge: SchemaTableJudgeResult | null | undefined): string[] {
  if (!judge?.ranked_tables?.length) return tables;
  const set = new Set(tables);
  const out: string[] = [];
  for (const t of judge.ranked_tables) {
    if (set.has(t) && !out.includes(t)) out.push(t);
  }
  for (const t of tables) {
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
