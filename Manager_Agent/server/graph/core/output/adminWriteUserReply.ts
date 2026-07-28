/**
 * 单步 admin 写成功 → 面向用户的短确认（正式、说清结果，无审计/能力清单废话）。
 */
import { stripSynthPromptLeakage } from '#agent-shared/synthOutputSanitize'
import { stripAdminManagerGuards } from '../../../utils/route/managerSubAgentHelpers'

const FLUFF_LINE_RE =
  /^(主要回复|主要回答如下|小结|后续建议|关于数据来源|数据来源说明|执行摘要)\b/i

/**
 * 从 admin 原文 / handoff 摘要组装用户可见确认。
 * 保留标题、时间、提醒等事实；去掉 preamble、置信度、章节壳。
 */
export function formatAdminWriteUserFacingReply(input: {
  adminText?: string
  handoffSummary?: string
  maxChars?: number
}): string {
  const maxChars = input.maxChars ?? 280
  const candidates = [
    String(input.handoffSummary || '').trim(),
    stripAdminManagerGuards(String(input.adminText || '')),
    String(input.adminText || '').trim()
  ]
    .map((t) => stripSynthPromptLeakage(t))
    .map((t) =>
      t
        .replace(/^admin\s*[:：]\s*/i, '')
        .replace(/^#{1,3}\s+[^\n]+\n?/gm, '')
        .replace(/\*\*小结\*\*[：:]?\s*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
    .filter((t) => t.length >= 4 && !FLUFF_LINE_RE.test(t))

  let body = ''
  for (const c of candidates) {
    if (/仅处理下列个人助理能力|置信度|不可信外部|agent_result/i.test(c)) continue
    body = c
    break
  }
  if (!body) {
    body = candidates[0] || '个人助理操作已完成。'
  }

  // 多段时只保留前两段实质内容，避免报告体回潮
  const paras = body
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p && !FLUFF_LINE_RE.test(p) && !/^[-*•]\s*$/.test(p))
  if (paras.length > 2) {
    body = paras.slice(0, 2).join('\n')
  } else {
    body = paras.join('\n')
  }

  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars).replace(/\s+\S*$/, '').trim()}…`
  }
  return body.trim() || '个人助理操作已完成。'
}
