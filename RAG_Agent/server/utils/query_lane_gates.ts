/**
 * L2：检索车道门控（基于 plan/上下文的确定性规则，非用户原话关键词路由）。
 */
import type { RagQueryPlan } from "./query_plan";

export type LaneGateContext = {
  probeMode?: boolean;
  turboRetrieval?: boolean;
  fastPath?: boolean;
  hasExplicitDocAnchor?: boolean;
  /** 总管已注入 lean_query 且置信较高 */
  managerLeanQueryHighConfidence?: boolean;
  queryLen?: number;
  enableHyde?: boolean;
  enableMultiQuery?: boolean;
  enablePolicyGraph?: boolean;
};

export function decideUseHyde(plan: RagQueryPlan, ctx: LaneGateContext): boolean {
  if (!ctx.enableHyde) return false;
  if (ctx.probeMode || ctx.turboRetrieval || ctx.fastPath) return false;
  if (ctx.hasExplicitDocAnchor) return false;
  if (plan.use_hyde === true) return true;
  if (plan.use_hyde === false) return false;
  if (plan.entities.doc_names.length > 0) return false;
  if (plan.entities.numbers.length >= 2) return false;
  const qLen = ctx.queryLen ?? 0;
  if (qLen > 0 && qLen < 6) return false;
  const fuzzyIntent = plan.intent === "definition" || plan.intent === "unknown";
  const lowConf = plan.confidence > 0 && plan.confidence < 0.55;
  return fuzzyIntent && (lowConf || qLen > 0 && qLen <= 24);
}

export function decideUseMultiQuery(plan: RagQueryPlan, ctx: LaneGateContext): boolean {
  if (!ctx.enableMultiQuery) return false;
  if (ctx.probeMode || ctx.turboRetrieval) return false;
  if (ctx.hasExplicitDocAnchor) return false;
  if (ctx.managerLeanQueryHighConfidence && plan.confidence >= 0.7) return false;
  if (plan.use_multi_query === true) return true;
  if (plan.use_multi_query === false) return false;
  const qLen = ctx.queryLen ?? 0;
  if (qLen > 0 && qLen < 6) return false;
  if (plan.intent === "multi_part" || plan.intent === "comparison") return true;
  return plan.sub_queries.length >= 2;
}

export function decideNeedsGraph(plan: RagQueryPlan, ctx: LaneGateContext): boolean {
  if (!ctx.enablePolicyGraph) return false;
  // probe 省延迟：不开图。turbo/compound_fast 仍可开——图遍历是本地边表，非 LLM。
  if (ctx.probeMode) return false;
  if (plan.needs_graph === true) return true;
  // 结构规则优先于 LLM 的 needs_graph=false（模型常把关系复合问标成 false）
  if (plan.intent === "process") return true;
  if (plan.intent === "comparison" && plan.entities.topics.length >= 2) return true;
  if (plan.intent === "multi_part" && plan.entities.topics.length >= 2) return true;
  if (plan.intent === "multi_part" && plan.sub_queries.length >= 2) return true;
  if (plan.needs_graph === false) return false;
  return false;
}

export function applyLaneGatesToPlan(plan: RagQueryPlan, ctx: LaneGateContext): RagQueryPlan {
  return {
    ...plan,
    use_hyde: decideUseHyde(plan, ctx),
    use_multi_query: decideUseMultiQuery(plan, ctx),
    needs_graph: decideNeedsGraph(plan, ctx),
  };
}
