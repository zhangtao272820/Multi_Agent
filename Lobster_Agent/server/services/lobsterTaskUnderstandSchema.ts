import { z } from 'zod'

export const LobsterTaskKindSchema = z.enum([
  'search',
  'navigate',
  'extract',
  'form_fill',
  'login',
  'video_play',
  'social_engagement',
  'desktop_app',
  'mobile_app',
  'multi_step',
  'monitor',
  'unknown',
])

export const LobsterBrowserProfileSchema = z.enum(['managed', 'user', 'auto'])

export const LobsterPlanStepOpSchema = z.enum([
  'goto',
  'click',
  'type',
  'submit',
  'extract',
  'wait',
  'observe',
])

export const LobsterPlanStepSchema = z.object({
  op: LobsterPlanStepOpSchema,
  target: z.string().max(240).optional(),
  done_when: z.string().max(240).optional(),
})

export const LobsterTaskGoalsSchema = z.object({
  must_leave_start: z.boolean().optional(),
  must_extract: z.boolean().optional(),
  must_submit: z.boolean().optional(),
  expected_url_change: z.boolean().optional(),
})

export const LobsterTaskUnderstandSchema = z.object({
  canonical_task: z.string().min(4).max(600),
  start_url: z.string().max(500).optional(),
  engine_hint: z.enum(['classic', 'mcp', 'stagehand', 'desktop', 'mobile', 'auto']).default('auto'),
  task_kind: LobsterTaskKindSchema.default('unknown'),
  browser_profile: LobsterBrowserProfileSchema.default('auto'),
  intent_hint: z.string().max(120).optional(),
  needs_login: z.boolean().default(false),
  explicitly_avoid_login: z.boolean().default(false),
  completion_criteria: z.string().max(320).optional(),
  success_criteria: z.string().max(320).optional(),
  plan_steps: z.array(LobsterPlanStepSchema).max(12).optional(),
  goals: LobsterTaskGoalsSchema.optional(),
  target_app: z.string().max(120).optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  rationale: z.string().max(320).default(''),
})

export type LobsterTaskUnderstandParsed = z.infer<typeof LobsterTaskUnderstandSchema>
export type LobsterTaskKind = z.infer<typeof LobsterTaskKindSchema>
export type LobsterBrowserProfile = z.infer<typeof LobsterBrowserProfileSchema>
export type LobsterPlanStep = z.infer<typeof LobsterPlanStepSchema>
export type LobsterTaskGoals = z.infer<typeof LobsterTaskGoalsSchema>

/** 网页类任务（默认 Stagehand 主路径） */
export const WEB_TASK_KINDS: ReadonlySet<LobsterTaskKind> = new Set([
  'search',
  'navigate',
  'extract',
  'form_fill',
  'login',
  'multi_step',
  'monitor',
])

export function isWebTaskKind(kind?: LobsterTaskKind | string | null): boolean {
  const k = String(kind || '').trim() as LobsterTaskKind
  return WEB_TASK_KINDS.has(k)
}

/** 供 router / executor 消费的结构化 TaskSpec */
export type LobsterTaskSpec = {
  canonical_task: string
  start_url?: string
  engine_hint: 'classic' | 'mcp' | 'stagehand' | 'desktop' | 'mobile' | 'auto'
  task_kind: LobsterTaskKind
  browser_profile: 'managed' | 'user'
  intent_hint?: string
  needs_login: boolean
  explicitly_avoid_login: boolean
  completion_criteria?: string
  success_criteria?: string
  plan_steps: LobsterPlanStep[]
  goals: LobsterTaskGoals
  target_app?: string
  confidence: number
  rationale: string
  source: 'llm' | 'manager' | 'fallback'
}

export function isLobsterTaskUnderstandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LOBSTER_TASK_UNDERSTAND ?? '1').trim() !== '0'
}

export function lobsterUnderstandMinConfidence(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOBSTER_UNDERSTAND_MIN_CONF ?? 0.5)
  return Number.isFinite(n) ? Math.max(0.35, Math.min(0.95, n)) : 0.5
}

/** 无 LLM plan_steps 时按 task_kind / goals 生成 2–4 步兜底计划 */
export function defaultPlanStepsForTask(input: {
  task: string
  startUrl?: string
  taskKind?: LobsterTaskKind
  goals?: LobsterTaskGoals
  completionCriteria?: string
}): LobsterPlanStep[] {
  const kind = input.taskKind || 'unknown'
  const start = String(input.startUrl || '').trim()
  const criteria = String(input.completionCriteria || '').trim()
  const steps: LobsterPlanStep[] = []

  if (start) {
    steps.push({ op: 'goto', target: start, done_when: '页面已打开起始 URL' })
  }

  if (kind === 'form_fill' || kind === 'login') {
    steps.push({ op: 'observe', target: '表单可交互字段', done_when: '可见输入框' })
    steps.push({ op: 'type', target: '按任务填写表单字段', done_when: '字段已填入' })
    if (input.goals?.must_submit) {
      steps.push({ op: 'submit', target: '提交表单', done_when: '提交完成或跳转' })
    }
    steps.push({
      op: 'extract',
      target: criteria || '提取表单结果或确认文案',
      done_when: '已得到结构化结果',
    })
    return steps.slice(0, 12)
  }

  if (kind === 'search') {
    steps.push({ op: 'type', target: '在搜索框输入关键词并搜索', done_when: '进入结果页' })
    steps.push({ op: 'click', target: '打开第一条相关结果', done_when: '已离开结果列表或进入详情' })
    steps.push({
      op: 'extract',
      target: criteria || '提取标题与链接',
      done_when: '已得到标题/链接',
    })
    return steps.slice(0, 12)
  }

  if (kind === 'navigate' || kind === 'extract' || kind === 'multi_step' || kind === 'unknown') {
    const leave = input.goals?.must_leave_start !== false
    if (leave || kind === 'navigate' || kind === 'extract') {
      steps.push({
        op: 'click',
        target: '按任务点击目标链接或按钮（如第一个教程）',
        done_when: 'URL 已离开起始页或进入目标页',
      })
    }
    steps.push({
      op: 'extract',
      target: criteria || '提取标题、链接等任务要求字段',
      done_when: '已得到结构化结果',
    })
    return steps.slice(0, 12)
  }

  steps.push({
    op: 'extract',
    target: criteria || String(input.task || '').slice(0, 200),
    done_when: '任务完成标准已满足',
  })
  return steps.slice(0, 12)
}

export function defaultGoalsForTaskKind(kind: LobsterTaskKind, task?: string): LobsterTaskGoals {
  const t = String(task || '')
  if (kind === 'form_fill') {
    return {
      must_leave_start: false,
      must_extract: true,
      must_submit: /提交|submit/i.test(t),
      expected_url_change: /提交|submit/i.test(t),
    }
  }
  if (kind === 'login') {
    return { must_leave_start: true, must_extract: false, must_submit: true, expected_url_change: true }
  }
  if (kind === 'search' || kind === 'navigate' || kind === 'extract' || kind === 'multi_step') {
    return {
      must_leave_start: true,
      must_extract: kind === 'extract' || kind === 'search' || /提取|标题|抽取/i.test(t),
      must_submit: false,
      expected_url_change: true,
    }
  }
  return { must_leave_start: false, must_extract: false, must_submit: false, expected_url_change: false }
}

export function toLobsterTaskSpec(
  understood: LobsterTaskUnderstandParsed,
  source: LobsterTaskSpec['source'],
  fallbackProfile: 'managed' | 'user' = 'managed',
): LobsterTaskSpec {
  const profile =
    understood.browser_profile === 'user'
      ? 'user'
      : understood.browser_profile === 'managed'
        ? 'managed'
        : fallbackProfile

  const task_kind = understood.task_kind
  // 保持 LLM/调用方的 engine_hint；网页默认 stagehand 由 resolveEngineFromTaskSpec 落地
  const softEngine = understood.engine_hint

  const goals: LobsterTaskGoals = {
    ...defaultGoalsForTaskKind(task_kind, understood.canonical_task),
    ...(understood.goals || {}),
  }

  const completion =
    String(understood.success_criteria || understood.completion_criteria || '').trim() || undefined

  const plan_steps =
    Array.isArray(understood.plan_steps) && understood.plan_steps.length > 0
      ? understood.plan_steps
      : defaultPlanStepsForTask({
          task: understood.canonical_task,
          startUrl: understood.start_url,
          taskKind: task_kind,
          goals,
          completionCriteria: completion,
        })

  return {
    canonical_task: understood.canonical_task,
    start_url: understood.start_url,
    engine_hint: softEngine,
    task_kind,
    browser_profile: profile,
    intent_hint: understood.intent_hint,
    needs_login: understood.needs_login,
    explicitly_avoid_login: understood.explicitly_avoid_login,
    completion_criteria: completion,
    success_criteria: completion,
    plan_steps,
    goals,
    target_app: understood.target_app,
    confidence: understood.confidence,
    rationale: understood.rationale,
    source,
  }
}

/**
 * 将理解结果合并进 RunParams 字段（纯结构转换，无 LLM）。
 * 注意：不把 understood.engine_hint 写入 engineHint。
 * engineHint 仅表示调用方强制（API/用户）；LLM 建议只在 TaskSpec.engine_hint，
 * 供 resolveEngineFromTaskSpec 软选型（网页落 stagehand 单引擎，无自动回退链）。
 */
export function applyLobsterTaskUnderstand(
  base: { task: string; startUrl?: string; engineHint?: string },
  understood: LobsterTaskUnderstandParsed | null,
): { task: string; startUrl?: string; engineHint?: string } {
  if (!understood) return base
  return {
    task: understood.canonical_task || base.task,
    startUrl: understood.start_url || base.startUrl,
    engineHint: base.engineHint,
  }
}

export function taskSpecPromptAddon(spec?: LobsterTaskSpec | null): string {
  if (!spec) return ''
  const goals = spec.goals || {}
  const goalBits = [
    goals.must_leave_start ? '须离开起始页' : '',
    goals.must_extract ? '须抽取结果' : '',
    goals.must_submit ? '须提交' : '',
  ].filter(Boolean)
  const planPreview = (spec.plan_steps || [])
    .slice(0, 6)
    .map((s, i) => `${i + 1}.${s.op}${s.target ? `(${s.target})` : ''}`)
    .join(' → ')
  const lines = [
    spec.task_kind && spec.task_kind !== 'unknown' ? `任务类型：${spec.task_kind}` : '',
    spec.completion_criteria || spec.success_criteria
      ? `完成标准：${spec.completion_criteria || spec.success_criteria}`
      : '',
    goalBits.length ? `目标：${goalBits.join('；')}` : '',
    planPreview ? `计划：${planPreview}` : '',
    spec.needs_login ? '需要登录或复用登录态' : '',
    spec.explicitly_avoid_login ? '用户明确要求不要登录' : '',
    spec.browser_profile === 'user' ? '浏览器 Profile：user（附着已登录 Chrome/CDP）' : '',
    spec.target_app ? `目标应用：${spec.target_app}` : '',
  ].filter(Boolean)
  return lines.length ? `\nTaskSpec：\n${lines.join('\n')}` : ''
}
