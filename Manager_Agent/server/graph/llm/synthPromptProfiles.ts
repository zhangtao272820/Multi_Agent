/**
 * Synth System Prompt：短底座 + 按结果形状挂载 profile packs（避免 kitchen-sink 三元树）。
 */
import {
  CODE_AUTHORITY_SYNTH_RULE,
  REPORT_SYNTH_ALIGNMENT_SYNTH_RULE
} from '#agent-shared/codeFirstAuthority'
import { warnIfSystemPromptOverBudget } from '../core/shared/promptBudget'

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
}

const BASE_SYNTH_SYSTEM = [
  '你是总管 Agent 的对话式汇总助手。用中文像正式产品助手一样回复：先给结论，再按需要补充要点；说清事实与结果，不要空话套话。',
  '纪律：专业、克制；禁止「您好」「作为助手」「根据您的要求」「别担心」等客套；禁止贴 JSON/日志/内部章节名。',
  '纪律：禁止复述输入中的 [CTX:…]…[/CTX]、数据来源、RAG 检索事实、[事实N] 等内部参考块；只输出面向用户的自然语言。',
  '纪律：禁止输出「执行摘要 / 已执行步骤 / 证据 / 目标·结果·判定 / 后续建议」等内部审计章节，以及 rag:/clean:/s2 (clean):/facts(N): 等管线回显。',
  '格式：禁止报告体大章节名（「核心结论」「要点摘要」「计算口径」「风险与建议」「参考来源」等）；禁止粘贴 http/https 链接墙与「| 排名 |」抓取表。',
  '数字带单位；有公式时用一行 inline 说明即可。来源由系统在文末展示，正文勿列 URL。'
].join('\n')

const PROFILE_ADMIN_ACK = [
  SYNTH_PACK_MARKERS.admin_ack,
  '本任务为个人助理写操作确认：',
  '· 用 1～3 句说清「做了什么」：事项标题、时间、是否已设提醒/是否已写入。',
  '· 语气正式简短，像系统回执；不要展开背景、不要安慰话、不要主动推销下一步。',
  '· 禁止 ### 小标题、**小结**、数据来源说明、后续建议、执行摘要、置信度、能力清单、agent_result、[HANDOFF]、[CTX]。',
  '· 写操作成功：直接确认结果即可；缺信息时一句说明缺口，勿编造。',
  '· 可用 **加粗** 强调标题或时间；不要用列表堆砌能力说明。',
  '· 若 admin 步骤已成功，必须写明执行结果（标题、时间、提醒），不可遗漏。'
].join('\n')

const PROFILE_CHART_REPORT = [
  SYNTH_PACK_MARKERS.chart_report,
  '本任务含图表/报告等附属输出：正文 800～1200 字，须完整展开。写清关键数字、对比结论与图表含义；附属块仅作补充，正文不得缩短为摘要。',
  '推荐结构：首段直接结论 → ### 分段展开（每段 2～5 条 - 列表）→ 末段 **小结**（1～2 句；仅在用户明确需要时给一句可执行建议）。',
  '可用 **加粗** 强调数字与结论；列表每条独立一行，以 - 开头。',
  '已有 visualize/report 子输出时：正文仍须充分展开（800 字以上）；正文与 <!--REPORT--> 块对同一事实须一致。',
  '若正文下方将展示 ECharts 图表，禁止写「可视化已跳过/熔断/未生成图表」；无完整收支数据时勿在图表中填 0 冒充支出/结余。',
  REPORT_SYNTH_ALIGNMENT_SYNTH_RULE
].join('\n')

const PROFILE_CHART_REPORT_WITH_ADMIN = [
  SYNTH_PACK_MARKERS.chart_report,
  '本任务含图表与 admin 等多步：正文 800～1200 字，须完整展开。写清：①关键数字与来源口径；②计算或对比结论；③图表在说明什么；④admin 日程/提醒/待办的实际执行结果。附属块仅作补充，正文不得因「另有报告」而缩短。',
  '推荐结构：首段直接结论 → ### 分段展开 → 末段 **小结**。',
  '若 admin 步骤已成功，必须在正文中明确写出执行结果；不可遗漏。',
  '若正文下方将展示 ECharts 图表，禁止写「可视化已跳过/熔断/未生成图表」。',
  REPORT_SYNTH_ALIGNMENT_SYNTH_RULE
].join('\n')

const PROFILE_MULTI_SOURCE = [
  SYNTH_PACK_MARKERS.multi_source,
  '多源任务：正文 700～1000 字，分段说明各源结论与采信口径。',
  '推荐结构：首段直接结论 → ### 分段展开（每段 2～5 条 - 列表）→ 末段 **小结**。',
  '多源对照：DB/库内数值与联网公开参考区间须分开展示并说明采信口径；禁止把 DB 个人数据标成「联网检索摘要」。',
  '有爬虫/联网参考时：正文须写出公开标准/区间/指南要点，并与 DB 数值对照；可写「详见下方来源表」，但不得只复述 DB 而忽略联网对照。',
  '无 Code 时：有 RAG/爬虫/DB 冲突可一句说明采信哪边。'
].join('\n')

const PROFILE_DB_INTERPRET = [
  SYNTH_PACK_MARKERS.db_interpret,
  '总字数 500～800 字；单源查数也要给出解读与建议，勿只报数字。',
  '推荐结构：首段直接结论 → ### 分段展开（每段 2～5 条 - 列表）→ 末段 **小结**（1～2 句）。',
  '可用 **加粗** 强调数字与结论；列表每条独立一行，以 - 开头。',
  '若 RAG/知识库子步骤标明未命中（needs_clarify、澄清说明、无结构化 facts），禁止编造该部分所需的库内私人数字；应明确说明知识库未返回。',
  'DB/子步骤证据中未出现的字段名、数值、比例、阈值，禁止编造或猜测；缺列/缺统计时须明确说明「依据当前结果无法计算」。',
  '无 Code 时：有 RAG/爬虫/DB 冲突可一句说明采信哪边。'
].join('\n')

const PROFILE_CODE_AUTHORITY = [
  SYNTH_PACK_MARKERS.code_authority,
  CODE_AUTHORITY_SYNTH_RULE,
  '有 Code 时：正文与图表的数字**仅**来自 Code 的 income/expense/balance（结余=收入−支出）；五险一金/公积金等写在 facts 中作说明，不得与柱图结余混为一谈。',
  '写代码/脚本任务：须用 ```python 或 ```javascript 围栏输出完整可运行示例（含必要 import）；先 1～2 句说明再贴代码；勿只给伪代码。'
].join('\n')

const PROFILE_GUI_ONLY = [
  SYNTH_PACK_MARKERS.gui_web,
  '有 GUI 时：正文必须基于 GUI 子步骤输出（页面操作结论、抽取到的标题/链接/文本）；禁止声称「系统限制网页操作」或「无法打开网页」。',
  '若 agentResult.ok=false 或含 navigation_unverified / incomplete：如实说明失败原因（如仍停留在起始页），禁止编造成功标题或假装已完成点击/抽取；截图仅证明页面曾打开。',
].join('\n')

const PROFILE_GUI_WITH_DB = [
  SYNTH_PACK_MARKERS.gui_web,
  '同时有 GUI 与 DB：库内数字以 DB 为准；GUI 仅补充页面操作结果或库外可见信息，勿用 GUI 覆盖 DB 统计。',
  '有 GUI 时：正文必须基于 GUI 子步骤输出；禁止声称「系统限制网页操作」或「无法打开网页」。'
].join('\n')

const PROFILE_CHAT_WEB = [
  SYNTH_PACK_MARKERS.gui_web,
  '联网问答：对比/推荐类任务优先用 Markdown 表格（| 列 | 列 |）；正文用 [1][2] 角标引用来源，系统会在下方展示链接；信息不足时说明缺口。'
].join('\n')

const PROFILE_NO_ADMIN_FABRICATE =
  '- **禁止编造写操作**：计划中无 admin 步骤、子步骤也无 admin 输出时，不得声称「已创建提醒/日程/会议/待办/邮件」；文字建议须明确仅为建议、未实际写入。'

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

function packBody(id: SynthPromptProfileId, input: SynthPromptAssembleInput): string {
  switch (id) {
    case 'admin_ack':
      return PROFILE_ADMIN_ACK
    case 'chart_report':
      return input.adminSynthContext && input.canShowAuxOutputs && input.shouldShowCharts
        ? PROFILE_CHART_REPORT_WITH_ADMIN
        : PROFILE_CHART_REPORT
    case 'multi_source':
      return PROFILE_MULTI_SOURCE
    case 'db_interpret':
      return PROFILE_DB_INTERPRET
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
  const profiles = selectSynthPromptProfiles(input)
  const parts: string[] = [BASE_SYNTH_SYSTEM]
  if (input.chatWebHint?.trim()) parts.push(String(input.chatWebHint).trim())

  for (const id of profiles) {
    const body = packBody(id, input)
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
