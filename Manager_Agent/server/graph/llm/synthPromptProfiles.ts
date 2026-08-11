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
  chatWebReply: boolean
  chatWebHint?: string
  /** lite 短确认 / standard DeepSeek 分段 / report 对照分析 */
  replyTier?: ReplyTier
}

/**
 * 输出合同：写在底座最前，约束模型「像 DeepSeek 一样只对用户说话」。
 * 这是根因层约束；后处理剥离只是兜底。
 */
const USER_FACING_OUTPUT_CONTRACT = [
  '【输出合同·必守】你是面向终端用户的产品助手（文风像 DeepSeek），不是运维日志、不是 Agent 执行报告器。',
  '读者是普通用户：只写 TA 能直接看懂的结论、依据要点与建议；写完即止。',
  '严禁输出（标题或正文任一出现即违规）：',
  '· 「执行摘要」「已执行步骤」「目标·结果·判定」、审计义的「后续建议」「关于数据来源的说明」；',
  '· 管线回显：rag: / db: / crawler: / clean: / code: / report: / admin: / gui: / agent_result / facts(N) / [CTX] / [HANDOFF] / s2 (clean)；',
  '· 库表审计/ORM 字段：逻辑删除、逻辑删除标志、创建人、创建时间、修改人、修改时间、del_flag、create_by、tenant_id 等；',
  '· 把单条库记录所有列摊成宽表；对照表只能是「指标 | 测值 | 参考 | 状态」（或同类用户可读列）。',
  '输入里的 CTX/HANDOFF/子步骤只是内部参考：采信其中的数字与事实，禁止复述或改写成「系统做了什么」。',
  '来源用正文 [1][2] 角标；禁止贴裸 URL 墙。系统会在气泡下方单独展示可点来源卡。',
  '【消重·必守】同一数字/指标禁止在「要点列表 + Markdown 表 + 图表说明」里三重复述；表与图择一为主，另一处一句带过。图表含义 ≤2 句。',
  '【分题·必守】用户一句含多个独立诉求时，用独立 ### 分段作答（如健康对照与出行时长分节）；禁止把无关子问塞进主主题段尾。'
].join('\n')

/** report 档：DeepSeek 式展开 + 数据对照（仍是用户可读，不是执行报告） */
const USER_DATA_REPORT_STRUCTURE = [
  '结构（report 档，仍像 DeepSeek 对话，只是数据更完整）：',
  '1) 首段 1～3 句：整体判断 + 对用户意味着什么（开门见山）。',
  '2) ### 关键发现：3～5 条要点；异常/偏高/偏低优先，正常项可一句带过。可用 **加粗** 标数字。要点只写结论，勿把表内每一格再抄一遍。',
  '3) 对照数据：Markdown 表（指标 | 测值 | 参考 | 状态）**或**交给下方图表展示，二者择一为主；若用表则状态用「正常 / 略高 / 略低 / 需关注」。异常项可另起短段解读，勿再列一遍全表。',
  '4) ### 建议：1～3 条可执行建议；无依据不编造。',
  '多独立诉求时按主题分 ###（例：### 健康对照、### 出行），写完即止。',
  '写完「建议」立即结束。禁止再写执行摘要、已执行步骤、管线 agent 列表或「如需深挖」审计套话。'
].join('\n')

/** standard 档：DeepSeek 式对话分段 */
const USER_DATA_STANDARD_STRUCTURE = [
  '结构（standard 档，像 DeepSeek）：',
  '1) 首段 2～3 句直接给结论或定义，开门见山。',
  '2) 需要展开时用 2～4 个 ### 小标题分段；对比/推荐优先 Markdown 表（一张即可，勿要点+表重复）。',
  '3) 正文用 [1][2] 角标；末段一句小结或建议即可。',
  '4) 简单事实题 2～8 句答完，勿硬套多级标题；无强制大表。',
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
  '本任务含图表/报告附属输出：正文写清对比结论与关键数字；图表含义 ≤2 句，勿用长文复述柱上每一格。',
  '已有 visualize/report 子输出时：正文仍须覆盖关键结论；与 <!--REPORT--> 对同一事实须一致，但勿把附录整段粘进正文。',
  '若正文下方将展示 ECharts，禁止写「可视化已跳过/熔断/未生成图表」；无完整收支数据时勿在图表中填 0 冒充支出/结余。',
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
  '多源任务：用用户能懂的话对照各源结论与采信口径，异常优先。',
  'DB/库内数值与联网公开参考区间须分开展示并说明采信口径；禁止把 DB 个人数据标成「联网检索摘要」。',
  '有联网参考时：写出公开标准/区间/指南要点并与 DB 对照；可写「详见下方来源」，不得只复述 DB。',
  '多独立诉求分 ### 作答，禁止把无关子问粘在主主题段尾。',
  '无 Code 时：有冲突可一句说明采信哪边。'
].join('\n')

const PROFILE_DB_INTERPRET = [
  SYNTH_PACK_MARKERS.db_interpret,
  '单源查数也要给出解读与建议，勿只报数字；轻量问数用短文，指标对照用完整结构。',
  '若 RAG/知识库标明未命中，禁止编造该部分私人数字；应说明知识库未返回。',
  '证据中未出现的字段/数值/阈值禁止编造；缺列时说明「依据当前结果无法计算」。',
  '无 Code 时：有冲突可一句说明采信哪边。'
].join('\n')

const PROFILE_CODE_AUTHORITY = [
  SYNTH_PACK_MARKERS.code_authority,
  CODE_AUTHORITY_SYNTH_RULE,
  '有 Code 时：正文与图表数字**仅**来自 Code 的 income/expense/balance（结余=收入−支出）；五险一金等写在说明里，不得与柱图结余混谈。',
  '写代码/脚本：用 ```python 或 ```javascript 围栏给完整可运行示例；先 1～2 句说明再贴代码。'
].join('\n')

const PROFILE_GUI_ONLY = [
  SYNTH_PACK_MARKERS.gui_web,
  '有 GUI 时：正文基于 GUI 子步骤（页面操作结论、抽取到的标题/链接/文本）；短列表优先，勿灌水。',
  '禁止声称「系统限制网页操作」。',
  '若 agentResult.ok=false 或 navigation_unverified / incomplete：如实说明失败原因；禁止编造成功标题。'
].join('\n')

const PROFILE_GUI_WITH_DB = [
  SYNTH_PACK_MARKERS.gui_web,
  '同时有 GUI 与 DB：库内数字以 DB 为准；GUI 仅补充页面可见信息；短列表优先。',
  '有 GUI 时：正文必须基于 GUI 子步骤输出；禁止声称「系统限制网页操作」。'
].join('\n')

const PROFILE_CHAT_WEB = [
  SYNTH_PACK_MARKERS.gui_web,
  '联网/知识讲解（DeepSeek 风）：短开篇（2～3 句）→ 2～4 个 ### 分段 → 列表或一张对照表 → 末段一句小结。',
  '对比/推荐优先 Markdown 表；正文 [1][2] 角标；信息不足时说明缺口；勿要点与表重复同一事实。',
  '简单事实题：2～8 句直接答完。'
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
