import { routingConversationContext } from '../../core/text'

import type { CreateMetacogNodeDeps } from './types'

export function createMetacogNode(deps: CreateMetacogNodeDeps) {
  const { opts, lastUserText, isCapabilityOutOfScope, mergeMeta } = deps
  return async (state: any) => {
    opts.sendEvent({ event: 'phase', data: 'metacog', from: 'manager' })
    const question = routingConversationContext(state.messages as any)
    const out = isCapabilityOutOfScope(question)
    if (out.out) {
      const meta = mergeMeta(state, {
        capabilityOk: false,
        boundaryReason: out.reason,
        routeConfidence: 0.3,
        finalConfidence: 0.3,
        uncertainty: 'high',
        needsClarify: true,
        clarifyQuestions: ['请确认你希望我只提供信息/建议，还是由你人工执行相关操作？']
      })
      return {
        meta,
        final: `该请求超出当前总管 Agent 的安全能力边界：${out.reason}\n\n我可以继续做两件事：\n- 给出操作步骤/风险点/需要准备的材料\n- 帮你整理需要人工执行的清单\n\n请回复你希望我做哪一种。`
      }
    }
    // 勿写 routeConfidence:0 —— 会盖住后续编排置信，且 finalize 把 0 当合法值，学习信号永久记成 0
    return { meta: mergeMeta(state, { uncertainty: 'medium' }) }
  }
}
