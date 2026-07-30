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
  /^(db|rag|crawler|code|clean|visualize|report|admin|gui)\s*[：:].{0,160}(检索|对齐|计算|生成|facts\(|知识库|可视化|清洗)/i

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
 * 保留面向用户的分析正文（### 月度收支、### 证据 等对照标题）。
 */
export function stripStructuredExecReport(text: string): string {
  let s = String(text || '').trim()
  if (!s) return ''

  const dashSplit = s.search(/\n---\n+##\s*执行摘要(?:\s|$)/m)
  if (dashSplit >= 0) s = s.slice(0, dashSplit).trim()
  // 先裁掉后半段执行摘要；勿用 /m 的 ^ 把「正文+## 执行摘要」整段判空
  const bare = s.search(/\n##\s*执行摘要(?:\s|$)/m)
  if (bare >= 0) s = s.slice(0, bare).trim()
  else if (/^##\s*执行摘要(?:\s|$)/.test(s)) return ''

  const lines = s.split('\n')
  const out: string[] = []
  let inAuditSection = false
  for (const line of lines) {
    const t = line.trim()
    if (AUDIT_SHELL_HEADING_RE.test(t)) {
      inAuditSection = true
      continue
    }
    if (inAuditSection && AUDIT_NESTED_HEADING_RE.test(t)) {
      continue
    }
    if (inAuditSection) {
      if (!t) continue
      if (
        AUDIT_META_LINE_RE.test(t) ||
        PIPELINE_CHECK_LINE_RE.test(t) ||
        STEP_ID_LINE_RE.test(t) ||
        FACTS_ECHO_RE.test(t) ||
        AGENT_PIPELINE_DUMP_RE.test(t) ||
        /^[-*•]/.test(t)
      ) {
        continue
      }
      // 非审计列表/回显 → 恢复用户正文（如 **小结**、普通段落、用户侧 ### 标题）
      inAuditSection = false
    }
    if (AUDIT_META_LINE_RE.test(t)) continue
    if (PIPELINE_CHECK_LINE_RE.test(t)) continue
    if (STEP_ID_LINE_RE.test(t)) continue
    if (FACTS_ECHO_RE.test(t)) continue
    if (AGENT_PIPELINE_DUMP_RE.test(t)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Admin 能力 preamble 整块（含 admin:/error: 前缀） */
const ADMIN_PREAMBLE_BLOCK_RE =
  /(?:^|\n)(?:(?:admin|error)\s*[:：]\s*)?仅处理下列个人助理能力[^\n]*(?:\n(?:·\s[^\n]+|勿混入[^\n]+|会议与日程须[^\n]+|路线\/地图[^\n]+|用户说「从这[^\n]+|若已给出会议[^\n]+))*/gi

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
