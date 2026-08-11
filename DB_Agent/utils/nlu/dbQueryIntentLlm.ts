/**
 * Stage-2 意图识别节点：先判查询类别，再路由到专用槽位填充。
 * 纯 LLM 语义理解，不对问句做业务词表/正则硬匹配。
 */
import { z } from "zod";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { incrementLlmCallCount } from "../llm_call_counter";
import { clipText } from "./text";
import { isDbNluFeatureEnabled } from "../db_nlu_mode";

export type DbQueryIntent =
  | "attribute_lookup"
  | "detail_list"
  | "distribution"
  | "trend"
  | "comparison"
  | "schema_help"
  | "out_of_scope"
  | "unknown";

const IntentSchema = z.object({
  intent: z.enum([
    "attribute_lookup",
    "detail_list",
    "distribution",
    "trend",
    "comparison",
    "schema_help",
    "out_of_scope",
    "unknown",
  ]),
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

export function isDbQueryIntentLlmEnabled(): boolean {
  return isDbNluFeatureEnabled("intent");
}

const INTENT_FEW_SHOT = `
示例（只学分类逻辑，勿死记表名/真人名）：
- 「[对象]的[数值属性]是多少」→ attribute_lookup（单值属性）
- 「[父对象]绑定的[关联实体]名称/列表是什么」→ attribute_lookup（JSON/外键关联后 DISTINCT 名称集合，非明细 dump）
- 「[父对象]的[子表]明细分别是什么」→ detail_list（父筛 + 子表多列逐行，非 DISTINCT 单属性）
- 「[人名]的[检测/业务]记录」→ detail_list（按人查明细，非单值属性）
- 「按[维度]分布」/「[地区]+[年龄]下按[维度]分布」→ distribution
- 「最近一段时间[指标]变化趋势」→ trend
- 「表 [table] 有哪些字段」→ schema_help
- 「你好/今天天气怎么样」→ out_of_scope
`.trim();

async function classifyIntentByLlm(
  model: BaseLanguageModel | null,
  question: string,
): Promise<{ intent: DbQueryIntent; confidence: number; reason: string } | null> {
  if (!model) return null;
  const q = String(question ?? "").trim();
  if (!q) return null;
  try {
    incrementLlmCallCount(1);
    const res = await model.invoke([
      [
        "system",
        [
          "你是数据库问句意图识别器（Stage-1）。只判断用户想做什么类型的查询，不填具体槽位。",
          "只输出 JSON，无 Markdown。按语义理解，勿用关键词表或正则硬匹配。",
          "intent 含义：",
          "- attribute_lookup：有明确筛选对象，问该对象的某个属性值/关联属性是什么（含「是多少」「叫什么」「名称是什么」「绑定的…列表是什么」经 JSON/外键关联后的名称集合）；不是列出全部业务记录明细",
          "- detail_list：要某人/某对象的业务记录、明细、列表、档案条目（含「…明细分别是什么」→ 子表多列逐行；与「绑定题库名称是什么」的 DISTINCT 名称集合不同）",
          "- distribution：按维度分组统计/占比/结构（如按性别分布）",
          "- trend：时间序列/趋势变化",
          "- comparison：两组或多组对比",
          "- schema_help：问表结构/字段说明",
          "- out_of_scope：闲聊、常识、与业务库无关",
          "- unknown：无法判断",
          "判定要点：",
          "- 句末「是什么/叫什么/名称是什么/是多少」且前半有明确对象筛选 → 优先 attribute_lookup，不是 detail_list",
          "- 「并分析/生成报告」不改变查库意图，仍按查库部分判断",
          INTENT_FEW_SHOT,
          'schema: {"intent":"...","confidence":0-1,"reason":"简短中文"}',
        ].join("\n"),
      ],
      ["human", clipText(q, 900)],
    ]);
    const text = typeof (res as any)?.content === "string" ? (res as any).content : JSON.stringify((res as any)?.content);
    const parsed = IntentSchema.safeParse(safeJsonParse(text));
    if (!parsed.success) return null;
    return {
      intent: parsed.data.intent,
      confidence: parsed.data.confidence ?? 0.65,
      reason: String(parsed.data.reason ?? "llm"),
    };
  } catch {
    return null;
  }
}

/** 仅依据 QueryPlan 槽位做最弱 fallback（不读问句文本） */
export function inferIntentStructuralFromPlan(plan?: {
  intent?: string;
  dimensions?: string[];
  metrics?: string[];
} | null): { intent: DbQueryIntent; confidence: number; reason: string } | null {
  if (!plan) return null;
  const pi = String(plan.intent ?? "");
  if (pi === "schema_help") return { intent: "schema_help", confidence: 0.9, reason: "plan_schema" };
  if (pi === "out_of_scope") return { intent: "out_of_scope", confidence: 0.9, reason: "plan_oos" };
  if (pi === "trend") return { intent: "trend", confidence: 0.82, reason: "plan_trend" };
  if (pi === "comparison") return { intent: "comparison", confidence: 0.82, reason: "plan_comparison" };
  if (pi === "detail") return { intent: "detail_list", confidence: 0.78, reason: "plan_detail" };
  if (pi === "aggregation") {
    if ((plan.dimensions?.length ?? 0) > 0) {
      return { intent: "distribution", confidence: 0.76, reason: "plan_has_dimensions" };
    }
    if ((plan.metrics?.length ?? 0) > 0) {
      return { intent: "attribute_lookup", confidence: 0.68, reason: "plan_metric_no_dim" };
    }
    return { intent: "distribution", confidence: 0.55, reason: "plan_aggregation_fallback" };
  }
  return null;
}

export async function resolveQueryIntent(
  model: BaseLanguageModel | null,
  question: string,
  planFallback?: { intent?: string; dimensions?: string[]; metrics?: string[] } | null,
): Promise<{ intent: DbQueryIntent; source: "llm" | "structural" | "default"; reason: string }> {
  if (isDbQueryIntentLlmEnabled() && model) {
    const llm = await classifyIntentByLlm(model, question);
    if (llm && llm.confidence >= 0.52) {
      return { intent: llm.intent, source: "llm", reason: llm.reason };
    }
  }
  const structural = inferIntentStructuralFromPlan(planFallback);
  if (structural) {
    return { intent: structural.intent, source: "structural", reason: structural.reason };
  }
  return { intent: "unknown", source: "default", reason: "fallback" };
}
