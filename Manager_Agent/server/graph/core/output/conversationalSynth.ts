/**
 * 单源/薄编排：面向用户的对话式 Synth（Cursor / DeepSeek 风），替代直通专家 dump。
 */
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import {
  assembleSynthSystemPrompt,
  type SynthPromptAssembleInput,
} from '../../llm/synthPromptProfiles'
import type { ReplyTier } from './userFacingPayload'
import {
  collectUnifiedSources,
  formatCitationInventoryForSynth,
} from './userFacingPayload'
import { polishFinalPayload } from './replyPolish'
import { stripLatexMath } from '../text/scenarioAndFormat'
import type { LlmInvokeOptions } from '../shared/modelTier'

export type ConversationalSynthKind = 'rag' | 'db' | 'report' | 'multi_hint'

const FINAL_HINT: Record<ConversationalSynthKind, string> = {
  rag: '【最终指示】像 Cursor 文档助手：先给可用结论，再按需 ### 分段；末段 1～2 句自然拓展；禁止「暂未找到/查不到」。',
  db: '【最终指示】像 Cursor 数据助手：只写解读/对照/建议；完整查询结果表由系统追加，勿自建缩略表。严禁表名/字段原名/SQL，只许中文注释名。末段 1～2 句拓展；禁止「查数据库：」前缀。',
  report: '【最终指示】像 Cursor 分析报告：首段结论 → ### 关键发现 → 对照/表 → ### 建议 → 1～2 句拓展；禁止执行摘要与管线回显；禁止库表/字段原名。',
  multi_hint:
    '【最终指示】复杂多源任务：各源结论对照写清采信口径；分 ### 主题作答；末段 1～2 句拓展；DB 相关禁止表名/字段原名。',
}

const SOURCE_LABEL: Record<ConversationalSynthKind, string> = {
  rag: '【知识库专家原文·采信事实，禁止复述检索过程】',
  db: '【数据库查询结果·采信数字与中文列名，禁止复述 SQL/表名/字段原名/审计字段】',
  report: '【报告草稿·提炼为用户可读正文，勿整段粘贴附录】',
  multi_hint: '【专家输出摘要·采信事实，禁止 agent: 列表；DB 侧禁止表名/字段原名】',
}

export function buildConversationalSynthAssembleInput(input: {
  kind: ConversationalSynthKind
  hasDbResult?: boolean
  hasRagResult?: boolean
  hasGuiResult?: boolean
  chatWebReply?: boolean
  multiSourceSynth?: boolean
  canShowAuxOutputs?: boolean
  shouldShowCharts?: boolean
  codeAuthoritative?: boolean
  replyTier?: ReplyTier
}): SynthPromptAssembleInput {
  const tier =
    input.replyTier ??
    (input.multiSourceSynth || input.canShowAuxOutputs ? 'report' : 'standard')
  return {
    multiSourceSynth: Boolean(input.multiSourceSynth),
    canShowAuxOutputs: Boolean(input.canShowAuxOutputs),
    shouldShowCharts: Boolean(input.shouldShowCharts),
    adminSynthContext: false,
    codeAuthoritative: Boolean(input.codeAuthoritative),
    hasGuiResult: Boolean(input.hasGuiResult),
    hasDbResult: Boolean(input.hasDbResult),
    hasRagResult: Boolean(input.hasRagResult),
    chatWebReply: Boolean(input.chatWebReply),
    replyTier: tier,
  }
}

export async function invokeConversationalSynth(input: {
  kind: ConversationalSynthKind
  question: string
  sourceText: string
  assemble: SynthPromptAssembleInput
  evidence?: unknown[]
  meta?: Record<string, unknown>
  llmInvoke: (
    phase: string,
    state: unknown,
    messages: (SystemMessage | HumanMessage)[],
    opts?: LlmInvokeOptions
  ) => Promise<{ text?: string; resources?: unknown }>
  state: unknown
  tier?: 'standard' | 'max' | 'light'
  extraHumanBlocks?: string[]
  maxSourceChars?: number
}): Promise<{ body: string; resources?: unknown }> {
  const tier = input.tier ?? (input.assemble.replyTier === 'report' ? 'max' : 'standard')
  const citationSources = collectUnifiedSources({
    evidence: input.evidence,
    meta: input.meta,
    max: 12,
  })
  const citationInventory = formatCitationInventoryForSynth(citationSources)
  const synthSystemText = assembleSynthSystemPrompt(input.assemble)
  const source = String(input.sourceText || '').trim().slice(0, input.maxSourceChars ?? 6000)
  const r = await input.llmInvoke(
    'synth',
    input.state,
    [
      new SystemMessage(synthSystemText),
      new HumanMessage(
        [
          `用户任务：${input.question}`,
          source ? `${SOURCE_LABEL[input.kind]}\n${source}` : '',
          citationInventory,
          FINAL_HINT[input.kind],
          ...(input.extraHumanBlocks || []),
        ]
          .filter(Boolean)
          .join('\n\n')
      ),
    ],
    { tier }
  )
  const body = polishFinalPayload(stripLatexMath(String(r.text ?? '').trim()))
  return { body, resources: r.resources }
}
