/**
 * Classic StepDecide：每步 LLM+Zod 决策（P3-L1）
 * deriveGoalsFromTask / 用户原话 regex 不得作主裁判。
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { createQwenChatModel } from './lobster/model'
import type { AgentConfig } from './lobster/types'
import {
  ClassicStepDecideSchema,
  classicStepDecideMinConfidence,
  isClassicStepDecideEnabled,
} from './classicStepDecideSchema'
import {
  gateStepByResultPage,
  gateDoneByEnterDetail,
  maybeLeanExtractShortcut,
  maybeLeanOpenDoneShortcut,
  toIntentCall,
} from './classicStepDecidePure'
import type { StepDecideObservation, StepDecideTaskSpec } from './classicStepDecideTypes'
import { isResultListUrl } from './lobsterAgent/leanBrowsePolicy'
import { stageAllowsIntent, type PageStage } from './adapters/pageStages'

export type { StepDecideObservation, StepDecideTaskSpec }
export {
  gateStepByResultPage,
  gateDoneByEnterDetail,
  maybeLeanExtractShortcut,
  maybeLeanOpenDoneShortcut,
  toIntentCall,
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const s = String(text || '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1))
          return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const STEP_DECIDE_SYSTEM = [
  '你是 Lobster classic 的逐步决策器（StepDecide）。根据任务契约与当前页面观察，决定下一步唯一 Intent。',
  '只输出一个 JSON 对象，不要 Markdown。',
  '',
  '字段：',
  '{"intent":"...","args":{},"reason":"...","expect":{"urlIncludes":[],"stageHint":"list"},"confidence":0.0-1.0}',
  '',
  '允许的 intent：goto, search, open_first_result, click_candidate, type_into, scroll, wait, paginate_next, extract_items, perform, play, like, coin, follow, favorite, click_by_bbox, click_by_text, dismiss_overlays, reload, back, need_crawl, done',
  '',
  '规则：',
  '- 任务含 mustSearch 且未进入搜索结果页（URL 无 /s? 或 wd=/q=/search）时，禁止 open_first_result / extract_items（应先 search 或 goto 直达结果页）。',
  '- 站点首页浏览（无 mustSearch，如打开教程站首页再点第一个教程）：允许 open_first_result / click_candidate；禁止把首页当成详情 done。',
  '- 已在结果列表且任务要抽第一条：优先 extract_items；要打开第一条：open_first_result（点结果区链接，勿点频道导航）。',
  '- 已进入非搜索列表的详情页（如文章/教程内页，URL 已离开任务起始页）且任务是打开第一条并取标题链接：必须立刻 done，禁止 wait / back / 再 search。',
  '- 仍在任务起始页（仅打开首页）时禁止 done；须先 open_first_result / click_candidate 进入教程/详情。',
  '- click_candidate / type_into 必须用 candidates 里的 cid。',
  '- confidence < 0.5 表示看不清，系统会 recover，不要瞎猜。',
  '- 已完成目标（已进详情且标题/内容可得）则 done。',
].join('\n')

export async function classicStepDecide(input: {
  task: string
  taskSpec: StepDecideTaskSpec
  observation: StepDecideObservation
  config: AgentConfig
  signal?: AbortSignal
}) {
  if (!isClassicStepDecideEnabled()) return null

  const startUrl = String(input.taskSpec.startUrl || '').trim() || undefined
  const openDone = maybeLeanOpenDoneShortcut({
    observation: input.observation,
    task: input.task,
    goals: input.taskSpec.goals,
    startUrl,
  })
  if (openDone) return gateDoneByEnterDetail(openDone, input.observation, input.taskSpec.goals, startUrl)

  const lean = maybeLeanExtractShortcut({
    observation: input.observation,
    goals: input.taskSpec.goals,
  })
  if (lean) return lean

  const llm = createQwenChatModel(input.config, 'decision')
  if (!llm) return null

  const goals = input.taskSpec.goals || {}
  const allowed = Array.isArray(input.taskSpec.allowedIntents) ? input.taskSpec.allowedIntents : []
  const forbidden = Array.isArray(input.taskSpec.forbiddenIntents) ? input.taskSpec.forbiddenIntents : []
  const stageHint = String(input.observation.stageHint || 'unknown') as PageStage

  const userPayload = {
    task: input.task,
    goals,
    successCriteria: input.taskSpec.successCriteria || input.taskSpec.summary?.successCriteria || {},
    completionCriteria: input.taskSpec.completionCriteria || {},
    allowedIntents: allowed,
    forbiddenIntents: forbidden,
    intentsOrder: input.taskSpec.intentsOrder || [],
    observation: {
      url: input.observation.url,
      title: input.observation.title,
      stageHint,
      onResultList: isResultListUrl(input.observation.url),
      lastAction: input.observation.lastAction || '',
      lastError: input.observation.lastError || '',
      pageTextSnippet: String(input.observation.pageTextSnippet || '').slice(0, 700),
      candidates: (input.observation.candidatesTopK || []).slice(0, 18),
      recentFailures: (input.observation.recentFailures || []).slice(-3),
    },
  }

  try {
    const resp = await llm.invoke(
      [new SystemMessage(STEP_DECIDE_SYSTEM), new HumanMessage(JSON.stringify(userPayload))],
      { signal: input.signal as AbortSignal | undefined },
    )
    const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content ?? '')
    const obj = extractFirstJsonObject(content)
    if (!obj) return null
    const parsed = ClassicStepDecideSchema.safeParse(obj)
    if (!parsed.success) return null

    let step = parsed.data
    if (step.confidence < classicStepDecideMinConfidence()) return null

    if (forbidden.includes(step.intent)) return null
    if (allowed.length && !allowed.includes(step.intent)) {
      if (!['goto', 'scroll', 'wait', 'dismiss_overlays', 'reload', 'back', 'done'].includes(step.intent)) {
        return null
      }
    }

    if (!stageAllowsIntent(stageHint, step.intent) && stageHint !== 'unknown') {
      const gated = gateStepByResultPage(step, input.observation, goals)
      if (gated && gated.intent !== step.intent) step = gated
      else if (!stageAllowsIntent(stageHint, step.intent)) return null
    }

    step = gateStepByResultPage(step, input.observation, goals) || step
    step = gateDoneByEnterDetail(step, input.observation, goals, startUrl)
    return step
  } catch {
    return null
  }
}
