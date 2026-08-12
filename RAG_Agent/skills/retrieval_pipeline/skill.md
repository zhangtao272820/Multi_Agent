---
name: retrieval_pipeline
description: RAG 文档检索流水线规范：query plan → expansion → hybrid 召回 → rerank → evidence 选择。用于 document_retrieval.ts 各 LLM 阶段。
version: 1.0.0
stage: retrieval
owner: rag_agent
---

# 检索流水线

动态上下文（用户问句、候选片段、路由结果、偏好块）由运行时注入，不在本文重复。

## Pipeline

稳定阶段顺序（代码实现见 `document_retrieval.ts`；H 波企业化见 `doc/企业化升级方案.md`）：

1. **Query Plan**：`buildRagQueryPlan` → intent / sub_queries / 实体词
2. **Condense**（可选）：多轮指代消解 → 自包含检索问句
3. **Expansion**（可选）：LLM 生成多检索词，提高召回
4. **Doc Routing**：`selectCandidateSources` 选定文档范围
5. **Hybrid Recall**：向量 + keyword + BM25 融合；复合问句可走 sub-query 并行 lane
6. **Pre-Rerank**：lexical / cross-encoder / local rerank（Bandit 可选跳过 LLM rerank）
7. **Rerank**：LLM 从候选池选 Top-N 片段
8. **MMR**（可选，H3）：相关性 vs 多样性去冗余
9. **Parent Expand**（H2）：子块命中 → `parent_text` 扩展并按 `parent_id` 去重
10. **Evidence Select**：LLM 输出严格 JSON evidence 列表
11. **Agentic Retry**（可选，H4）：零命中 / 弱证据 / `ambiguous_low_confidence` 时改写 query 重试

弱证据 / 零命中 / 分差过低且分数偏低 → clarify，不编造。  
生成侧另有 **Citation Guard（H5）**：答案中的数字/条款须能在证据原文中核对。

## J 波 Agentic 工具环（chat 复杂问句）

当 `retrieval_mode=agentic` 时，不走 retrieve-first，进入 LangGraph：
`kb_catalog` → `retrieve` / `retrieve_scoped` 有界多跳（`RAG_AGENTIC_TOOL_MAX_ROUNDS`），再 generate。
简单事实仍用上表 pipeline。总管一次调用 ≠ Agentic（闭环在专家内）。

## Expansion

你是一个检索专家。请根据用户的原始问题，生成 3 个不同侧重点或表述方式的检索词（可以是中文或英文），以提高检索召回率。
请直接输出 3 个检索词，每行一个，不要包含序号或解释。

## Rerank

规则：只选能直接回答问句主题的片段；复合/对比/列全类问题应覆盖各子主题，勿只选同一来源；勿选明显属于其它主题文档的条款。

## Evidence

你是「证据选择器」。请从给定候选片段中，选择最能回答用户问题的证据，并输出严格 JSON。
{ "evidence": [ { "content": "...", "source": "..." } ] }
只输出 JSON。evidence 必须是原文摘录；列全/复合问句应尽量覆盖各子主题。
禁止选用与问句主题明显无关的来源或条款。
若候选片段能直接回答问句中的任一主题/字段，必须选出对应 evidence，不得返回空数组。
仅当全部候选与问句主题完全无关时，才返回 evidence: []。
