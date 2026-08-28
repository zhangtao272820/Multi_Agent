import type { BaseMessage } from '@langchain/core/messages'
import { classifyTurnScopeByLlm, isTurnScopeLlmEnabled } from '../../llm/turnScopeLlm'
import { sessionIntentAnchorFromMeta } from '../../core/memory/multiTurnIntent'
import { ephemeralTurnMetaClearPatch } from '../../core/routing/ephemeralTurnMeta'
import type { LlmInvokeFn } from '../../llm/taskConstraintsLlm'

import type { CreateTurnScopeNodeDeps } from './types'


export function createTurnScopeNode(deps: CreateTurnScopeNodeDeps) {
  const { opts, lastUserText, llmInvoke, mergeMeta } = deps

  return async (state: any) => {
    opts.sendEvent({ event: 'phase', data: 'turn_scope', from: 'manager' })

    // 每轮先清上轮 ephemeral meta，避免记忆热路径/澄清标记污染新任务
    state = { ...state, meta: mergeMeta(state, ephemeralTurnMetaClearPatch()) }

    const lastUser = String(lastUserText(state.messages as BaseMessage[]) || '').trim()

    if (state.mediaAttachment?.filePath) {
      return {
        meta: mergeMeta(state, {
          turnScopeLlmMode: 'skipped_attachment' as const,
          turnScopeMode: 'current_only' as const
        })
      }
    }

    if (!isTurnScopeLlmEnabled() || state.meta?.lowCostMode) {
      return { meta: mergeMeta(state, { turnScopeLlmMode: 'off' as const }) }
    }

    const result = await classifyTurnScopeByLlm({
      messages: state.messages as BaseMessage[],
      lastUser,
      sessionAnchor: sessionIntentAnchorFromMeta(state.meta),
      attachment: state.mediaAttachment,
      llmInvoke,
      state
    })

    if (result && !state.meta?.lowCostMode) {
      opts.sendEvent({
        event: 'thinking',
        data: `轮次范围（LLM）：${result.mode} / ${result.turnKind}${result.directChitchatSynth ? ' → 直连对话' : ''}（${result.rationale.slice(0, 72)}）`,
        from: 'manager'
      })
    }

    return {
      meta: mergeMeta(state, {
        turnScopeLlm: result ?? undefined,
        turnScopeLlmMode: result ? ('llm' as const) : ('fallback' as const),
        turnScopeMode: result?.mode,
        turnKind: result?.turnKind,
        clarifyKind: result?.clarifyKind
      })
    }
  }
}

