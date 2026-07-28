/**
 * 总管协作 compute 路径：仅 LLM 推理，不触发仓库工具。
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { createCodeChatOpenAI } from './codeChatOpenAI'
import { buildComputeSystemPrompt, getComputeUserTail } from './code_playbook_prompts'
/** 总管已注入 facts/上下文时，跳过向量经验召回与学习写回 */
export function shouldSkipManagerComputeOverhead(plan: {
  fromManager: boolean
  upstreamFacts?: Array<unknown>
  upstreamContext?: string
}): boolean {
  return Boolean(
    plan.fromManager &&
      ((Array.isArray(plan.upstreamFacts) && plan.upstreamFacts.length > 0) ||
        String(plan.upstreamContext || '').trim().length > 0)
  )
}

function formatFactsJsonBlock(
  facts?: Array<{ key: string; value: unknown; source?: string; agent?: string }>
): string {
  if (!facts?.length) return ''
  return ['结构化事实 facts[]（须全部写入输出 JSON 的 facts 字段）：', JSON.stringify(facts, null, 2)].join(
    '\n'
  )
}

export async function runComputeChat(params: {
  apiKey: string
  baseURL: string
  model: string
  question: string
  upstreamContext?: string
  upstreamFacts?: Array<{ key: string; value: unknown; source?: string; agent?: string }>
  mustOutputs?: string[]
  experienceContext?: string
  inspectStrategyHint?: string
  sendDelta: (delta: string) => void
  sendEvent: (type: string, payload?: any) => void
}): Promise<{ text: string; ms: number; usage?: unknown }> {
  const started = Date.now()
  params.sendEvent('phase', { phase: 'compute' })

  const system = buildComputeSystemPrompt({
    mustOutputs: params.mustOutputs,
    experienceContext: params.experienceContext,
    inspectStrategyHint: params.inspectStrategyHint,
  })

  const userParts = [`任务：${params.question}`]
  const factsBlock = formatFactsJsonBlock(params.upstreamFacts)
  if (params.upstreamContext) {
    userParts.push('', '已知上下文：', params.upstreamContext)
  }
  if (factsBlock) {
    userParts.push('', factsBlock)
  }
  if (params.upstreamContext || factsBlock) {
    userParts.push('', getComputeUserTail())
  }

  const model = createCodeChatOpenAI({
    apiKey: params.apiKey,
    model: params.model,
    baseURL: params.baseURL,
    streaming: true,
  })

  let text = ''
  let llmUsage: unknown = null
  const stream = await model.stream([new SystemMessage(system), new HumanMessage(userParts.join('\n'))])
  for await (const chunk of stream) {
    const part =
      typeof chunk.content === 'string'
        ? chunk.content
        : Array.isArray(chunk.content)
          ? chunk.content
              .map((p: any) => (typeof p === 'string' ? p : String(p?.text ?? '')))
              .join('')
          : ''
    if (part) {
      text += part
      params.sendDelta(part)
    }
    const chunkUsage =
      (chunk as { usage_metadata?: unknown })?.usage_metadata ??
      (chunk as { response_metadata?: { tokenUsage?: unknown } })?.response_metadata?.tokenUsage ??
      null
    if (chunkUsage) llmUsage = chunkUsage
  }

  return { text: text.trim(), ms: Date.now() - started, usage: llmUsage }
}
