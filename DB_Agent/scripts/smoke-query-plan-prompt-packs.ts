/**
 * P5/P7：QueryPlan Base / DomainCore / DomainShape 组装 smoke（不拉 LLM）。
 */
import {
  assembleQueryPlanSystemPrompt,
  QUERY_PLAN_DOMAIN_MARKER,
  QUERY_PLAN_SHAPE_MARKER,
} from "../utils/nlu/prompts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const full = assembleQueryPlanSystemPrompt({
  withDomainHints: true,
  withDomainShapeHints: true,
  withBlueprintHints: false,
});
assert(/查询意图拆解器/.test(full), "base role present");
assert(full.includes(QUERY_PLAN_DOMAIN_MARKER), "full includes domain core marker");
assert(full.includes(QUERY_PLAN_SHAPE_MARKER), "full includes domain shape marker");
assert(full.includes("只输出 JSON"), "base format rules");
assert(full.includes("entities.names"), "domain entity rule");
assert(full.includes("逗号/顿号"), "shape comma rule");

const coreOnly = assembleQueryPlanSystemPrompt({
  withDomainHints: true,
  withDomainShapeHints: false,
  withBlueprintHints: false,
});
assert(coreOnly.includes(QUERY_PLAN_DOMAIN_MARKER), "core-only has core marker");
assert(!coreOnly.includes(QUERY_PLAN_SHAPE_MARKER), "core-only omits shape marker");
assert(!coreOnly.includes("逗号/顿号"), "core-only omits shape comma rule");
assert(coreOnly.includes("entities.names"), "core-only keeps entity rule");
assert(coreOnly.length < full.length, "core-only shorter than full");

const baseOnly = assembleQueryPlanSystemPrompt({
  withDomainHints: false,
  withDomainShapeHints: false,
  withBlueprintHints: false,
});
assert(!baseOnly.includes(QUERY_PLAN_DOMAIN_MARKER), "base-only omits domain marker");
assert(!baseOnly.includes(QUERY_PLAN_SHAPE_MARKER), "base-only omits shape marker");
assert(!baseOnly.includes("entities.names 必须填入"), "base-only omits domain entity rule");
assert(baseOnly.includes("只输出 JSON"), "base-only keeps format");
assert(baseOnly.length < coreOnly.length, "base-only shorter than core-only");

console.log("smoke-query-plan-prompt-packs: ok", {
  fullChars: full.length,
  coreChars: coreOnly.length,
  baseChars: baseOnly.length,
});
