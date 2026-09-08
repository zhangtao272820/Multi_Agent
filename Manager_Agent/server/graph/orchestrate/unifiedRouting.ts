/**
 * 统一路由架构（Semantic Router + Plan-and-Execute / LLM-First）
 *
 * 图路径：turn_scope → probe → orchestrate（unifiedOrchestrate）→ prefetch → planner（蓝图材料化）→ exec
 * legacy decompose → intent_classify → route 在统一模式下旁路。
 */

import { CAPABILITY_REGISTRY, activeCapabilityRegistry } from '../core/agent/capabilities'
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
  if (isLlmFirstRouteEnabled()) {
    return String(turnScope.lastOnly || '').trim().slice(0, 1200)
  }
  // Phase3：非 LLM-First 续轮也硬截断，避免历史灌进编排窗口
  const raw = String(turnScope.routingContext || turnScope.lastOnly || '').trim()
  const cap = turnScope.mode === 'continuation' ? 800 : 1200
  return raw.slice(0, cap)
}

/** 附件 hint 注入编排 LLM */
export function formatAttachmentHintForOrchestrator(
  attachment?: {
    filePath?: string
    mediaType?: string
    caption?: string
    ocrSnippet?: string
  } | null,
  compositeMedia?: string[] | null
): string {
  if (!attachment?.filePath) return ''
  const mt = String(attachment.mediaType || 'unknown').trim()
  const media = compositeMedia?.length ? compositeMedia.join('+') : 'multimodal'
  const caption = String(attachment.caption || '').trim()
  const ocr = String(attachment.ocrSnippet || '').trim()
  const lines = [
    '【用户附件】已上传，须纳入 allowedAgents 与 planBlueprint：',
    `- 附件类型：${mt}`,
    `- 建议 Agent：${media}（识图/理解附件）；若用户还要求生成音乐/视频则含 music/video`,
    '- 图片/附件是问题描述的一部分：须先由 multimodal 理解，理解结果供下游 Agent 消费',
    '- 若本轮还要查库/文档/爬虫/日程等：intent=multi，planBlueprint 中 multimodal 为前序，下游 dependsOn multimodal',
    '- multimodal 负责理解附件；rag/db/crawler/admin 负责文本任务；勿把识图/OCR 写进 rag/db queryFocus'
  ]
  if (caption) {
    lines.push(`- 【画面摘要·已预读】${caption}`)
    lines.push('- 编排须据画面摘要决定下游 queryFocus（人名/实体/表意）；仍须 multimodal 前序除非仅需摘要即可')
  }
  if (ocr) {
    lines.push(`- 【画面文字片段】${ocr.slice(0, 80)}`)
  }
  return lines.join('\n')
}

/** Admin 结构化能力 vs Crawler：Admin/GUI/联网通道能力面固定，可点名工具；db/rag 勿绑业务域 */
export function formatAdminCrawlerDisambiguationPrompt(): string {
  return [
    '【Admin vs Crawler】（通道固定，与业务库/知识库领域无关）',
    adminTaskLlmToolCatalog(),
    '- **admin**（结构化 API/工具，未点公网时优先）：天气预报 get_weather；地铁/公交/从A到B/多久 get_travel_route；日程/会议/提醒；邮件；简报/晨报；会前准备；工作区文件；',
    '- 「查一下 + 天气/出行/日程」仍是 **admin**，≠ 联网抓网页；禁止再挂镜像 crawler 步；',
    '- **crawler**：清晰要公网网页正文/最新公开页/联网搜/爬取（webFetchKind≠none）→ crawler+needsWeb；主题即使是天气/政策，用户要公网则跟 crawler，**禁止**改绑 admin；',
    '- 联网搜索/链接精读/问数 **禁止**经 admin；浏览器登录填表 → **gui**。'
  ].join('\n')
}

/**
 * Align/Judge 用短版：不注入 Admin 工具目录（编排主路径已含完整边界）。
 * 避免二次 LLM 重复烧 catalog token。
 */
export function formatAdminCrawlerDisambiguationPromptCompact(): string {
  return [
    '【Admin vs Crawler】（通道固定）',
    '- **admin**：未点公网的天气/出行/日程/邮件等 API；',
    '- **crawler**：webFetchKind≠none 或 clear+crawler → 公网正文；禁止改绑 admin；',
    '- 「联网搜天气」→ crawler；「今天天气」未点公网 → admin。'
  ].join('\n')
}

/** Judge/Align 短边界：只列 id/purpose，不含工具目录 */
export function formatAgentBoundaryPromptCompact(): string {
  const caps = activeCapabilityRegistry().map((c) => `- **${c.id}**：${c.purpose}`).join('\n')
  return [
    '【Agent 边界·摘要】',
    caps,
    '- db/rag 对照 catalog；admin/gui/crawler 通道固定；',
    formatAdminCrawlerDisambiguationPromptCompact(),
    formatGuiCrawlerDisambiguationPrompt()
  ].join('\n')
}

/** GUI vs Crawler：交互通道固定 */
export function formatGuiCrawlerDisambiguationPrompt(): string {
  return [
    '【GUI vs Crawler】（通道固定）',
    '- **gui**：打开站点、站内搜索、点选/打开第 N 条、登录、填表、页内提取；needsWeb=false；禁 crawler；',
    '- 例：「去某站搜索并打开第一条」「打开页面点链接提取标题」→ gui；',
    '- **crawler**：无点击/登录/填表，只静态抓公网正文/列表字段；needsWeb=true；',
    '- 有 URL 仍要点选/跳转 → gui，禁因有 URL 改 crawler。'
  ].join('\n')
}

/** 注入编排/Planner LLM：Agent 职责边界（来自能力注册表，非正则判意图） */
export function formatAgentBoundaryPrompt(): string {
  const caps = activeCapabilityRegistry().map(
    (c) => `- **${c.id}**（${c.label}）：${c.purpose}`
  ).join('\n')
  return [
    '【Agent 边界】按末轮语义选 Agent 与蓝图；每 Agent 一事：',
    caps,
    '- **db/rag**（领域随 catalog 变）：结构化库 vs 私域文档；对照库存；命中≠默认查库；勿绑具体业务词',
    '- **admin/gui/crawler**（通道固定，可点名能力）：见下方 Admin/GUI 边界',
    formatAdminCrawlerDisambiguationPrompt(),
    formatGuiCrawlerDisambiguationPrompt(),
    '- multimodal=附件理解（可并列，附件时为前序）；music/video=媒体生成（若未在边界列出则本部署已禁用）',
    '- clean/code/visualize/report=加工链；单源查数可不要',
    '- queryFocus 写该步职责，禁复制整段原话；识图勿写入 rag/db 焦点'
  ].join('\n')
}

export function formatEvolutionHintPreamble(): string {
  return '【自进化 hint】以下为历史弱参考；若与用户末轮语义不一致，必须忽略，不得扩大 dataSources 或 suggestedAgents。'
}
