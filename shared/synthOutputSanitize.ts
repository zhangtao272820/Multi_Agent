/**
 * 去掉 Synth 误复述的内部上下文 / 执行摘要审计块（确定性结构剥离，非业务意图识别）。
 */

/** 仅真正的执行摘要壳标题会进入审计吞段；勿单凭「证据/后续建议」掏空用户对照分析 */
const AUDIT_SHELL_HEADING_RE = /^#{1,3}\s*(执行摘要|已执行步骤|失败|跳过|关于数据来源的说明)(?:\s|$)/
/** 仅在已进入执行摘要语境时，才把「证据/后续建议」当审计子节 */
const AUDIT_NESTED_HEADING_RE = /^#{1,3}\s*(证据|后续建议)(?:\s|$)/
const AUDIT_META_LINE_RE = /^[-*•]\s*(目标|结果|判定)[：:]/
const PIPELINE_CHECK_LINE_RE =
  /^[-*•]\s*[✓×−○✔✖]\s*(db|rag|crawler|code|clean|visualize|report|admin|gui|multi|extractor|lobster)\b/i
const STEP_ID_LINE_RE = /^s\d+\s*\([^)]+\)\s*[：:]/i
const FACTS_ECHO_RE = /\bfacts\(\d+\)\s*[：:]/i
const AGENT_PIPELINE_DUMP_RE =
  /^(?:[-*•]\s*)?(?:✓|×|−|○|✔|✖)?\s*(db|rag|crawler|code|clean|visualize|report|admin|gui|multi|extractor|lobster)\s*[：:].{0,200}/i
const AGENT_RESULT_LINE_RE = /^(?:[-*•]\s*)?agent_result\b/i

/** 是否像结构化执行摘要 / 开发者审计 dump（供用户视图隐藏附录） */
export function looksLikeExecAuditDump(text: string): boolean {
  const s = String(text || '')
  if (!s.trim()) return false
  if (/#{1,3}\s*执行摘要(?:\s|$)/.test(s)) return true
  if (/#{1,3}\s*已执行步骤(?:\s|$)/.test(s) && (/#{1,3}\s*证据(?:\s|$)/.test(s) || /#{1,3}\s*后续建议(?:\s|$)/.test(s))) {
    return true
  }
  if (/[-*•]\s*目标[：:]/.test(s) && /[-*•]\s*(结果|判定)[：:]/.test(s)) return true
  if (/仅处理下列个人助理能力/.test(s) && /·\s*(邮件|联系人|待办)/.test(s)) return true
  return false
}

/**
 * 剥离误入用户载荷的结构化执行摘要与管线回显。
 * 保留面向用户的分析正文（### 月度收支、### 结论摘要 等对照标题）。
 *
 * 根因：Synth 常输出 ### 执行摘要（非 ##）；进入该节后直至文末均为审计，不可半途退出。
 */
export function stripStructuredExecReport(text: string): string {
  let s = String(text || '').trim()
  if (!s) return ''

  // 任意级别「执行摘要」起整段丢弃（含其后 ### 后续建议 / 管线回显）
  const execCut = s.search(/(?:^|\n)#{1,3}\s*执行摘要(?:\s|$)/m)
  if (execCut >= 0) {
    s = s.slice(0, execCut).trim()
    if (!s) return ''
  }

  const dashSplit = s.search(/\n---\n+#{1,3}\s*已执行步骤(?:\s|$)/m)
  if (dashSplit >= 0) s = s.slice(0, dashSplit).trim()

  const lines = s.split('\n')
  const out: string[] = []
  let inAuditSection = false
  for (const line of lines) {
    const t = line.trim()
    if (AUDIT_SHELL_HEADING_RE.test(t)) {
      // 执行摘要已在上方整段裁掉；其余壳标题起吞到文末
      inAuditSection = true
      continue
    }
    if (inAuditSection) {
      // 审计节一旦开始，不再恢复用户正文（避免 agent_result / 管线行打断后回漏）
      continue
    }
    if (AUDIT_META_LINE_RE.test(t)) continue
    if (PIPELINE_CHECK_LINE_RE.test(t)) continue
    if (STEP_ID_LINE_RE.test(t)) continue
    if (FACTS_ECHO_RE.test(t)) continue
    if (AGENT_PIPELINE_DUMP_RE.test(t)) continue
    if (AGENT_RESULT_LINE_RE.test(t)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Admin 能力 preamble 整块（含 admin:/error: 前缀） */
const ADMIN_PREAMBLE_BLOCK_RE =
  /(?:^|\n)(?:(?:admin|error)\s*[:：]\s*)?仅处理下列个人助理能力[^\n]*(?:\n(?:·\s[^\n]+|勿混入[^\n]+|会议与日程须[^\n]+|路线\/地图[^\n]+|用户说「从这[^\n]+|若已给出会议[^\n]+))*/gi

/** 中文阶段标签行（专才 dump 前缀，非用户叙述） */
const PHASE_STEP_LABEL_SRC = '^(查数据库|采集网页|清洗数据|计算数据|撰写报告|检索知识库|生成图表)[：:]'

/** 库表/专才「找到 N 条记录」原文 dump（可无阶段前缀） */
const RECORD_DUMP_RE =
  /根据您的查询[，,]\s*找到|找到\s*\d+\s*条相关记录|记录\s*\d+\s*[：:].{0,40}(客户姓名|姓名|指标)/

/** 剥离主列里的阶段标签前缀，保留后文结论 */
export function stripPhaseStepLabels(text: string): string {
  return String(text || '')
    .replace(new RegExp(PHASE_STEP_LABEL_SRC, 'gm'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 是否像被 clip 截断的正文（末尾省略号） */
export function looksLikeTruncatedSummary(text: string): boolean {
  const s = String(text || '').trim()
  if (!s) return false
  return /…\s*$/.test(s) || /\.\.\.\s*$/.test(s)
}

/**
 * 主列是否像「步骤 dump」拼接（composeFinal / 用户视图用来回退完整 synth）。
 * 含：阶段标签行、库表「找到 N 条记录」原文、截断专才串。
 * 注意：人员档案等多行「字段：值」是合法用户答案，不得仅凭字段行数判 dump。
 */
export function looksLikeStepDumpSummary(text: string): boolean {
  const s = String(text || '').trim()
  if (!s) return true
  if (/^(db|rag|crawler|code|clean|visualize|report|admin|gui)\s*已完成$/i.test(s)) return true
  if (/已完成$/.test(s) && s.length <= 24) return true
  if (/^\{[\s\S]*\}$/.test(s) && /"(answer|ok|sources|facts)"\s*:/.test(s)) return true
  if (/已机械合并/.test(s) && s.length < 200) return true
  if (/^deferred_to_synth$/i.test(s)) return true
  const labeled = (s.match(new RegExp(PHASE_STEP_LABEL_SRC, 'gm')) || []).length
  if (labeled >= 1) return true
  if (RECORD_DUMP_RE.test(s)) return true
  if (/report\s*已完成/i.test(s)) return true
  if (/已机械合并/.test(s) && /\{[\s\S]*"answer"/.test(s)) return true
  return false
}

/** 去掉 Synth 误复述的内部上下文标记 + 执行摘要审计块 */
export function stripSynthPromptLeakage(text: string): string {
  let s = String(text ?? '')
  if (!s.trim()) return s

  // 整块内部 CTX（HumanMessage 注入格式）
  s = s.replace(/\[CTX:[^\]\n]+\][\s\S]*?\[\/CTX\]/gi, '')
  // HANDOFF 块
  s = s.replace(/\[HANDOFF:[^\]]*\][\s\S]*?\[\/HANDOFF\]/gi, '')
  // 围栏 agent_result（仅匹配标注为 agent_result 的 fence）
  s = s.replace(/```\s*agent_result\b[\s\S]*?```/gi, '')

  // 旧版「### 数据来源：」与「关于数据来源的说明」块（止于下一标题或执行摘要，勿吞到文末）
  s = s.replace(
    /#{1,3}\s*数据来源[：:][^\n]*[\s\S]*?(?=\n#{1,3}\s|\n\*\*小结\*\*|\n##\s*执行摘要|\n---\s*\n|$)/gi,
    ''
  )
  s = s.replace(
    /#{1,3}\s*关于数据来源的说明[^\n]*[\s\S]*?(?=\n#{1,3}\s|\n\*\*小结\*\*|\n##\s*执行摘要|\n---\s*\n|$)/gi,
    ''
  )

  // 不可信外部 / UNTRUSTED：仅剥含该词的行
  s = s.replace(/(?:^|\n)[^\n]*不可信外部[^\n]*/gi, '\n')
  s = s.replace(/<<<UNTRUSTED_DATA[\s\S]*?UNTRUSTED_DATA>>>/gi, '')
  s = s.replace(/(?:^|\n)置信度[：:]\s*[\d.]+[^\n]*/gi, '\n')
  s = s.replace(/(?:^|\n)[^\n]*置信度\s*0?\.\d+[^\n]*/gi, '\n')

  // Admin 能力 preamble（含 admin: / error: 前缀）
  s = s.replace(ADMIN_PREAMBLE_BLOCK_RE, '\n')

  const dropLine = (line: string) => {
    const t = line.trim()
    if (!t) return false
    if (/^#{1,3}\s*数据来源[：:]/i.test(t)) return true
    if (/^#{1,3}\s*关于数据来源/i.test(t)) return true
    if (/^#{1,3}\s*结构化来源/i.test(t)) return true
    if (/^【RAG\s*检索事实】/i.test(t)) return true
    if (/^【RAG\s*探测事实块】/i.test(t)) return true
    if (/^【知识库检索】/.test(t)) return true
    if (/^\[CTX:/i.test(t) || /^\[\/CTX\]/i.test(t)) return true
    if (/^\[HANDOFF:/i.test(t) || /^\[\/HANDOFF\]/i.test(t)) return true
    if (/^\[事实\d+\]/.test(t)) return true
    if (/^\[来源\]\s/.test(t)) return true
    if (/^摘要：.*\((code|db|rag|crawler|admin)\)/i.test(t)) return true
    if (/^(?:(?:admin|error)\s*[:：]\s*)?仅处理下列个人助理能力/.test(t)) return true
    if (/^·\s*(邮件|联系人|待办|日程|天气|高德|飞书)[：:]/.test(t)) return true
    if (/^勿混入(搜索|知识库)/.test(t)) return true
    if (/^admin\s*[:：]\s*empty_result/i.test(t)) return true
    if (/^置信度[：:]\s*[\d.]+/.test(t)) return true
    if (/不可信外部/.test(t)) return true
    if (/^```\s*agent_result\b/i.test(t)) return true
    if (/^agent_result\b/i.test(t) && t.length < 80) return true
    return false
  }

  const lines = s.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (dropLine(line)) continue
    out.push(line)
  }
  s = out.join('\n')

  s = stripStructuredExecReport(s)
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s
}
