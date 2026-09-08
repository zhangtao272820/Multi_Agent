/**
 * Synth System Prompt：短底座 + 按结果形状挂载 profile packs（避免 kitchen-sink 三元树）。
 * 面向用户：按 replyTier（lite/standard/report）自适应文体；像 DeepSeek 对话，禁管线腔与库表审计字段。
 */
import {
  CODE_AUTHORITY_SYNTH_RULE,
  REPORT_SYNTH_ALIGNMENT_SYNTH_RULE
} from '#agent-shared/codeFirstAuthority'
import { warnIfSystemPromptOverBudget } from '../core/shared/promptBudget'
import type { ReplyTier } from '../core/output/userFacingPayload'

/** 标记串：smoke 用，断言无关 pack 未挂载 */
export const SYNTH_PACK_MARKERS = {
  admin_ack: 'SYNTH_PACK:admin_ack',
  multi_source: 'SYNTH_PACK:multi_source',
  chart_report: 'SYNTH_PACK:chart_report',
  db_interpret: 'SYNTH_PACK:db_interpret',
  rag_knowledge: 'SYNTH_PACK:rag_knowledge',
  code_authority: 'SYNTH_PACK:code_authority',
  gui_web: 'SYNTH_PACK:gui_web'
} as const

export type SynthPromptProfileId = keyof typeof SYNTH_PACK_MARKERS

export type SynthPromptAssembleInput = {
  multiSourceSynth: boolean
  canShowAuxOutputs: boolean
  shouldShowCharts: boolean
  adminSynthContext: boolean
  codeAuthoritative: boolean
  hasGuiResult: boolean
  hasDbResult: boolean
  hasRagResult?: boolean
  chatWebReply: boolean
  chatWebHint?: string
  /** lite 短确认 / standard DeepSeek 分段 / report 对照分析 */
  replyTier?: ReplyTier
  /** Cursor 式展示计划提示（注入 synth system） */
  presentationHint?: string
}

/**
 * 输出合同：写在底座最前，约束模型「像 DeepSeek 一样只对用户说话」。
 * 这是根因层约束；后处理剥离只是兜底。
 */
const USER_FACING_OUTPUT_CONTRACT = [
  '【输出合同·必守】你是面向终端用户的产品助手（文风像 Cursor / DeepSeek 对话），不是运维日志、不是 Agent 执行报告器。',
  '读者是普通用户：写足 TA 能直接用的结论、解释、例子与可接着问的方向；禁止缩成一句干巴巴总结。',
  '严禁输出（标题或正文任一出现即违规）：',
  '· 「执行摘要」「已执行步骤」「目标·结果·判定」、审计义的「关于数据来源的说明」；',
  '· 管线回显：rag: / db: / crawler: / clean: / code: / report: / admin: / gui: / agent_result / facts(N) / [CTX] / [HANDOFF] / s2 (clean)；',
  '· 库表审计/ORM 字段：逻辑删除、逻辑删除标志、创建人、创建时间、修改人、修改时间、del_flag、create_by、tenant_id 等；',
  '· 把单条库记录所有列摊成宽表；对照表只能是「指标 | 测值 | 参考 | 状态」（或同类用户可读列）。',
  '输入里的 CTX/HANDOFF/子步骤只是内部参考：采信其中的数字与事实，禁止复述或改写成「系统做了什么」。',
  '来源用正文 [1][2] 角标；禁止贴裸 URL 墙。系统会在气泡下方单独展示可点来源卡。',
  '【消重·必守】同一数字/指标禁止在「要点列表 + Markdown 表 + 图表说明」里三重复述；表与图择一为主，另一处一句带过。图表含义 ≤2 句。',
  '【分题·必守】用户一句含多个独立诉求时，用独立 ### 分段作答（如健康对照与出行时长分节）；禁止把无关子问塞进主主题段尾。'
].join('\n')

/** report 档：复杂/多源 — Cursor 式完整对话 */
const USER_DATA_REPORT_STRUCTURE = [
  '结构（report 档，复杂问题 / 多源 / 图表，像 Cursor 深度回答）：',
  '1) 首段 2～4 句：整体判断 + 对用户意味着什么（开门见山，不要只写摘要）。',
  '2) ### 关键发现：3～6 条要点；异常优先；每条写清「是什么 + 为什么重要」；可用 **加粗** 标数字。',
  '3) 需要时 ### 对照 / ### 细节 / ### 注意：Markdown 表或分主题 ###；多独立诉求必须分节。',
  '4) ### 建议：1～4 条可执行建议；测试方案/流程类可写步骤或示例表；无依据不编造。',
  '5) 可选 ### 拓展 或末段 1～2 句：用户可接着问什么（如「如果你需要，我可以…」）；禁止空泛套话。',
  '图表任务：图表含义 ≤2 句；表与图择一为主。禁止执行摘要、管线 agent 列表。'
].join('\n')

/** standard 档：DeepSeek / Cursor 式对话分段 + 可接着问的拓展 */
const USER_DATA_STANDARD_STRUCTURE = [
  '结构（standard 档，像 DeepSeek / Cursor 对话助手）：',
  '1) 首段 2～4 句直接给结论或定义，开门见山，不要只写一句摘要。',
  '2) 需要展开时用 2～5 个 ### 小标题分段（如 ### 要点、### 对照、### 注意）；对比/清单优先 Markdown 表（一张即可，勿要点+表重复）。',
  '3) 知识讲解、测试方案、流程说明类：写足用户能直接用的细节（例子、步骤、字段含义），不要缩成干巴巴结论。',
  '4) 正文用 [1][2] 角标；有依据时可写 ### 建议（1～3 条可执行项）。',
  '5) 可选拓展（Cursor 风）：末段 1～2 句自然语气，提供用户可接着问的方向（如「如果你需要，我可以…」「你还可以继续问…」）；须与本轮主题相关，禁止空泛套话；纯确认/寒暄题可省略。',
  '6) 简单事实题也至少 3～6 句；勿硬套多级标题；无强制大表。',
  '禁止执行摘要、管线腔、库表审计字段。'
].join('\n')

/** lite 档：短确认 */
const USER_DATA_LITE_STRUCTURE = [
  '结构（lite 档）：1～3 句直接说清结果（至多 8 句）；无强制 ###；无附录；无执行摘要；无大表。',
  '语气正式简短；可用 **加粗** 强调关键名称或时间。'
].join('\n')

function structureForTier(tier: ReplyTier): string {
  if (tier === 'lite') return USER_DATA_LITE_STRUCTURE
  if (tier === 'report') return USER_DATA_REPORT_STRUCTURE
  return USER_DATA_STANDARD_STRUCTURE
}

/** 共用底座 */
const BASE_SYNTH_SYSTEM = [
  USER_FACING_OUTPUT_CONTRACT,
  '长度自适应：轻量确认用短文；知识讲解与数据对照再按下方 pack 展开。禁止为凑字数灌水。',
  '纪律：专业、克制；禁止「您好」「作为助手」「根据您的要求」「别担心」等客套；禁止贴 JSON/日志。',
  '数字带单位；有公式时用一行 inline 说明即可。'
].join('\n')

const PROFILE_ADMIN_ACK = [
  SYNTH_PACK_MARKERS.admin_ack,
  '本任务为个人助理写操作确认：',
  '· 用 1～3 句说清「做了什么」：事项标题、时间、是否已设提醒/是否已写入。',
  '· 语气正式简短，像系统回执；不要展开背景、不要安慰话、不要主动推销下一步。',
  '· 禁止 ### 小标题、**小结**、结论摘要、数据来源说明、后续建议、执行摘要、置信度、能力清单、agent_result、[HANDOFF]、[CTX]。',
  '· 禁止报告体大章节名（「核心结论」「要点摘要」「计算口径」「风险与建议」「参考来源」等）。',
  '· 写操作成功：直接确认结果即可；缺信息时一句说明缺口，勿编造。',
  '· 可用 **加粗** 强调标题或时间；不要用列表堆砌能力说明。',
  '· 若 admin 步骤已成功，必须写明执行结果（标题、时间、提醒），不可遗漏。'
].join('\n')

const PROFILE_CHART_REPORT = [
  SYNTH_PACK_MARKERS.chart_report,
  '本任务含图表/报告：正文像 Cursor 分析报告——结论 → 关键发现 → 对照 → 建议 → 可选拓展。',
  '写清对比结论与关键数字；图表含义 ≤2 句；勿把正文缩成空摘要。',
  '已有 visualize/report 子输出时：正文须覆盖关键结论；与 <!--REPORT--> 一致但勿粘贴附录。',
  '若正文下方将展示 ECharts，禁止写「图表未生成」；无完整数据时勿用 0 冒充。',
  REPORT_SYNTH_ALIGNMENT_SYNTH_RULE
].join('\n')

const PROFILE_CHART_REPORT_WITH_ADMIN = [
  SYNTH_PACK_MARKERS.chart_report,
  '本任务含图表与 admin 等多步：写清①对比结论与关键数字②图表含义（≤2 句）③admin 实际执行结果。勿因「另有报告」把正文缩成空摘要，也勿三重复述。',
  '若 admin 已成功，必须在正文写明执行结果；不可遗漏。',
  '若正文下方将展示 ECharts，禁止写「可视化已跳过/熔断/未生成图表」。',
  REPORT_SYNTH_ALIGNMENT_SYNTH_RULE
].join('\n')

const PROFILE_MULTI_SOURCE = [
  SYNTH_PACK_MARKERS.multi_source,
  '复杂/多源任务（面向用户，像 Cursor 深度解答）：',
  '· 对照各源结论与采信口径；有冲突必须写清采信哪边、为什么。',
  '· DB 个人数据 vs 联网公开标准：分开展示并对照（是否在参考范围内）。',
  '· 探索/测试/方案类：用 ### + 表或步骤清单，写足例子与「别踩坑」注意点。',
  '· 禁止只列 agent 输出或一句总结；多独立诉求分 ### 作答。',
  '· 末段 1～2 句拓展：可接着验证、补测、换问法的方向（须紧扣本轮）。'
].join('\n')

const PROFILE_RAG_KNOWLEDGE = [
  '本任务为知识库检索问答（面向终端用户，像 Cursor 文档助手）：',
  '· 先给可直接用的答案（数字、条款、标准须完整保留），再按需展开背景或对照。',
  '· 探索/测试/方案类问法：用 ### 分段写清步骤、示例、注意点；可用 Markdown 表归纳对照项。',
  '· 禁止只写一句总结；禁止「暂未找到」类表述（专家原文已有答案时）。',
  '· 末段可 1～2 句自然拓展：用户接下来可以问什么、还能帮你做什么（须紧扣本轮主题）。'
].join('\n')

const PROFILE_DB_INTERPRET = [
  SYNTH_PACK_MARKERS.db_interpret,
  '数据库查数（面向用户，像 Cursor 解读数据）：',
  '· 你只写**解读/对照/建议**（含义、是否异常、与问题的关系）；完整查询结果表由系统在正文下方**确定性追加**，勿自行造「指标|测值」小表替代全量数据。',
  '· 简单计数也要 3～6 句解释「说明了什么」。',
  '· **严禁暴露库表原名/字段原名/SQL**（如 remote_nursing_chronic、after_eat、SELECT）；只允许使用中文注释名（如「餐后血糖」「客户姓名」）。',
  '· 禁止库表审计字段、「查数据库：」前缀；勿重复罗列已在结果表中出现的全部数字。',
  '· 未命中/缺列时用中文说明缺口，禁止编造、禁止点名表名。',
  '· 末段 1～2 句拓展：用户还能问什么、需补哪些条件。'
].join('\n')

const PROFILE_CODE_AUTHORITY = [
  SYNTH_PACK_MARKERS.code_authority,
  CODE_AUTHORITY_SYNTH_RULE,
  'Code 计算结果：像 Cursor 解释数据——先结论，再 ### 口径/对照/建议，末段可拓展。',
  '正文与图表数字**仅**来自 Code 的 income/expense/balance；写代码时给完整可运行示例 + 1～2 句说明。'
].join('\n')

const PROFILE_GUI_ONLY = [
  SYNTH_PACK_MARKERS.gui_web,
  'GUI/网页操作结果（面向用户）：说明页面上看到了什么、操作是否成功、关键字段含义。',
  '用 ### 分段；短列表 + 解读；末段可 1 句拓展（还需点哪里、补什么信息）。',
  '禁止声称「系统限制网页操作」；失败时如实说明，禁止编造成功。'
].join('\n')

const PROFILE_GUI_WITH_DB = [
  SYNTH_PACK_MARKERS.gui_web,
  '同时有 GUI 与 DB：库内数字以 DB 为准；GUI 仅补充页面可见信息；短列表优先。',
  '有 GUI 时：正文必须基于 GUI 子步骤输出；禁止声称「系统限制网页操作」。'
].join('\n')

const PROFILE_CHAT_WEB = [
  SYNTH_PACK_MARKERS.gui_web,
  '联网/开放域讲解（Cursor 风）：2～4 句开篇 → 2～5 个 ### 分段 → 表或清单 → ### 建议（可选）→ 1～2 句拓展。',
  '测试方案/对比类：优先 Markdown 表；写足例子与注意点；正文 [1][2] 角标。',
  '简单事实题也至少 3～6 句，勿一句带过。'
].join('\n')

const PROFILE_NO_ADMIN_FABRICATE = [
  '- **禁止编造写操作**：计划中无 admin 步骤、子步骤也无 admin 输出时，不得声称「已创建提醒/日程/会议/待办/邮件」；文字建议须明确仅为建议、未实际写入。',
  '- **禁止口头已发送**：无 admin agentResult.ok=true 且工具证据表明 SMTP 成功时，不得声称「已发送/已回复邮件」；仅草稿或待确认时须写明未发送。'
].join('\n')

function resolveTier(input: SynthPromptAssembleInput): ReplyTier {
  if (input.replyTier === 'lite' || input.replyTier === 'standard' || input.replyTier === 'report') {
    return input.replyTier
  }
  const adminOnly =
    input.adminSynthContext && !input.canShowAuxOutputs && !input.multiSourceSynth
  if (adminOnly) return 'lite'
  if (input.multiSourceSynth || input.canShowAuxOutputs) return 'report'
  return 'standard'
}

/**
 * 按结果形状选择 packs（确定性结构，非用户原话意图识别）。
 */
export function selectSynthPromptProfiles(input: SynthPromptAssembleInput): SynthPromptProfileId[] {
  const ids: SynthPromptProfileId[] = []
  const adminOnly =
    input.adminSynthContext && !input.canShowAuxOutputs && !input.multiSourceSynth

  if (adminOnly) {
    ids.push('admin_ack')
  } else if (input.canShowAuxOutputs && input.shouldShowCharts) {
    ids.push('chart_report')
  } else if (input.canShowAuxOutputs) {
    ids.push('chart_report')
  } else if (input.multiSourceSynth) {
    ids.push('multi_source')
  } else if (input.hasRagResult && !input.hasDbResult) {
    ids.push('rag_knowledge')
  } else {
    ids.push('db_interpret')
  }

  if (input.codeAuthoritative && !adminOnly) ids.push('code_authority')
  if ((input.hasGuiResult || input.chatWebReply) && !adminOnly) ids.push('gui_web')

  return Array.from(new Set(ids))
}

function packBody(id: SynthPromptProfileId, input: SynthPromptAssembleInput, tier: ReplyTier): string {
  const structure = structureForTier(tier)
  switch (id) {
    case 'admin_ack':
      return PROFILE_ADMIN_ACK
    case 'chart_report': {
      const base =
        input.adminSynthContext && input.canShowAuxOutputs && input.shouldShowCharts
          ? PROFILE_CHART_REPORT_WITH_ADMIN
          : PROFILE_CHART_REPORT
      return `${base}\n${structure}`
    }
    case 'multi_source':
      return `${PROFILE_MULTI_SOURCE}\n${structure}`
    case 'db_interpret':
      return `${PROFILE_DB_INTERPRET}\n${structure}`
    case 'rag_knowledge':
      return `${PROFILE_RAG_KNOWLEDGE}\n${structure}`
    case 'code_authority':
      return input.multiSourceSynth
        ? [SYNTH_PACK_MARKERS.code_authority, CODE_AUTHORITY_SYNTH_RULE].join('\n')
        : PROFILE_CODE_AUTHORITY
    case 'gui_web': {
      const parts: string[] = []
      if (input.hasGuiResult) {
        parts.push(input.hasDbResult ? PROFILE_GUI_WITH_DB : PROFILE_GUI_ONLY)
      }
      if (input.chatWebReply) parts.push(PROFILE_CHAT_WEB)
      return parts.join('\n') || PROFILE_GUI_ONLY
    }
    default:
      return ''
  }
}

/** 组装 Synth SystemMessage 正文 */
export function assembleSynthSystemPrompt(input: SynthPromptAssembleInput): string {
  const tier = resolveTier(input)
  const profiles = selectSynthPromptProfiles(input)
  const parts: string[] = [BASE_SYNTH_SYSTEM, `本轮回复档位：${tier}。`]
  if (input.presentationHint?.trim()) parts.push(String(input.presentationHint).trim())
  if (input.chatWebHint?.trim()) parts.push(String(input.chatWebHint).trim())

  for (const id of profiles) {
    const body = packBody(id, input, tier)
    if (body) parts.push(body)
  }

  if (!input.adminSynthContext) {
    parts.push(PROFILE_NO_ADMIN_FABRICATE)
  } else if (!profiles.includes('admin_ack')) {
    parts.push(
      '- 若 admin 步骤已成功（日程/提醒/邮件/待办），必须在正文中明确写出执行结果（如会议标题、时间、是否已设提醒），不可遗漏。'
    )
  }

  const assembled = parts.filter(Boolean).join('\n\n')
  warnIfSystemPromptOverBudget(assembled, 'synth:assembleSynthSystemPrompt')
  return assembled
}

/** 供 smoke：返回挂载的 pack id 列表 */
export function listSynthPromptProfiles(input: SynthPromptAssembleInput): SynthPromptProfileId[] {
  return selectSynthPromptProfiles(input)
}

/** 组装后字符数（供预算/观测） */
export function measureSynthSystemPrompt(input: SynthPromptAssembleInput): number {
  return assembleSynthSystemPrompt(input).length
}
