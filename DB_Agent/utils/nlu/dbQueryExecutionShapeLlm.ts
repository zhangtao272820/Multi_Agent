/**
 * 查询执行形态：scalar_lookup / distribution / trend / detail_rows …
 * 优先 NLU 启发模型；结构性 fallback 仅读 QueryPlan 槽位，不对问句做业务词表/正则匹配。
 */
import { z } from "zod";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { QueryPlan } from "./query_plan";
import { isDbNluFeatureEnabled } from "../db_nlu_mode";
import { incrementLlmCallCount } from "../llm_call_counter";
import { clipText } from "./text";

export type QueryExecutionShape =
  | "scalar_lookup"
  | "distribution"
  | "trend"
  | "detail_rows"
  | "comparison"
  | "freeform_sql";

const ShapeSchema = z.object({
  shape: z.enum(["scalar_lookup", "distribution", "trend", "detail_rows", "comparison", "freeform_sql"]),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});

function safeJsonParse(text: string): unknown {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function isDbQueryExecutionShapeLlmEnabled(): boolean {
  return isDbNluFeatureEnabled("execution_shape");
}

/**
 * Plan metrics 是否指向「多列业务明细枚举」（读 metrics 槽，非用户原话路由）。
 * 对比「绑定题库名称」类单属性 DISTINCT。
 */
export function planMetricsLookLikeDetailEnumerate(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  if (planLooksLikeNamedEntityCount(plan)) return false;
  if (plan.intent === "detail") return true;
  const blob = (plan.metrics ?? []).map((m) => String(m ?? "").trim()).filter(Boolean).join(" ");
  if (!blob) return false;
  if (/明细|详情|选项内容/.test(blob)) return true;
  return false;
}

/** metrics 槽是否指向次数/条数类聚合（读 Plan，非用户原话） */
function planMetricsLookLikeCount(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  const blob = (plan.metrics ?? []).map((m) => String(m ?? "").trim()).filter(Boolean).join(" ");
  if (!blob) return false;
  return /次数|条数|几次|多少次|\bcount\b/i.test(blob);
}

/**
 * 专名 + 次数/条数（无分组维度）→ COUNT scalar，不是明细列表。
 * 只读 Plan 槽位；用于纠正「[人名]做过几次…」被误标 detail_rows。
 */
export function planLooksLikeNamedEntityCount(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  const names = plan.entities?.names?.length ?? 0;
  const dims = plan.dimensions?.length ?? 0;
  if (names < 1 || dims > 0) return false;
  return planMetricsLookLikeCount(plan);
}

/** 仅依据 QueryPlan 槽位推断（不读问句文本） */
export function inferExecutionShapeStructural(
  plan?: QueryPlan | null,
): { shape: QueryExecutionShape; confidence: number; reason: string } | null {
  if (!plan) return null;
  if (plan.intent === "schema_help") return { shape: "freeform_sql", confidence: 0.88, reason: "schema_help" };
  if (plan.intent === "comparison") return { shape: "comparison", confidence: 0.78, reason: "plan_comparison" };
  if (plan.intent === "trend") return { shape: "trend", confidence: 0.82, reason: "plan_trend" };
  // 专名次数优先于 intent=detail / 明细枚举，避免「做过几次」掉进 detail_rows
  if (planLooksLikeNamedEntityCount(plan)) {
    return { shape: "scalar_lookup", confidence: 0.86, reason: "named_entity_count" };
  }
  if (plan.intent === "detail") return { shape: "detail_rows", confidence: 0.8, reason: "plan_detail" };
  if (planMetricsLookLikeDetailEnumerate(plan)) {
    return { shape: "detail_rows", confidence: 0.84, reason: "plan_metrics_detail_enumerate" };
  }

  const dims = plan.dimensions?.length ?? 0;
  const filterWhere = plan.filters?.where?.filter(Boolean).length ?? 0;
  const filterSlots = plan.filters?.slots?.filter((s) => s.field_hint || s.value).length ?? 0;
  const filters = filterWhere + filterSlots;
  const names = plan.entities?.names?.length ?? 0;
  const metrics = plan.metrics?.filter(Boolean).length ?? 0;

  if (plan.intent === "aggregation") {
    if (dims > 0) return { shape: "distribution", confidence: 0.76, reason: "plan_has_dimensions" };
    if (names === 0 && dims === 0 && (filters > 0 || (plan.entities?.locations?.length ?? 0) > 0)) {
      return { shape: "scalar_lookup", confidence: 0.78, reason: "region_population_count" };
    }
    if ((filters > 0 || names > 0) && metrics > 0) {
      return { shape: "scalar_lookup", confidence: 0.74, reason: "filtered_metric_lookup" };
    }
    if (metrics > 0) return { shape: "distribution", confidence: 0.58, reason: "metric_without_filter" };
    return { shape: "freeform_sql", confidence: 0.5, reason: "aggregation_fallback" };
  }

  if (names > 0 && metrics > 0 && dims === 0) {
    return { shape: "scalar_lookup", confidence: 0.62, reason: "entity_metric_no_dim" };
  }
  if (plan.intent === "detail") {
    return { shape: "detail_rows", confidence: 0.74, reason: "plan_detail_intent" };
  }
  if (metrics > 0 && dims > 0) return { shape: "distribution", confidence: 0.6, reason: "metric_with_dim" };

  return null;
}


export function childDetailRowLimit(plan?: QueryPlan | null): number {
  return Math.max(15, Math.min(30, plan?.limit || 20));
}

async function inferExecutionShapeByLlm(
  model: BaseLanguageModel | null,
  question: string,
  plan?: QueryPlan | null,
): Promise<{ shape: QueryExecutionShape; confidence: number; reason: string } | null> {
  if (!model) return null;
  const q = String(question ?? "").trim();
  if (!q) return null;
  try {
    incrementLlmCallCount(1);
    const res = await model.invoke([
      [
        "system",
        [
          "你是数据库查询执行形态分类器。根据用户自然语言问题与 QueryPlan，判断应如何执行 SQL。",
          "只输出 JSON，无 Markdown；勿用关键词表或正则硬匹配。",
          "shape 含义：",
          "- scalar_lookup：有明确筛选条件，查询某个对象的一个或少数指标值/关联属性名（如「[对象]的[数值属性]是多少」→ 取单值；「绑定的[关联实体]名称/列表是什么」「里面的[关联实体]是什么」→ 取 DISTINCT 名称集合，不是列表明细）",
          "- distribution：明确要求按维度分组统计/占比/结构（如「按[维度]分布」「各类别数量」），且不是查某个具体对象的明细列表",
          "- trend：时间序列/按月/趋势变化",
          "- detail_rows：查某人/某对象的业务记录明细列表（含多步任务里仅「查库」那一步；后面的分析/报告不改变本形态）",
          "- comparison：两组或多组对比",
          "- freeform_sql：以上都不合适，需灵活 SQL",
          "判定要点：",
          "- 若问「[专名]做过几次/多少次/有几条/检测次数」→ scalar_lookup（COUNT），不要 detail_rows；次数是主答，不是拉全字段明细。",
          "- 若问「做过几次/多少次/多少条/有几条/人口数量/多少人」且已锁定地区/筛选条件（可无具体人名）→ scalar_lookup（COUNT），不要 detail_rows。",
          "- 地区+[人群]统计（如某区人数）无具体人名、无分组维度 → scalar_lookup，不要 detail_rows。",
          "- 若问题指向具体人员/对象要「记录/明细/报告内容/项目/档案」且目标是多列业务行，即使 plan.intent 暂为 aggregation，也应选 detail_rows，不要选 distribution。",
          "- 若问「X是什么/Y叫什么/名称是什么/是多少/绑定的…列表是什么/里面的[关联实体]是什么」且前半有明确对象筛选，选 scalar_lookup（DISTINCT 关联属性集合），不要选 detail_rows。",
          "- 若问「[对象]明细分别是什么」「子表明细有哪些」且要多列业务行 → detail_rows，不要 scalar_lookup 列聚合。",
          "- 若已锁定具体对象（filter_slots 有值），问其关联子记录/明细项「分别是什么/有哪些」且目标是子表多列业务明细，选 detail_rows；若目标是关联实体的名称集合（经 JSON 数组/外键展开），仍选 scalar_lookup。",
          "- 全局分布/各类别数量才是 distribution；锁定单个对象后枚举其关联明细不是 distribution。",
          "- 句末「并分析/生成报告/汇总」属于下游任务，SQL 仍按查库部分判断。",
          'schema: {"shape":"...","confidence":0-1,"reason":"简短中文"}',
        ].join("\n"),
      ],
      [
        "human",
        clipText(
          [
            `问题：${q}`,
            plan ? `intent=${plan.intent}` : "",
            plan?.metrics?.length ? `metrics=${plan.metrics.join("、")}` : "",
            plan?.dimensions?.length ? `dimensions=${plan.dimensions.join("、")}` : "",
            plan?.filters?.where?.length ? `filters=${plan.filters.where.join("、")}` : "",
            plan?.entities?.names?.length ? `names=${plan.entities.names.join("、")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          800,
        ),
      ],
    ]);
    const text = typeof (res as any)?.content === "string" ? (res as any).content : JSON.stringify((res as any)?.content);
    const parsed = ShapeSchema.safeParse(safeJsonParse(text));
    if (!parsed.success) return null;
    return {
      shape: parsed.data.shape,
      confidence: parsed.data.confidence ?? 0.65,
      reason: String(parsed.data.reason ?? "llm"),
    };
  } catch {
    return null;
  }
}

/** 地区人口/条数统计（无具体人名、无分组维度） */
export function isRegionPopulationCountPlan(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  const dims = plan.dimensions?.length ?? 0;
  const names = plan.entities?.names?.length ?? 0;
  if (dims > 0 || names > 0) return false;
  const locs = plan.entities?.locations?.length ?? 0;
  const regionSlot = plan.filters?.slots?.some((s) => {
    const h = String(s.field_hint ?? "").toLowerCase();
    const v = String(s.value ?? s.sql_match_value ?? "").trim();
    return v.length >= 2 && (h.includes("region") || h.includes("location") || h.includes("address"));
  });
  return locs > 0 || Boolean(regionSlot);
}

export function guardExecutionShapeForRegionPopulation(
  plan: QueryPlan | null | undefined,
  llmShape: QueryExecutionShape,
): QueryExecutionShape {
  if (!plan || llmShape !== "detail_rows") return llmShape;
  if (!isRegionPopulationCountPlan(plan)) return llmShape;
  const structural = inferExecutionShapeStructural({ ...plan, intent: "aggregation", dimensions: [] });
  if (structural?.shape === "scalar_lookup") return "scalar_lookup";
  return llmShape;
}

/** LLM/manager 误标 detail_rows 时，专名次数 plan 强制改回 scalar_lookup */
export function guardExecutionShapeForNamedEntityCount(
  plan: QueryPlan | null | undefined,
  llmShape: QueryExecutionShape,
): QueryExecutionShape {
  if (!plan || llmShape !== "detail_rows") return llmShape;
  if (!planLooksLikeNamedEntityCount(plan)) return llmShape;
  return "scalar_lookup";
}

/** 串联守卫：专名次数 → 地区人口 → 过滤分布（manager hint / LLM / structural 共用） */
export function applyExecutionShapeGuards(
  plan: QueryPlan | null | undefined,
  shape: QueryExecutionShape,
): { shape: QueryExecutionShape; reason?: string } {
  const afterNamed = guardExecutionShapeForNamedEntityCount(plan, shape);
  if (afterNamed !== shape) return { shape: afterNamed, reason: "named_entity_count_guard" };
  const afterRegion = guardExecutionShapeForRegionPopulation(plan, afterNamed);
  if (afterRegion !== afterNamed) return { shape: afterRegion, reason: "region_population_guard" };
  const afterDist = guardExecutionShapeForPersonDistribution(plan, afterRegion);
  if (afterDist !== afterRegion) return { shape: afterDist, reason: "person_distribution_guard" };
  return { shape: afterDist };
}

/** 计划槽位是否暗示按性别（或其它人口维度）做分布（读 plan，不解析用户原话） */
export function planImpliesGroupedDimension(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  if ((plan.dimensions?.length ?? 0) > 0) return true;
  const blob = [
    ...(plan.metrics ?? []),
    ...(plan.dimensions ?? []),
    ...(plan.filters?.where ?? []),
    ...(plan.filters?.slots ?? []).map((s) => `${s.field_hint ?? ""} ${s.value ?? ""} ${s.sql_match_value ?? ""}`),
  ].join(" ");
  return /性别|男女|男女性别|年龄段|人群|分类|分布|占比/.test(blob);
}

/** 有地区/年龄等过滤、无具体人名、且计划暗示分组维度 → 应走 distribution，禁止明细列表 */
export function isFilteredPersonDistributionPlan(plan?: QueryPlan | null): boolean {
  if (!plan) return false;
  if ((plan.entities?.names?.length ?? 0) > 0) return false;
  if (!planImpliesGroupedDimension(plan)) return false;
  const locs = plan.entities?.locations?.length ?? 0;
  const slots = (plan.filters?.slots ?? []).some((s) => {
    const h = String(s.field_hint ?? "").toLowerCase();
    const v = String(s.sql_match_value || s.value || "").trim();
    if (v.length < 1) return false;
    return (
      h.includes("region") ||
      h.includes("location") ||
      h.includes("address") ||
      h.includes("age")
    );
  });
  const where = (plan.filters?.where?.filter(Boolean).length ?? 0) > 0;
  const personish =
    plan.subject === "person" ||
    plan.data_domain === "person_basic" ||
    locs > 0 ||
    slots;
  return personish && (locs > 0 || slots || where);
}

export function guardExecutionShapeForPersonDistribution(
  plan: QueryPlan | null | undefined,
  llmShape: QueryExecutionShape,
): QueryExecutionShape {
  if (!plan) return llmShape;
  if (!isFilteredPersonDistributionPlan(plan)) return llmShape;
  if (llmShape === "detail_rows" || llmShape === "scalar_lookup") return "distribution";
  return llmShape;
}

export async function resolveQueryExecutionShape(
  model: BaseLanguageModel | null,
  question: string,
  plan?: QueryPlan | null,
  managerShapeHint?: QueryExecutionShape | null,
): Promise<{ shape: QueryExecutionShape; source: "llm" | "structural" | "default" | "manager"; reason: string }> {
  if (managerShapeHint) {
    const { shape: guardedHint, reason: guardReason } = applyExecutionShapeGuards(plan, managerShapeHint);
    return {
      shape: guardedHint,
      source: "manager",
      reason: guardReason || (guardedHint !== managerShapeHint ? "manager_shape_guarded" : "manager_execution_shape_hint"),
    };
  }
  if (isDbQueryExecutionShapeLlmEnabled() && model) {
    const llm = await inferExecutionShapeByLlm(model, question, plan);
    if (llm && llm.confidence >= 0.55) {
      const { shape: guarded, reason: guardReason } = applyExecutionShapeGuards(plan, llm.shape);
      return {
        shape: guarded,
        source: "llm",
        reason: guardReason || llm.reason,
      };
    }
  }

  const structural = inferExecutionShapeStructural(plan);
  if (structural && structural.confidence >= 0.68) {
    const { shape: guarded, reason: guardReason } = applyExecutionShapeGuards(plan, structural.shape);
    return {
      shape: guarded,
      source: "structural",
      reason: guardReason || structural.reason,
    };
  }
  if (structural) {
    const { shape: guarded, reason: guardReason } = applyExecutionShapeGuards(plan, structural.shape);
    return {
      shape: guarded,
      source: "structural",
      reason: guardReason || structural.reason,
    };
  }
  return { shape: "freeform_sql", source: "default", reason: "fallback" };
}

/** 用执行形态校正 QueryPlan，避免「总分是多少」被误判为分布统计 */
export function applyExecutionShapeToPlan(plan: QueryPlan, shape: QueryExecutionShape): QueryPlan {
  const next: QueryPlan = {
    ...plan,
    entities: { ...plan.entities, names: [...(plan.entities?.names ?? [])] },
    metrics: [...(plan.metrics ?? [])],
    dimensions: [...(plan.dimensions ?? [])],
    filters: {
      ...plan.filters,
      where: [...(plan.filters?.where ?? [])],
      slots: [...(plan.filters?.slots ?? [])],
      time_range: { ...(plan.filters?.time_range ?? { start: "", end: "", relative: "" }) },
    },
    sort: [...(plan.sort ?? [])],
  };

  switch (shape) {
    case "scalar_lookup":
      if (next.intent !== "comparison" && next.intent !== "trend") next.intent = "aggregation";
      next.dimensions = [];
      break;
    case "distribution":
      if (next.intent === "detail") next.intent = "aggregation";
      break;
    case "trend":
      next.intent = "trend";
      break;
    case "detail_rows":
      // 地区人口计数 / 专名次数 / 带过滤的人口分布不可被 detail 清空维度或改写次数语义
      if (
        isRegionPopulationCountPlan(plan) ||
        isFilteredPersonDistributionPlan(plan) ||
        planLooksLikeNamedEntityCount(plan)
      ) {
        break;
      }
      next.intent = "detail";
      next.dimensions = [];
      break;
    case "comparison":
      next.intent = "comparison";
      break;
    default:
      break;
  }
  return next;
}

export function shapeUsesGenericDistribution(shape: QueryExecutionShape): boolean {
  return shape === "distribution" || shape === "trend";
}

export function shapeIsScalarLookup(shape: QueryExecutionShape): boolean {
  return shape === "scalar_lookup";
}

/** 供 SQL 生成阶段注入的执行形态约束 */
export function formatExecutionShapeForSqlAgent(shape?: QueryExecutionShape | null): string {
  if (!shape) return "";
  switch (shape) {
    case "scalar_lookup":
      return [
        "[执行形态] scalar_lookup（属性/单值查询）",
        "- 只 SELECT 用户关心的 1~3 个业务列（如 total_score、problem_name）",
        "- 通过 JOIN 或 JSON 数组字段（如 arr_problem_id）关联时，必须 SELECT DISTINCT 目标属性列",
        "- 禁止 SELECT *；禁止一行一个 ID 重复列出同一属性",
        "- LIMIT 5~10 即可",
      ].join("\n");
    case "detail_rows":
      return "[执行形态] detail_rows：返回业务记录明细，可选全部相关业务列。";
    case "distribution":
      return "[执行形态] distribution：GROUP BY 维度 + 聚合，不是明细枚举。";
    case "trend":
      return "[执行形态] trend：按时间粒度聚合。";
    default:
      return "";
  }
}

/** 兼容旧调用：是否「带条件查单个指标」 */
export function planLooksLikeFilteredScalarQuery(plan?: QueryPlan | null, _question?: string): boolean {
  const s = inferExecutionShapeStructural(plan);
  return s?.shape === "scalar_lookup" && s.confidence >= 0.65;
}

export function planWantsDistributionStats(plan?: QueryPlan | null, _question?: string): boolean {
  if (plan?.intent === "detail") return false;
  if (planLooksLikeFilteredScalarQuery(plan)) return false;
  const s = inferExecutionShapeStructural(plan);
  if (s?.shape === "distribution" || s?.shape === "trend") return true;
  return (plan?.dimensions?.length ?? 0) > 0;
}
