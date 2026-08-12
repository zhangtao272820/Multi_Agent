/**
 * DB turnScope smoke：主题切换隔离 + 指代承接（纯函数，无 API）。
 */
import { classifyDbTurnScopeStructural } from "../utils/nlu/dbTurnScope.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const history = [
  { role: "user", content: "查询张三的基本信息" },
  { role: "assistant", content: "张三，男，65岁……" },
];

const followup = classifyDbTurnScopeStructural("年龄呢", history);
assert(followup.mode === "continuation", `refer follow-up: ${followup.mode}`);
assert(followup.suppress_history === false, "continuation keeps history");

const shift = classifyDbTurnScopeStructural("李四的护理等级是多少", history);
assert(shift.suppress_history === true, "self-contained new query must suppress history");
assert(
  shift.mode === "topic_shift" || shift.mode === "current_only",
  `must isolate not continuation: ${shift.mode}`,
);
assert(shift.turn_kind === "new_task", "turn_kind new_task");

const alone = classifyDbTurnScopeStructural("查询张三的基本信息", []);
assert(alone.mode === "current_only", "no history → current_only");

console.log("smoke-db-turn-scope: OK", {
  followup: followup.mode,
  shift: shift.mode,
});
