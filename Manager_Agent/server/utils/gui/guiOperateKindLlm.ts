/**
 * GUI 操作类型结构化（LLM）：form_fill / login / search… + 可选 workflow_id。
 * 禁止用户原话 regex 主路径判定意图。
 */
import { z } from 'zod'
import { safeJsonParse } from '../../graph/core/shared/llmJson'
import type { LlmInvokeFn } from '../../graph/llm/taskConstraintsLlm'
import { createManagerChatOpenAI } from '../chat/managerChatOpenAI'
import {
  normalizeManagerGuiTaskKind,
  type ManagerGuiTaskKind,
} from '#agent-shared/managerTaskEnvelope'
import { listKnownGuiWorkflowIds, resolveGuiWorkflowForTaskKind } from './guiWorkflowAllowlist'

const WorkflowArgsSchema = z.record(z.unknown()).optional()

export const GuiOperateKindSchema = z.object({
  task_kind: z.enum([
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
  ]),
  needs_login: z.boolean().default(false),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().max(240).optional(),
  /** OpenClaw 式宏 id；仅当用户明确要跑已有宏或语义明确对应某宏时填写 */
  workflow_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i)
    .optional()
    .nullable(),
  workflow_args: WorkflowArgsSchema.nullable(),
})

export type GuiOperateKindDecision = {
  task_kind: ManagerGuiTaskKind
  needs_login: boolean
  confidence: number
  rationale: string
  workflow_id?: string
  workflow_args?: Record<string, unknown>
  /** 被白名单丢弃的宏 id（供执行层打 thinking） */
  dropped_workflow_id?: string
}

function systemPrompt(): string {
  const known = listKnownGuiWorkflowIds().join(', ') || '(无)'
  return [
    '你是总管 Agent 的「浏览器操作类型」分类器。根据用户要在真实浏览器里做的事，输出 task_kind。',
    '只输出 JSON，禁止 markdown。勿用关键词表硬套；按语义判断。',
    '',
    'task_kind：',
    '- form_fill：填写输入框/下拉/勾选并可选提交（httpbin、Ant Design 表单、登记表等）',
    '- login：登录/注册/鉴权（账号密码、验证码页人工确认也属此类）',
    '- search：站内搜索（打开搜索页、输入词、点结果）',
    '- extract：抽取标题/链接/列表（可在搜索或导航之后）',
    '- navigate：仅打开/跳转 URL，无明显搜索或填表',
    '- video_play：播放/观看视频',
    '- social_engagement：点赞/投币/关注/收藏等',
    '- desktop_app / mobile_app：原生桌面或 Android',
    '- multi_step：明确的多阶段复合操作',
    '- unknown：无法判断',
    '',
    'needs_login：任务明确需要登录态或登录页时为 true。',
    '',
    'workflow_id（可选）：仅当 task_kind=form_fill 且用户明确指定工作流/宏名，或明确要求跑下列已知黄金宏时填写。',
    `- 允许的宏 id（禁止编造其它 id）：${known}`,
    '- httpbin-form-fill：仅 form_fill + httpbin.org/forms/post 填 Customer name',
    '- navigate / extract / search / multi_step：必须省略 workflow_id（禁止误挂 form 宏）',
    '- 不确定或仅为「打开网页/点链接/抽标题」→ 省略 workflow_id，只出 task_kind',
    'workflow_args（可选）：宏参数对象。httpbin-form-fill 需 customer_name；startUrl 若任务含 URL 可写入。',
    '勿把普通填表误判为必须走宏；无明确宏意图时只出 task_kind。',
    '',
    '「怎么学 Python / 教程推荐」等资讯问答不属于本分类器（应由上层判 search_chat）。',
    'schema: {"task_kind":"...","needs_login":boolean,"confidence":number,"rationale":string,"workflow_id"?:string,"workflow_args"?:object}',
  ].join('\n')
}

export function isGuiOperateKindLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_GUI_OPERATE_KIND_LLM ?? '1').trim() !== '0'
}

export function isGuiOperateKind(kind: ManagerGuiTaskKind | string | undefined): boolean {
  const k = String(kind || '').trim()
  return k === 'form_fill' || k === 'login'
}

function decisionFromParsed(data: z.infer<typeof GuiOperateKindSchema>): GuiOperateKindDecision | null {
  const kind = normalizeManagerGuiTaskKind(data.task_kind)
  if (!kind) return null
  const rawWf = String(data.workflow_id || '').trim() || undefined
  const resolved = resolveGuiWorkflowForTaskKind(rawWf, kind)
  const workflow_id = resolved.ok ? resolved.id : undefined
  const dropped_workflow_id =
    !resolved.ok && resolved.dropped ? resolved.dropped : undefined
  const workflow_args =
    data.workflow_args && typeof data.workflow_args === 'object' && !Array.isArray(data.workflow_args)
      ? (data.workflow_args as Record<string, unknown>)
      : undefined
  return {
    task_kind: kind,
    needs_login: data.needs_login === true,
    confidence: Number(data.confidence ?? 0.7),
    rationale: String(data.rationale || '').slice(0, 240),
    ...(workflow_id ? { workflow_id } : {}),
    ...(dropped_workflow_id ? { dropped_workflow_id } : {}),
    ...(workflow_id && workflow_args && Object.keys(workflow_args).length
      ? { workflow_args }
      : {}),
  }
}

/** 从 meta 读取路由/执行阶段已写入的 operateKind */
export function guiOperateKindFromMeta(meta: unknown): GuiOperateKindDecision | null {
  const raw = (meta as { guiOperateKind?: unknown } | null)?.guiOperateKind
  if (!raw || typeof raw !== 'object') return null
  const parsed = GuiOperateKindSchema.safeParse(raw)
  if (!parsed.success) return null
  return decisionFromParsed(parsed.data)
}

export async function resolveGuiOperateKindByLlm(input: {
  userText: string
  llmInvoke?: LlmInvokeFn | null
  state?: unknown
  llm?: { openaiApiKey?: string; openaiModel?: string; openaiBaseUrl?: string } | null
}): Promise<GuiOperateKindDecision | null> {
  if (!isGuiOperateKindLlmEnabled()) return null
  const q = String(input.userText || '').trim()
  if (q.length < 4) return null

  try {
    if (input.llmInvoke && input.state) {
      const r = await input.llmInvoke(
        'route',
        input.state,
        [
          ['system', systemPrompt()],
          ['human', q.slice(0, 2000)],
        ],
        { tier: 'light' },
      )
      const parsed = GuiOperateKindSchema.safeParse(safeJsonParse(String(r.text ?? '').trim()))
      if (parsed.success && Number(parsed.data.confidence ?? 0) >= 0.45) {
        return decisionFromParsed(parsed.data)
      }
    }
    const key = String(input.llm?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim()
    if (!key) return null
    const model = createManagerChatOpenAI({
      apiKey: key,
      modelName: String(input.llm?.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
      openaiBaseUrl: input.llm?.openaiBaseUrl || process.env.OPENAI_BASE_URL,
      temperature: 0,
      skipThinking: true,
    })
    const res = await model.invoke([
      ['system', systemPrompt()],
      ['human', q.slice(0, 2000)],
    ])
    const parsed = GuiOperateKindSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.45) return null
    return decisionFromParsed(parsed.data)
  } catch {
    return null
  }
}
