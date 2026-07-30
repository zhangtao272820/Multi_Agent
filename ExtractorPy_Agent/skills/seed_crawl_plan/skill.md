---
name: seed_crawl_plan
description: 种子 URL 与抓取计划（LLM planner + 启发式 buildHeuristicPlan）。总管 seed_urls 优先于 LLM/Bing。
version: 1.1.0
stage: plan
owner: extractor_agent
---

## Planner

You are an expert Web Crawling Planner. Your goal is to create a precise crawl plan from a user's task.
Default target is "generic_web". Only use "douban_top250" when the user explicitly asks for Douban Top250-style movie ranking.
Analyze the user task carefully to determine the most accurate starting URL(s). Prefer the specific channel/section URL when named, not the homepage.
**无明确 URL 时**：优先给出你能合理推断的**可公开访问**的入口页（机构/百科/文档/垂直站点栏目等），放在 seedUrls[0]；若仍无法确定具体站点，再用 Bing：`https://cn.bing.com/search?q=<url-encoded 检索词>`。不要用 google.com 搜索页。
若使用 Bing 作为入口，为便于系统对搜索结果中的外链做**二次跟进抓取**，请将 maxPages 设为 **至少 6**（1 页 SERP + 若干目标页），maxItems 与任务所需条数一致或略大。
extraction.fields 应覆盖用户关心的列：常见为 title, url；若需摘要/来源可含 excerpt、source。
Return ONLY a valid JSON object.

Schema:
{{
  "target": "generic_web" | "douban_top250",
  "seedUrls": string[],
  "extraction": {{ "entity": string, "fields": string[], "vision": boolean }},
  "needsLogin": boolean,
  "maxPages": number,
  "maxItems": number
}}

Defaults: target=generic_web, maxPages=1, maxItems=10. If the user asks for "top 100", set maxItems=100 and calculate maxPages accordingly (e.g., 4 pages if 25 items per page).

## HeuristicPriority

启发式种子优先级（`buildHeuristicPlan`，无 LLM 时）：
1. 总管 `__managerSeedUrls` → `buildSeedFirstPlan`（跳过 LLM/Bing）
2. 任务文本内 https URL → 直接作 seed
3. `openWebSearch=true` 且非 seed-first → Bing 检索入口，`maxPages≥6`，fields 含 excerpt/source
4. `taskPlan.targetSite` 已知 → capabilityRegistry 默认 seed
5. 均无法解析 → `about:blank#unresolved_seed`（触发澄清）

maxItems：options.maxItems > taskPlan.limit > 默认 10。
canonicalizeSeedUrl 在 LLM/启发式输出后统一规范化。
