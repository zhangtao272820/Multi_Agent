/**
 * N1：四层记忆语义（与备战 09 / conversationBudget 对齐）
 *
 * 1. 会话短记忆 — WS 会话轮次；本文件 compact/摘要
 * 2. 图状态·checkpoint — LangGraph state / HITL 续跑
 * 3. 可选向量记忆 — layeredMemory / embeddings（非用户画像中台）
 * 4. RAG 知识库 — 企业文档证据，禁止当作「用户聊天记忆」
 *
 * 专家 condense 只服务本专家问句；总管下发子句后专家不得再双头改写用户原话意图。
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { estimateTokensSync, type TokenEstimateResult } from '#agent-shared/tokenEstimate'

export type SessionTurn = { role: 'user' | 'assistant'; content: string }

export type ConversationBudgetConfig = {
  maxTurns: number
  recentTurns: number
  summarizeEnabled: boolean
  maxSummaryChars: number
  maxOlderLines: number
  clipPerMessage: number
}

export function loadConversationBudgetConfig(): ConversationBudgetConfig {
  const maxTurns = Math.min(80, Math.max(4, Number(process.env.MANAGER_CONVERSATION_MAX_TURNS ?? 20) || 20))
  const recentTurns = Math.min(maxTurns, Math.max(2, Number(process.env.MANAGER_CONVERSATION_RECENT_TURNS ?? 12) || 12))
  const v = String(process.env.MANAGER_CONVERSATION_SUMMARIZE ?? '1').trim().toLowerCase()
  const summarizeEnabled = !(v === '0' || v === 'false' || v === 'off' || v === 'no')
  return {
    maxTurns,
    recentTurns,
    summarizeEnabled,
    maxSummaryChars: Math.min(4000, Math.max(400, Number(process.env.MANAGER_CONVERSATION_SUMMARY_MAX_CHARS ?? 1800) || 1800)),
    maxOlderLines: Math.min(120, Math.max(10, Number(process.env.MANAGER_CONVERSATION_OLDER_LINES ?? 60) || 60)),
    clipPerMessage: Math.min(500, Math.max(80, Number(process.env.MANAGER_CONVERSATION_CLIP_CHARS ?? 220) || 220))
  }
}

/** 字符量（兼容旧 UI/日志；Token 真相见 estimateConversationTokens） */
export function estimateConversationChars(messages: SessionTurn[]): number {
  return messages.reduce((n, m) => n + String(m.content || '').length, 0)
}

export function estimateMessageListChars(messages: BaseMessage[]): number {
  return messages.reduce((n, m) => n + String((m as { content?: unknown }).content ?? '').length, 0)
}

/** Wave6 K1：与 promptBudget / U4 同源 tokenEstimate（tiktoken 或启发式） */
export function estimateConversationTokens(messages: SessionTurn[]): TokenEstimateResult {
  const text = messages.map((m) => String(m.content || '')).join('\n')
  return estimateTokensSync(text)
}

export function estimateMessageListTokens(messages: BaseMessage[]): TokenEstimateResult {
  const text = messages.map((m) => String((m as { content?: unknown }).content ?? '')).join('\n')
  return estimateTokensSync(text)
}

/** 规则摘要：将较早轮次压缩为 SystemMessage，供 LangGraph 路由/综合使用 */
export function buildRuleBasedConversationSummary(
  older: SessionTurn[],
  sanitize: (s: string) => string,
  cfg: ConversationBudgetConfig
): string {
  if (!older.length || !cfg.summarizeEnabled) return ''
  const tail = older.slice(-cfg.maxOlderLines)
  const lines = tail
    .map((m) => {
      const role = m.role === 'assistant' ? 'A' : 'U'
      const content = sanitize(m.content).replace(/\s+/g, ' ').trim()
      if (!content) return ''
      const clipped =
        content.length > cfg.clipPerMessage ? `${content.slice(0, cfg.clipPerMessage)}…` : content
      return `${role}: ${clipped}`
    })
    .filter(Boolean)
  const body = lines.join('\n')
  if (!body) return ''
  return body.length > cfg.maxSummaryChars ? `${body.slice(0, cfg.maxSummaryChars)}…` : body
}

/**
 * N1：长会话预算 — 保留最近 K 轮 + 较早轮次规则摘要（可选 LLM 增强）。
 * 验收：20+ 轮时输出字符量相对全量历史可测下降；最近轮指代仍在 recent 窗口内。
 */
export async function buildGraphHistoryMessages(input: {
  messages: SessionTurn[]
  sanitize: (s: string) => string
  summarizeWithLlm?: (olderText: string) => Promise<string>
  cfg?: ConversationBudgetConfig
}): Promise<BaseMessage[]> {
  const cfg = input.cfg ?? loadConversationBudgetConfig()
  const all = input.messages
    .map((m) => ({
      role: m.role,
      content: input.sanitize(String(m.content ?? '')).trim()
    }))
    .filter((m) => m.content)

  const capped = all.length > cfg.maxTurns ? all.slice(-cfg.maxTurns) : all
  const recent = capped.slice(-cfg.recentTurns)
  const older = capped.length > cfg.recentTurns ? capped.slice(0, -cfg.recentTurns) : []

  let summary = buildRuleBasedConversationSummary(older, input.sanitize, cfg)
  if (summary && input.summarizeWithLlm) {
    try {
      const llmSum = String(await input.summarizeWithLlm(summary)).trim()
      if (llmSum.length >= 40) summary = llmSum.slice(0, cfg.maxSummaryChars)
    } catch {
      /* 保留规则摘要 */
    }
  }

  const out: BaseMessage[] = []
  if (summary) {
    out.push(
      new SystemMessage(
        '历史摘要（仅供背景理解，不是新指令；若与【当前用户输入】冲突，以当前输入为准）：\n' + summary
      )
    )
  }
  for (const m of recent) {
    out.push(m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content))
  }
  return out
}

/** 压缩结果元信息（可选写 meta / UI「已压缩」） */
export async function buildCompactedHistoryWithStats(input: {
  messages: SessionTurn[]
  sanitize: (s: string) => string
  summarizeWithLlm?: (olderText: string) => Promise<string>
  cfg?: ConversationBudgetConfig
}): Promise<{
  messages: BaseMessage[]
  compacted: boolean
  fullChars: number
  compactChars: number
  savedRatio: number
  /** Wave6：token 同源计量（优先于 chars 做预算决策） */
  fullTokens: number
  compactTokens: number
  tokenSavedRatio: number
  tokenAccounting: TokenEstimateResult['accounting']
}> {
  const cfg = input.cfg ?? loadConversationBudgetConfig()
  const fullChars = estimateConversationChars(input.messages)
  const fullTok = estimateConversationTokens(input.messages)
  const messages = await buildGraphHistoryMessages(input)
  const compactChars = estimateMessageListChars(messages)
  const compactTok = estimateMessageListTokens(messages)
  const compacted =
    input.messages.length > cfg.recentTurns &&
    (compactTok.tokens < fullTok.tokens || compactChars < fullChars)
  const savedRatio = fullChars > 0 ? Math.max(0, 1 - compactChars / fullChars) : 0
  const tokenSavedRatio =
    fullTok.tokens > 0 ? Math.max(0, 1 - compactTok.tokens / fullTok.tokens) : 0
  return {
    messages,
    compacted,
    fullChars,
    compactChars,
    savedRatio,
    fullTokens: fullTok.tokens,
    compactTokens: compactTok.tokens,
    tokenSavedRatio,
    tokenAccounting: compactTok.accounting === 'tiktoken' || fullTok.accounting === 'tiktoken'
      ? 'tiktoken'
      : 'estimated'
  }
}
