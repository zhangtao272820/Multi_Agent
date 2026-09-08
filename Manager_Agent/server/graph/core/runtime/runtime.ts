import { resolveEffectiveLlmTier, resolveStageModel } from '../shared/modelTier'
import type { LlmInvokeOptions } from '../shared/modelTier'
import { withLlmRateLimitRetry } from '../../../utils/chat/llmRateLimit'
import {
  buildRouteThoughtHeartbeats,
  extractContentFromStreamChunk,
  extractReasoningFromStreamChunk,
  isManagerRouteThoughtStreamEnabled,
  sanitizeRouteThoughtForUser
} from '../../../utils/chat/routeThoughtStream'
import { readQwenEnableThinkingFromEnv } from '#agent-shared/qwenModelKwargs'

export function isManagerSynthStreamEnabled(): boolean {
  const v = String(process.env.MANAGER_SYNTH_STREAM ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

/** 将已生成正文按块回放为 delta（定稿/薄路径伪流；可见匀速，避免「整段蹦出」） */
export async function emitSynthStreamChunks(
  text: string,
  onDelta: (delta: string) => void,
  ensureNotAborted: () => void,
  chunkSize = 10
): Promise<void> {
  const s = String(text ?? '')
  if (!s) return
  const delayMs = 18
  for (let i = 0; i < s.length; i += chunkSize) {
    ensureNotAborted()
    onDelta(s.slice(i, i + chunkSize))
    if (i + chunkSize < s.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export type CreateManagerRuntimeDeps = {
  ensureNotAborted: () => void
  opts: {
    sendEvent: (event: { event: string; data?: any; from?: string }) => void
    openaiModel: string
    runId: string
  }
  getEffectivePlanSteps: (state: any) => any[]
  traceRun: <T>(name: string, fn: () => Promise<T>, extra?: Record<string, any>) => Promise<T>
  getModel: (
    modelName: string,
    temperature?: number,
    modelOpts?: { enableThinking?: boolean; honorEnvThinking?: boolean; skipThinking?: boolean }
  ) => {
    invoke: (messages: any[]) => Promise<any>
    stream?: (messages: any[]) => Promise<AsyncIterable<unknown>>
  }
  extractTotalTokens: (resp: any) => number | undefined
  estimateTokensFromMessages: (messages: any[]) => number
  estimateTokensFromText: (text: string) => number
  mergeResources: (state: any, patch: Record<string, any>) => Record<string, any>
  appendMetrics: (entry: { runId: string; phase: string; ms: number; tokens?: number; usd?: number; model?: string }) => Promise<void>
  mergeMeta: (state: any, patch: Record<string, any>) => Record<string, any>
}

export function createManagerRuntime(deps: CreateManagerRuntimeDeps) {
  const {
    ensureNotAborted,
    opts,
    getEffectivePlanSteps,
    traceRun,
    getModel,
    extractTotalTokens,
    estimateTokensFromMessages,
    estimateTokensFromText,
    mergeResources,
    appendMetrics,
    mergeMeta
  } = deps

  const isOverBudget = (resources: any) => {
    const bUsd = typeof resources?.budgetUsd === 'number' ? resources.budgetUsd : undefined
    const bTok = typeof resources?.budgetTokens === 'number' ? resources.budgetTokens : undefined
    const usedUsd = Number(resources?.usedUsd ?? 0) || 0
    const usedTokens = Number(resources?.usedTokens ?? 0) || 0
    if (typeof bUsd === 'number' && bUsd > 0 && usedUsd >= bUsd) return true
    if (typeof bTok === 'number' && bTok > 0 && usedTokens >= bTok) return true
    return false
  }

  const predictRemainingMs = (stage: string, state: any) => {
    const avg = {
      route: 2500,
      plan: 3000,
      db: 8000,
      rag: 6000,
      crawler: 15000,
      code: 5000,
      synth: 4000,
      critic: 3500
    }

    let ms = 0
    if (stage === 'route') ms += avg.route + avg.plan + avg.db + avg.synth + avg.critic
    else if (stage === 'plan') ms += avg.plan + avg.db + avg.synth + avg.critic
    else if (stage === 'synth') ms += avg.synth + avg.critic
    else if (stage === 'critic') ms += avg.critic

    const currentSteps = getEffectivePlanSteps(state as any)
    if (Array.isArray(currentSteps) && currentSteps.length > 0) {
      const agents = currentSteps.map((s: any) => s.agent)
      const execMs = agents.reduce((sum: number, a: string) => sum + (avg[a as keyof typeof avg] || 5000), 0)
      const parallelFactor = 0.6
      ms = execMs * parallelFactor + avg.synth + avg.critic
    }

    return ms
  }

  const timeLeftMs = (resources: any) => {
    const deadline = Number(resources?.deadlineAtMs ?? 0) || 0
    return deadline ? Math.max(0, deadline - Date.now()) : 0
  }

  const llmInvoke = async (
    stage: 'route' | 'plan' | 'synth' | 'critic' | 'verifier',
    state: any,
    messages: any[],
    invokeOptions?: LlmInvokeOptions
  ) => {
    ensureNotAborted()
    const resources = state?.resources
    if (!resources || typeof resources !== 'object') {
      throw new Error('llmInvoke: state.resources 缺失（请确认 resource_node 已执行且路由等节点未覆盖整个 state）')
    }
    const tLeft = timeLeftMs(resources)
    const estRemaining = predictRemainingMs(stage, state)
    const isTight = tLeft > 0 && tLeft < estRemaining * 1.2

    const lowCost = Boolean(state.meta?.lowCostMode) || isOverBudget(resources) || tLeft < 8000 || isTight
    if (isTight && !Boolean(state.meta?.lowCostMode)) {
      opts.sendEvent({ event: 'thinking', data: `资源预测：预计剩余耗时 ${Math.round(estRemaining)}ms，当前剩余 ${Math.round(tLeft)}ms，切换至 Fast Path (极速模式)`, from: 'manager' })
    }

    const effectiveTier = resolveEffectiveLlmTier(stage, state, invokeOptions?.tier)
    const { model: effectiveModel, autoLight } = resolveStageModel(stage, resources, {
      lowCost,
      tier: effectiveTier,
      state,
      openaiModel: opts.openaiModel
    })
    if (autoLight) {
      opts.sendEvent({
        event: 'thinking',
        data: `轻量任务：${stage} 使用 ${effectiveModel}`,
        from: 'manager'
      })
    } else if (!invokeOptions?.quiet && (effectiveTier === 'max' || effectiveTier === 'standard')) {
      if (stage === 'route' || stage === 'plan') {
        const tierTag = effectiveTier === 'max' ? '（max）' : '（plus）'
        const prefix = invokeOptions?.thinkingLabel?.trim() || `路由决策：${stage}`
        opts.sendEvent({
          event: 'thinking',
          data: `${prefix} 使用 ${effectiveModel}${tierTag}`,
          from: 'manager'
        })
        const label = invokeOptions?.thinkingLabel?.trim()
        const narrative =
          stage === 'plan'
            ? label || '正在制定执行计划…'
            : label
              ? `${label}：对照库存与任务形态选择能力组合…`
              : '正在理解你的问题并选择能力…'
        opts.sendEvent({
          event: 'thought_delta',
          data: { text: narrative, done: false },
          from: 'manager'
        })
      }
    }
    if (!effectiveModel) throw new Error('missing model for llmInvoke')
    if (stage !== 'route' && tLeft > 0 && tLeft < 3500) throw new Error('deadline approaching')
    const t0 = Date.now()
    const useRouteThoughtStream =
      (stage === 'route' || stage === 'plan') &&
      !invokeOptions?.quiet &&
      !Boolean(state.meta?.lowCostMode) &&
      isManagerRouteThoughtStreamEnabled() &&
      // 全局关思考时不推 reasoning 碎片，避免前端扁卡片墙
      readQwenEnableThinkingFromEnv()
    const model =
      stage === 'synth'
        ? getModel(effectiveModel, 0, { honorEnvThinking: true })
        : useRouteThoughtStream
          ? getModel(effectiveModel, 0, { enableThinking: true })
          : getModel(effectiveModel, 0, { skipThinking: true })
    const useStream =
      (stage === 'synth' && isManagerSynthStreamEnabled() && typeof invokeOptions?.onDelta === 'function') ||
      useRouteThoughtStream
    let outText = ''
    let resp: unknown = null

    const emitThoughtDelta = (text: string) => {
      const line = sanitizeRouteThoughtForUser(text)
      if (!line) return
      opts.sendEvent({
        event: 'thought_delta',
        data: { text: line, done: false },
        from: 'manager'
      })
    }

    if (useRouteThoughtStream && typeof (model as { stream?: (messages: unknown[]) => Promise<AsyncIterable<unknown>> }).stream === 'function') {
      const label = invokeOptions?.thinkingLabel?.trim() || (stage === 'plan' ? '制定执行计划' : '路由编排')
      const heartbeats = buildRouteThoughtHeartbeats(label)
      let heartbeatIdx = 0
      let lastActivityAt = Date.now()
      const heartbeatTimer = setInterval(() => {
        if (Date.now() - lastActivityAt < 3800) return
        emitThoughtDelta(heartbeats[heartbeatIdx++ % heartbeats.length]!)
        lastActivityAt = Date.now()
      }, 4200)
      try {
        await traceRun(
          `manager_llm_${stage}`,
          async () => {
            const stream = await withLlmRateLimitRetry(() =>
              (model as { stream: (messages: unknown[]) => Promise<AsyncIterable<unknown>> }).stream(messages)
            )
            for await (const chunk of stream) {
              ensureNotAborted()
              const reasoning = extractReasoningFromStreamChunk(chunk)
              if (reasoning) {
                emitThoughtDelta(reasoning)
                lastActivityAt = Date.now()
              }
              const content = extractContentFromStreamChunk(chunk)
              if (content) outText += content
            }
          },
          {
            stage,
            model: effectiveModel,
            forceIntent: state.forceIntent,
            intent: state.intent,
            routeConfidence: typeof state.meta?.routeConfidence === 'number' ? state.meta.routeConfidence : undefined,
            routeThoughtStream: true
          }
        )
      } finally {
        clearInterval(heartbeatTimer)
      }
    } else if (useStream && typeof (model as { stream?: (messages: unknown[]) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> }).stream === 'function') {
      const stream = await withLlmRateLimitRetry(async () => {
        const s = await (model as { stream: (messages: unknown[]) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> }).stream(messages)
        return s
      })
      for await (const chunk of stream) {
        ensureNotAborted()
        if (stage === 'synth') {
          const reasoning = extractReasoningFromStreamChunk(chunk)
          if (reasoning) emitThoughtDelta(reasoning)
        }
        const delta = extractContentFromStreamChunk(chunk)
        if (!delta) continue
        outText += delta
        invokeOptions!.onDelta!(delta)
      }
    } else {
      resp = await traceRun(
        `manager_llm_${stage}`,
        async () => await withLlmRateLimitRetry(() => model.invoke(messages)),
        {
          stage,
          model: effectiveModel,
          forceIntent: state.forceIntent,
          intent: state.intent,
          routeConfidence: typeof state.meta?.routeConfidence === 'number' ? state.meta.routeConfidence : undefined
        }
      )
      outText = String((resp as { content?: string })?.content ?? '')
      if (useStream && invokeOptions?.onDelta && outText) {
        await emitSynthStreamChunks(outText, invokeOptions.onDelta, ensureNotAborted)
      }
    }
    const usageTokens = resp ? extractTotalTokens(resp) : undefined
    const tokens = typeof usageTokens === 'number' && usageTokens > 0 ? usageTokens : estimateTokensFromMessages(messages) + estimateTokensFromText(outText)
    const usd = Number(resources.costPer1kTokensUsd ?? 0) ? (tokens / 1000) * Number(resources.costPer1kTokensUsd ?? 0) : 0
    const nextResources = mergeResources(state, {
      usedTokens: Number(resources.usedTokens ?? 0) + tokens,
      usedUsd: Number(resources.usedUsd ?? 0) + usd
    })
    await appendMetrics({
      runId: opts.runId,
      phase: `llm:${stage}`,
      ms: Date.now() - t0,
      tokens,
      usd,
      model: effectiveModel
    })
    const nextMeta = lowCost && !Boolean(state.meta?.lowCostMode) ? mergeMeta(state, { lowCostMode: true }) : state.meta
    return { text: outText, resources: nextResources, meta: nextMeta }
  }

  return { timeLeftMs, llmInvoke }
}
