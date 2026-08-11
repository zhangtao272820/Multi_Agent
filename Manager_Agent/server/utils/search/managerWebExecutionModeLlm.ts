/**
 * 网页任务执行模式启发器（LLM）：统一判定 GUI / 联网+crawler / SERP 摘要 / 直连抓取。
 * 供 Router 与 Planner 共用，避免关键词/正则硬匹配。
 */

import { z } from 'zod'
import { safeJsonParse } from '../../graph/core/shared/llmJson'
import type { LlmInvokeFn } from '../../graph/llm/taskConstraintsLlm'
import type { ExecutableAgent } from '../../graph/core/routing/routeFinalize'
import { routingDecisionLlmTier } from '../../graph/core/shared/modelTier'
import {
  formatGuiDeployHintForRouter,
  isGuiAgentRoutable,
  agentsForWebExecutionHeuristic
} from '../gui/managerGuiAgentAvailability'
import { createManagerChatOpenAI } from '../chat/managerChatOpenAI'

export const WebExecutionModeSchema = z.object({
  mode: z.enum(['gui', 'search_chat', 'search_then_crawl', 'search_serp_only', 'crawl_direct', 'not_web']),
  primaryAgent: z.enum(['gui', 'crawler']).nullable().optional(),
  needsWebSearch: z.boolean(),
  /** true=联网检索摘要即可；false=需全量页面/交互抽取 */
  serpSummaryEnough: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional()
})

export type WebExecutionModeDecision = z.infer<typeof WebExecutionModeSchema>

export function isWebExecutionModeLlmEnabled(): boolean {
  return String(process.env.MANAGER_WEB_EXECUTION_MODE_LLM ?? '1').trim() !== '0'
}

export function webExecutionModeFromMeta(meta: unknown): WebExecutionModeDecision | null {
  const raw = (meta as { webExecutionMode?: unknown } | null)?.webExecutionMode
  const parsed = WebExecutionModeSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** 供 Planner system 注入 */
export function formatWebExecutionModeForPrompt(mode: WebExecutionModeDecision | null | undefined): string {
  if (!mode) return ''
  const agent = mode.primaryAgent ?? (mode.mode === 'gui' ? 'gui' : mode.mode === 'not_web' ? '—' : 'crawler')
  return [
    '【网页执行模式（路由启发 LLM，Planner 须对齐）】',
    `mode=${mode.mode} primaryAgent=${agent}`,
    `needsWebSearch=${mode.needsWebSearch} serpSummaryEnough=${mode.serpSummaryEnough}`,
    mode.rationale ? `理由：${mode.rationale.slice(0, 240)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** 供 Router / smoke 复用的网页执行模式 System（契约文案） */
export function formatWebExecutionModeSystemPrompt(): string {
  return [
    '你是总管 Agent 的「网页任务执行模式」启发器。根据用户自然语言，判断应如何执行（非关键词表硬匹配）。',
    '只输出 JSON，禁止 markdown。',
    '',
    '模式说明（互斥，选最贴切的一种）：',
    '- gui：必须在真实浏览器里**操作页面**（打开站点、站内搜索、点击结果、点选第一个/第 N 条链接、登录、填表、选下拉、勾选、提交表单、滚动、截图、从当前 DOM 抽取）。典型：「打开某站搜索并提取第 N 条」「打开 URL 并点击第一个教程链接提取标题」「在表单填写并截图」「登录 OA」。**不需要**先走独立联网检索 API。',
    '- **打开 URL + 点击/点选链接/第 N 条 + 提取 → 必须 gui**；禁止因已给出 URL 就选 crawl_direct 或 search_then_crawl。',
    '- **填表/登录/提交/点同意必须用 gui**，禁止用 search_chat 用文字「教用户怎么填」。',
    '- **复合 db+公网参考**：用户先从数据库取记录，再检索公开参考区间/指南摘要并对照/report → **not_web 或 search_serp_only**，intent=multi，allowed 含 db+crawler(+report)，**禁止 gui**。',
    '- search_chat：一般资讯/知识问答、对比推荐、「有哪些/怎么选/是什么/怎么学」类聊天（像 DeepSeek）；联网检索摘要即可作答，**不要** crawler 全量抓取或 GUI。**勿**把「打开网址去填/点」判成 search_chat。',
    '- search_then_crawl：需先用联网检索发现 URL/背景，再**静态抓取/抽取**页面正文（无浏览器点击/点选）；**禁止**用于「打开站点并点选第 N 条/第一个链接」——此类必须用 gui。',
    '- search_serp_only：与 search_chat 类似，仅需 SERP 摘要（参考范围/政策要点/行情摘要等）。',
    '- crawl_direct：仅当对给定 URL **静态抓正文**且任务**不要求**站内点击/跳转/点选/登录填表；有 URL 仍要点击操作 → gui，不是 crawl_direct。',
    '- not_web：与公开网页无关（库内查数、知识库、办公、媒体生成等）。',
    '',
    '字段：',
    '- primaryAgent：gui 或 crawler；not_web 时为 null。',
    '- needsWebSearch：gui/crawl_direct 通常为 false；search_* 为 true。',
    '- serpSummaryEnough：仅 search_serp_only 为 true；gui/search_then_crawl/crawl_direct 为 false。',
    '',
    'schema: {"mode":"gui|search_chat|search_then_crawl|search_serp_only|crawl_direct|not_web","primaryAgent":"gui|crawler|null","needsWebSearch":boolean,"serpSummaryEnough":boolean,"confidence":number,"rationale":string}'
  ].join('\n')
}

function modeSystemPrompt(): string {
  return formatWebExecutionModeSystemPrompt()
}

function shouldInvokeWebMode(input: {
  userText: string
  allowedAgents: ExecutableAgent[]
  routeIntent?: string
  llmNeedsWebSearch?: boolean
  guiRoutable?: boolean
}): boolean {
  const q = String(input.userText ?? '').trim()
  if (q.length < 4) return false
  // 禁止仅因 gui=ready 就打网页模式 LLM（库内/知识库单步会空转耗 token）
  const agents = new Set(input.allowedAgents ?? [])
  const intent = String(input.routeIntent ?? '').trim()
  if (agents.has('gui') || agents.has('crawler')) return true
  if (intent === 'gui' || intent === 'crawler') return true
  if (input.llmNeedsWebSearch === true) return true
  if (q.includes('http://') || q.includes('https://')) return true
  // GUI 已部署且尚无明确非网页 cap 时，才为「打开/点击」类任务补判
  if (input.guiRoutable && agents.size === 0) return true
  return false
}

export async function resolveWebExecutionModeByLlm(input: {
  userText: string
  allowedAgents: ExecutableAgent[]
  routeIntent?: string
  llmNeedsWebSearch?: boolean
  toolHealth?: { agents?: Array<{ agent: string; status: string }> } | null
  llmInvoke?: LlmInvokeFn | null
  state?: unknown
  llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
}): Promise<WebExecutionModeDecision | null> {
  if (!isWebExecutionModeLlmEnabled()) return null

  const guiRoutable = isGuiAgentRoutable(input.toolHealth)
  const heuristicAllowed = agentsForWebExecutionHeuristic(input.allowedAgents, input.toolHealth)
  if (!shouldInvokeWebMode({ ...input, allowedAgents: heuristicAllowed, guiRoutable })) return null

  const q = String(input.userText ?? '').trim().slice(0, 1200)
  const allowed = heuristicAllowed.join(', ') || '（未限定）'
  const guiHint = formatGuiDeployHintForRouter(input.toolHealth)
  const human = [
    `【用户任务】\n${q}`,
    `【路由 intent】${String(input.routeIntent ?? '')}`,
    `【allowedAgents（含已部署 GUI）】${allowed}`,
    `【路由 LLM needsWebSearch】${input.llmNeedsWebSearch === true ? 'true' : 'false'}`,
    guiHint
  ].join('\n\n')

  try {
    if (input.llmInvoke && input.state) {
      const r = await input.llmInvoke('route', input.state, [
        ['system', modeSystemPrompt()],
        ['human', human]
      ], {
        tier: routingDecisionLlmTier(input.state),
        thinkingLabel: '网页执行：判定 GUI / 抓取 / SERP / 非网页'
      })
      const parsed = WebExecutionModeSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
      if (parsed.success && Number(parsed.data.confidence ?? 0) >= 0.5) return parsed.data
    }
    const key = String(input.llm?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim()
    if (!key) return null
    const model = createManagerChatOpenAI({
      apiKey: key,
      modelName: String(input.llm?.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: input.llm?.openaiBaseUrl || process.env.OPENAI_BASE_URL,
      temperature: 0,
      skipThinking: true
    })
    const res = await model.invoke([
      ['system', modeSystemPrompt()],
      ['human', human]
    ])
    const parsed = WebExecutionModeSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    return parsed.data
  } catch {
    return null
  }
}

/** 非网页执行类 Agent：web 模式启发不得剔除 */
const NON_WEB_PIPELINE_AGENTS = new Set<ExecutableAgent>([
  'db',
  'rag',
  'code',
  'admin',
  'clean',
  'visualize',
  'report',
  'multimodal',
  'music',
  'video'
])

function preserveNonWebAgents(allowed: ExecutableAgent[]): ExecutableAgent[] {
  return allowed.filter((a) => NON_WEB_PIPELINE_AGENTS.has(a))
}

function mergeWebAgents(base: ExecutableAgent[], web: ExecutableAgent[]): ExecutableAgent[] {
  return [...new Set([...preserveNonWebAgents(base), ...web])] as ExecutableAgent[]
}

function resolveIntentAfterWebMerge(intent: string, allowed: ExecutableAgent[]): string {
  const nonWeb = preserveNonWebAgents(allowed)
  const hasWeb = allowed.includes('crawler') || allowed.includes('gui')
  if (nonWeb.length >= 1 && hasWeb && allowed.length > 1) return 'multi'
  if (allowed.length === 1) return allowed[0]!
  return intent || 'multi'
}
/** 将启发结果落到 intent / allowedAgents / needsWebSearch */
export function applyWebExecutionModeToRoute(input: {
  intent: string
  allowedAgents: ExecutableAgent[]
  llmNeedsWebSearch?: boolean
  mode: WebExecutionModeDecision | null
  /** 库内+公网复合任务：禁止 gui 覆盖 */
  compositeDataWebRoute?: boolean
}): {
  intent: string
  allowedAgents: ExecutableAgent[]
  llmNeedsWebSearch: boolean
  webExecutionMode: WebExecutionModeDecision | null
} {
  let intent = String(input.intent ?? '').trim()
  let allowed = [...input.allowedAgents]
  let llmNeedsWebSearch = input.llmNeedsWebSearch === true
  const mode = input.mode
  const composite = input.compositeDataWebRoute === true

  if (!mode || mode.mode === 'not_web') {
    return { intent, allowedAgents: allowed, llmNeedsWebSearch, webExecutionMode: mode }
  }

  if (composite && mode.mode === 'gui') {
    const merged = mergeWebAgents(allowed, ['crawler'])
    return {
      intent: resolveIntentAfterWebMerge(intent, merged),
      allowedAgents: merged.filter((a) => a !== 'gui'),
      llmNeedsWebSearch: true,
      webExecutionMode: { ...mode, mode: 'search_serp_only', primaryAgent: 'crawler', needsWebSearch: true, serpSummaryEnough: true }
    }
  }

  if (mode.mode === 'gui') {
    const preserved = preserveNonWebAgents(allowed)
    if (preserved.length > 0) {
      return {
        intent: resolveIntentAfterWebMerge(intent, allowed),
        allowedAgents: allowed.filter((a) => a !== 'gui'),
        llmNeedsWebSearch,
        webExecutionMode: mode
      }
    }
    allowed = ['gui']
    intent = 'gui'
    llmNeedsWebSearch = false
    return { intent, allowedAgents: allowed, llmNeedsWebSearch, webExecutionMode: mode }
  }

  if (mode.mode === 'search_chat' || mode.mode === 'search_serp_only') {
    allowed = mergeWebAgents(allowed, ['crawler']).filter((a) => a !== 'gui')
    intent = resolveIntentAfterWebMerge(intent, allowed)
    llmNeedsWebSearch = true
    return {
      intent,
      allowedAgents: allowed,
      llmNeedsWebSearch,
      webExecutionMode: { ...mode, serpSummaryEnough: true }
    }
  }

  if (mode.mode === 'crawl_direct') {
    allowed = mergeWebAgents(allowed, ['crawler']).filter((a) => a !== 'gui')
    intent = resolveIntentAfterWebMerge(intent, allowed)
    llmNeedsWebSearch = false
    return { intent, allowedAgents: allowed, llmNeedsWebSearch, webExecutionMode: mode }
  }

  // search_then_crawl
  allowed = mergeWebAgents(allowed, ['crawler']).filter((a) => a !== 'gui')
  intent = resolveIntentAfterWebMerge(intent, allowed)
  llmNeedsWebSearch = mode.needsWebSearch === true
  return { intent, allowedAgents: allowed, llmNeedsWebSearch, webExecutionMode: mode }
}
