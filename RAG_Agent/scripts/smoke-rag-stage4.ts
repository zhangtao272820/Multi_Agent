/**
 * RAG Stage-4 smoke：多轮合并 + 会话锚点 + 主题切换隔离（纯函数，无 API）。
 * messages 契约对齐生产：不含本轮；lastUser = 本轮原话。
 */
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  allowRagMultiTurnMerge,
  anchorBoostForRagRecall,
  buildRagMultiTurnQueryText,
  buildRagSessionRetrievalAnchor,
  previousHumanForMerge,
  shouldRunRagMultiTurnMerge,
} from "../server/utils/rag_multi_turn.ts";
import { classifyRagTurnScopeStructural } from "../server/utils/ragTurnScope.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function parseMergedUnderstandForTest(raw: {
  coalesced?: string;
  retrieval_keywords?: string[];
}) {
  return {
    coalesced: String(raw.coalesced ?? "").trim() || undefined,
    retrievalKeywords: (raw.retrieval_keywords || []).map(String).filter(Boolean),
  };
}

// —— 指代承接：生产契约 history 不含本轮 ——
const historyFollowup = [
  new HumanMessage("2023年销售提成政策的主要内容是什么"),
  new AIMessage("提成政策要点……"),
];
const lastFollowup = "那退货政策呢";

assert(
  previousHumanForMerge(historyFollowup, lastFollowup) === "2023年销售提成政策的主要内容是什么",
  "prev should be prior human when current not in messages",
);
assert(shouldRunRagMultiTurnMerge(historyFollowup, lastFollowup), "referential follow-up should trigger multi-turn");
assert(
  allowRagMultiTurnMerge({
    messages: historyFollowup,
    lastUser: lastFollowup,
    turnKind: "continuation",
  }),
  "turnKind continuation allows merge",
);

const ragQ = buildRagMultiTurnQueryText({
  messages: historyFollowup,
  lastUser: lastFollowup,
  sessionAnchor: buildRagSessionRetrievalAnchor({
    coalescedTask: "2023年销售提成政策",
    lastIntent: "document_query",
    topics: ["销售提成"],
  }),
  turnKind: "continuation",
});
assert(ragQ.multiTurn, "buildRagMultiTurnQueryText multiTurn");
assert(ragQ.query.includes("退货") || ragQ.query.includes("提成"), "query should include context or last");
assert(!ragQ.query.includes("提成政策要点"), "must not dump assistant answer into retrieval query");

// 兼容：messages 含本轮时 prev 仍应对齐
const legacyMsgs = [
  new HumanMessage("2023年销售提成政策的主要内容是什么"),
  new HumanMessage("那退货政策呢"),
];
assert(shouldRunRagMultiTurnMerge(legacyMsgs, "那退货政策呢"), "legacy messages-with-current still works");

const parsed = parseMergedUnderstandForTest({
  coalesced: "2023年退货政策的主要内容是什么",
  retrieval_keywords: ["退货政策", "2023年"],
});
assert(parsed.coalesced?.includes("退货"), "parseMergedUnderstandForTest");

const boost = anchorBoostForRagRecall(
  { intent: "fact_lookup" },
  buildRagSessionRetrievalAnchor({ lastIntent: "fact_lookup", topics: ["政策"] }),
);
assert(boost > 0, "anchor boost when intent aligned");

// —— 截图根因：配比 → 口腔护理（自洽新问不得粘旧主题）——
const historyRatio = [
  new HumanMessage("养老机构护理人员配比有什么要求？"),
  new AIMessage("护理型床位配比不低于1:4……"),
];
const oralCare = "不能自理的老年人口腔护理频次是多少？";

assert(
  !shouldRunRagMultiTurnMerge(historyRatio, oralCare),
  "self-contained new topic must NOT trigger structural multi-turn",
);

const scope = classifyRagTurnScopeStructural(oralCare, [
  { role: "user", content: "养老机构护理人员配比有什么要求？" },
  { role: "assistant", content: "护理型床位配比不低于1:4" },
]);
assert(scope.suppress_history === true, "oral care after ratio → suppress history");
assert(scope.mode === "topic_shift" || scope.mode === "current_only", "must isolate, not continuation");
assert(scope.turn_kind === "new_task", "turn_kind new_task");

const emptyHist = classifyRagTurnScopeStructural("口腔护理频次是多少", []);
assert(emptyHist.mode === "current_only", "no history → current_only without LLM");

const sticky = buildRagMultiTurnQueryText({
  messages: historyRatio,
  lastUser: oralCare,
  sessionAnchor: buildRagSessionRetrievalAnchor({
    coalescedTask: "养老机构护理人员配比要求",
    lastIntent: "document_query",
    topics: ["配比", "护理员"],
  }),
  turnKind: "new_task",
  suppressAnchor: true,
});
assert(sticky.multiTurn === false, "topic_shift/new_task must not multi-turn");
assert(sticky.query === oralCare, "effective query must stay raw last user");
assert(!sticky.query.includes("配比"), "must not stick previous staffing topic");

assert(
  !allowRagMultiTurnMerge({
    messages: historyRatio,
    lastUser: oralCare,
    turnKind: "new_task",
  }),
  "new_task forbids merge even if history present",
);

// 仅有锚点、无指代、无 continuation turnKind → 仍不得拼接
const staleAnchorOnly = buildRagMultiTurnQueryText({
  messages: historyRatio,
  lastUser: oralCare,
  sessionAnchor: buildRagSessionRetrievalAnchor({
    coalescedTask: "养老机构护理人员配比要求",
    topics: ["配比"],
  }),
});
assert(staleAnchorOnly.multiTurn === false, "stale anchor alone must not force multi-turn");
assert(staleAnchorOnly.query === oralCare, "stale anchor must not rewrite query");

console.log("smoke-rag-stage4: OK", {
  followupMultiTurn: ragQ.multiTurn,
  followupQueryLen: ragQ.query.length,
  oralIsolated: sticky.query,
  boost,
});
