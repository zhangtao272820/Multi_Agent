/**
 * J/K 波离线契约：Agentic 工具面 + heavy parse 门控 + retrieval_mode 归一化。
 * 不依赖真实 LLM / MinerU 服务。
 */
import assert from "node:assert/strict";

async function main() {
  process.env.RAG_ENABLE_AGENTIC_TOOL_LOOP = "1";
  process.env.RAG_HEAVY_PARSE = "1";
  process.env.MINERU_API_URL = "http://127.0.0.1:8798";

  const { getRagAgentEnv } = await import("../server/utils/rag_agent_env");
  const env = getRagAgentEnv();
  assert.equal(env.enableAgenticToolLoop, true);
  assert.ok(env.agenticToolMaxRounds >= 1);
  assert.equal(env.enableHeavyParse, true);
  assert.ok(String(env.mineruApiUrl).includes("8798"));

  const { shouldAttemptHeavyParse } = await import("../server/utils/heavy_parse_client");
  assert.equal(shouldAttemptHeavyParse("手册.pdf"), true);
  assert.equal(shouldAttemptHeavyParse("表.xlsx"), false);
  assert.equal(shouldAttemptHeavyParse("notes.txt"), false);

  const {
    setRagChatRetrievalMode,
    isRagAgenticToolLoopActive,
    bumpRagAgenticToolRound,
    getRagAgenticToolRounds,
    resetRagAgenticToolRounds,
  } = await import("../server/utils/rag_agentic_mode");

  setRagChatRetrievalMode("pipeline");
  assert.equal(isRagAgenticToolLoopActive(), false);
  setRagChatRetrievalMode("agentic");
  assert.equal(isRagAgenticToolLoopActive(), true);
  resetRagAgenticToolRounds();
  assert.equal(bumpRagAgenticToolRound(), 1);
  assert.equal(bumpRagAgenticToolRound(), 2);
  assert.equal(getRagAgenticToolRounds(), 2);
  setRagChatRetrievalMode("pipeline");

  const { shouldUseDocumentRagPipeline } = await import("../server/utils/rag_retrieval_mode");
  assert.equal(
    shouldUseDocumentRagPipeline({
      intent: {
        specified_documents: [],
        missing_documents: [],
        is_chitchat: false,
        route_action: "document_query",
        is_completeness_query: false,
        has_explicit_doc_anchor: false,
        retrieve_first_ok: true,
        retrieval_mode: "pipeline",
      },
      isManagerOrchestrated: false,
      enableRetrieveFirstChat: true,
      hasDocuments: true,
    }),
    true
  );
  assert.equal(
    shouldUseDocumentRagPipeline({
      intent: {
        specified_documents: [],
        missing_documents: [],
        is_chitchat: false,
        route_action: "document_query",
        is_completeness_query: true,
        has_explicit_doc_anchor: false,
        retrieve_first_ok: false,
        retrieval_mode: "agentic",
      },
      isManagerOrchestrated: false,
      enableRetrieveFirstChat: true,
      hasDocuments: true,
    }),
    false
  );

  // 动态 import agent 会拉 LangChain；仅校验工具名列表契约文件存在
  const fs = await import("node:fs");
  const agentSrc = fs.readFileSync(new URL("../server/utils/agent.ts", import.meta.url), "utf8");
  for (const name of ["kb_catalog", "retrieve", "retrieve_scoped", "document_query", "document_list"]) {
    assert.ok(agentSrc.includes(`name: "${name}"`), `missing tool ${name}`);
  }
  assert.ok(agentSrc.includes('agent: "agent"') || agentSrc.includes("agent: \"agent\"") || agentSrc.includes("return \"agent\""));

  console.log("[smoke:agentic-jk] ok");
}

main().catch((e) => {
  console.error("[smoke:agentic-jk] FAIL", e);
  process.exit(1);
});
