/**
 * 统一路由架构（Semantic Router + Plan-and-Execute / LLM-First）
 *
 * 图路径：turn_scope → probe → orchestrate（unifiedOrchestrate）→ prefetch → planner（蓝图材料化）→ exec
 * legacy decompose → intent_classify → route 在统一模式下旁路。
 */

import { CAPABILITY_REGISTRY } from '../core/agent/capabilities'
import { adminTaskLlmToolCatalog } from '#agent-shared/adminCapabilities'
import { intentClassifyFromMeta } from '../llm/intentClassifyLlm'
import { resolveManagerInteractionMode } from '../../utils/platform/managerInteractionMode'

import { resolveManagerEnvBool } from '../../utils/platform/managerEnvModes'

export function unifiedRoutingEnvEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): boolean {
  return resolveManagerEnvBool('MANAGER_UNIFIED_ORCHESTRATOR', env as NodeJS.ProcessEnv)
}

/** @deprecated 使用 unifiedRoutingEnvEnabled */
export function isUnifiedOrchestratorEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): boolean {
  return unifiedRoutingEnvEnabled(env)
}

/** 当前 turn 是否已由统一编排器产出路由决策 */
export function isUnifiedRoutingActive(state?: { meta?: unknown } | null): boolean {
  if (!unifiedRoutingEnvEnabled()) return false
  const meta = (state?.meta ?? null) as {
    unifiedOrchestrator?: boolean
    useLegacyRoute?: boolean
    intentClassifyMode?: string
  } | null
  if (meta?.useLegacyRoute === true) return false
  return meta?.unifiedOrchestrator === true || meta?.intentClassifyMode === 'orchestrator'
}

/** legacy 三节点（decompose / intent_classify / route）是否应跳过 */
export function shouldSkipLegacyRoutingNodes(state?: { meta?: unknown } | null): boolean {
  if (!unifiedRoutingEnvEnabled()) return false
  const meta = (state?.meta ?? null) as { useLegacyRoute?: boolean } | null
  return meta?.useLegacyRoute !== true
}

/** Planner 是否跳过 planShortcuts / 单 Agent 规则计划 */
export function shouldSkipLegacyPlanShortcuts(state?: { meta?: unknown } | null): boolean {
  if (isLlmFirstRouteEnabled()) return isUnifiedRoutingActive(state)
  if (!isUnifiedRoutingActive(state)) return false
  const classify = intentClassifyFromMeta(state?.meta)
  // 专业模式：cap/蓝图已由 PU-Stack+编排决定，禁止 Planner 再压成 db_only 单步
  if (resolveManagerInteractionMode(state?.meta) === 'professional') {
    if (classify?.requiresAgentPipeline === true || classify?.isMulti === true) return true
    const draft = (state?.meta as Record<string, unknown> | undefined)?.stepDispatchDraft
    if (Array.isArray(draft) && draft.length >= 2) return true
    const capFloor = (state?.meta as Record<string, unknown> | undefined)?.orchestratorCapFloor
    if (Array.isArray(capFloor) && capFloor.length >= 2) return true
  }
  const shortcut = classify?.planShortcut
  if (shortcut === 'db_only' || shortcut === 'rag_only' || shortcut === 'admin_only' || shortcut === 'db_chart') {
    return false
  }
  if (classify?.requiresAgentPipeline !== true && classify?.isMulti !== true) {
    const ds = classify?.dataSources ?? []
    if (ds.length <= 1 && shortcut === 'none') return false
  }
  return true
}

/** LLM-First 单层路由（convergence 默认）：编排 LLM 一次决策，少 Judge/规则兜底 */
export function isLlmFirstRouteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_LLM_FIRST_ROUTE', env)
}

/** LLM-First 下是否在 orchestrate 前调用 PU-Stack LLM（默认关：probe 弱参考 + 单次编排 LLM） */
export function shouldRunPuStackLlmInOrchestrate(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isLlmFirstRouteEnabled(env)) return true
  return resolveManagerEnvBool('MANAGER_PU_STACK_LLM', env)
}

/** 统一编排下禁用 Planner 规则/模板兜底 */
export function shouldSkipPlanRuleFallback(state?: { meta?: unknown } | null): boolean {
  if (!isUnifiedRoutingActive(state)) return false
  if (isLlmFirstRouteEnabled()) return true
  return resolveManagerInteractionMode(state?.meta) === 'professional'
}

/** 编排 LLM 的路由上下文：LLM-First 仅以末轮为权威，历史不得扩写 data-plane */
export function resolveOrchestratorRoutingContext(turnScope: {
  lastOnly: string
  routingContext: string
  mode: string
}): string {
  if (isLlmFirstRouteEnabled()) return String(turnScope.lastOnly || '').trim()
  return String(turnScope.routingContext || turnScope.lastOnly || '').trim()
}

/** 附件 hint 注入编排 LLM */
export function formatAttachmentHintForOrchestrator(
  attachment?: { filePath?: string; mediaType?: string } | null,
  compositeMedia?: string[] | null
): string {
  if (!attachment?.filePath) return ''
  const mt = String(attachment.mediaType || 'unknown').trim()
  const media = compositeMedia?.length ? compositeMedia.join('+') : 'multimodal'
  return [
    '【用户附件】已上传，须纳入 allowedAgents 与 planBlueprint：',
    `- 附件类型：${mt}`,
    `- 建议 Agent：${media}（识图/理解附件）；若用户还要求生成音乐/视频则含 music/video`,
    '- 图片/附件是问题描述的一部分：须先由 multimodal 理解，理解结果供下游 Agent 消费',
    '- 若本轮还要查库/文档/爬虫/日程等：intent=multi，planBlueprint 中 multimodal 为前序，下游 dependsOn multimodal',
    '- multimodal 负责理解附件；rag/db/crawler/admin 负责文本任务；勿把识图/OCR 写进 rag/db queryFocus'
  ].join('\n')
}

/** Admin 结构化能力 vs Crawler 公网抓取（注入编排/审查 LLM，非正则路由） */
export function formatAdminCrawlerDisambiguationPrompt(): string {
  return [
    '【Admin 结构化能力 vs Crawler 公网抓取】',
    adminTaskLlmToolCatalog(),
    '- **天气预报/气温/湿度/穿衣/今日天气** → **admin**（get_weather 真实 API），**禁止** crawler/gui/needsWeb；',
    '- **地图路线/多久到/从A到B/周边POI/地铁公交耗时** → **admin**（高德 get_travel_route 等），**禁止** crawler/needsWeb；',
    '- **简报/晨报/周报/今日安排** → **admin**（daily_briefing / weekly_report），**禁止** crawler/gui；',
    '- **会前准备/会议材料/纪要提取待办** → **admin**（prepare_meeting / extract_meeting_actions），**禁止** crawler/gui；',
    '- **工作区文件读写/列目录** → **admin**（list_files / read_file_content / write_file 等），**禁止** crawler/gui；',
    '- 「查一下/帮我查 + 地铁/公交/从A到B/多久」仍是 **admin 高德**，≠ 联网抓网页；禁止再挂一条 crawler 镜像步骤；',
    '- **crawler** 仅当用户要公网**网页正文**（最新政策通知、民政部公告、官网新闻、列表页字段）；',
    '- 「查天气」≠「联网检索」；复合任务中天气子句须 clauses+planBlueprint 独立 admin 一步；',
    '- 用户说「网上查天气」仍走 admin（结构化预报），除非明确要求爬取某天气网站页面正文；',
    '- 联网搜索/链接精读/问数 **禁止** 经 admin；浏览器登录填表仍走 **gui**。'
  ].join('\n')
}

/** GUI 浏览器交互 vs Crawler 静态抓取（注入编排/审查 LLM，非正则路由） */
export function formatGuiCrawlerDisambiguationPrompt(): string {
  return [
    '【GUI 浏览器交互 vs Crawler 静态抓取】',
    '- **gui**：须在真实浏览器里操作页面——打开站点、站内搜索、点选/打开第 N 条或第一个链接、登录、填表、页内提取标题/正文；allowedAgents=[gui]，needsWeb=false，**禁止** crawler/needsWeb/web_search；',
    '- 例：「打开某站并点击第一个教程链接提取标题」「去百度搜索并打开第一条」→ **gui**；',
    '- **crawler**：无浏览器点击/登录/填表，仅静态抓取公网正文/政策公告/列表字段；needsWeb=true，**禁止** gui；',
    '- 用户已给出 URL **不等于** crawl_direct：若任务仍要求站内点击/跳转/点选，必须 **gui**，禁止因有 URL 改道 crawler。'
  ].join('\n')
}

/** 注入编排/Planner LLM：Agent 职责边界（来自能力注册表，非正则判意图） */
export function formatAgentBoundaryPrompt(): string {
  const caps = CAPABILITY_REGISTRY.map(
    (c) => `- **${c.id}**（${c.label}）：${c.purpose}；适用：${c.preferredFor.join('、')}`
  ).join('\n')
  return [
    '【Agent 职责边界】你是 Semantic Router：根据用户末轮语义选择 Agent 集合与执行蓝图；每个 Agent 只做一件事：',
    caps,
    '- **db**：结构化业务库/SQL/记录/统计；**rag**：内部文档/制度/知识库；二者不可混用',
    '- **crawler**：公网网页正文/政策公告；**rag**：私有文档；用户要「网上查最新政策/通知原文」才加 crawler',
    formatAdminCrawlerDisambiguationPrompt(),
    formatGuiCrawlerDisambiguationPrompt(),
    '- **multimodal**：理解用户上传的图片/附件（核心子 Agent）；有附件且还需其他 Agent 时 multimodal 须为前序，下游 dependsOn 它',
    '- **music/video**：基于附件或描述生成媒体（extended）',
    '- **gui**：浏览器页面交互与页内提取（打开/搜索/点选/登录填表/截图；extended）',
    '- **clean/code/visualize/report**：多源对比、出图、写报告时的加工链；单源查数可不要',
    '- planBlueprint 每步 queryFocus 须写「该 Agent 要做什么」，禁止复制整段用户原话；勿把识图写进 rag/db queryFocus',
    '- Probe/经验/读题 hint 仅供参考；与用户末轮冲突时必须以末轮为准'
  ].join('\n')
}

export function formatEvolutionHintPreamble(): string {
  return '【自进化 hint】以下为历史弱参考；若与用户末轮语义不一致，必须忽略，不得扩大 dataSources 或 suggestedAgents。'
}
