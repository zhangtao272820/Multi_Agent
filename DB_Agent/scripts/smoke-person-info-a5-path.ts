/**
 * A5 域路径：龙奶奶基本信息/联系方式 → person_basic / person_info，不走 person_health。
 */
import { inferQueryPlanStructural } from "../utils/nlu/structural_query_plan";
import { inferDataDomainFromSchema, canUsePersonInfoSkill, canUsePersonHealthSkill } from "../utils/schema_domain_align";
import { applyPersonBasicPrimaryTableConstraint } from "../utils/schema_table_judge";
import { pickExecutionPath, buildContextKey } from "../utils/route/pickPath";
import type { SchemaPlanAlignment } from "../utils/route/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const q = "龙奶奶的基本信息和联系方式";
const plan = inferQueryPlanStructural(q);
assert(plan.data_domain === "person_basic", `structural domain person_basic, got ${plan.data_domain}`);
assert(plan.intent === "detail", `intent detail, got ${plan.intent}`);
assert(plan.subject === "person", `subject person, got ${plan.subject}`);
// 具名抽取依赖信号器；若未抽出姓名，仍须保持 person_basic
if ((plan.entities.names?.length ?? 0) === 0) {
  plan.entities.names = ["龙奶奶"];
}

const briefs = [
  { name: "person_info", comment: "人员基本信息" },
  { name: "person_health_records", comment: "健康体征" },
  { name: "person_emergency_contact", comment: "紧急联系人" },
];
const judgeIn = {
  ranked_tables: ["person_health_records", "person_info", "person_emergency_contact"],
  primary_tables: ["person_info", "person_health_records"],
  auxiliary_tables: ["person_emergency_contact"],
  reasoning: "mixed",
  sql_hint: "",
};
const judge = applyPersonBasicPrimaryTableConstraint(judgeIn, briefs, plan);
assert(judge.primary_tables.includes("person_info"), "primary has person_info");
assert(
  !judge.primary_tables.some((t) => /health/i.test(t)),
  `health demoted from primary: ${judge.primary_tables.join(",")}`,
);
assert(
  (judge.auxiliary_tables ?? []).some((t) => /health/i.test(t)),
  "health in auxiliary",
);

const alignment: SchemaPlanAlignment = {
  hasHealthTable: true,
  hasPersonMaster: true,
  hasHealthJoin: true,
  hasPersonHealthRecords: true,
  hasFootPressureTable: false,
  domainMismatch: false,
  causalTags: [],
  schemaConfidence: 0.85,
};
const domain = inferDataDomainFromSchema({ plan, alignment, tableJudge: judge });
assert(domain === "person_basic", `infer domain person_basic, got ${domain}`);

const planAligned = { ...plan, data_domain: domain };
assert(canUsePersonInfoSkill(alignment, planAligned, judge), "canUsePersonInfoSkill");
assert(!canUsePersonHealthSkill(alignment, planAligned, judge), "must not use person_health skill");

const ctx = buildContextKey(planAligned, alignment);
const picked = pickExecutionPath(planAligned, alignment, [], ctx, q, "L1", judge, {
  schemaFirst: true,
  domainSkills: true,
});
assert(picked.path === "person_info", `path person_info, got ${picked.path}`);

// 有姓名时常被抬到 L3/L5：schemaFirst 仍须 person_info，禁止 sql_direct
for (const tier of ["L3", "L5"] as const) {
  const pickedHi = pickExecutionPath(planAligned, alignment, [], ctx, q, tier, judge, {
    schemaFirst: true,
    domainSkills: true,
  });
  assert(
    pickedHi.path === "person_info",
    `tier ${tier} must stay person_info, got ${pickedHi.path} (${pickedHi.reasons.join(";")})`,
  );
}

console.log("smoke: person-info path a5 ok");
