/**
 * 用户原话优先：历史经验/Playbook 召回不得扩写用户未要求的 agent 或子能力。
 * 原则：相似 ≠ 同一任务；经验只做弱提示，快路径仅允许与用户显式能力一致。
 */
import type { IntentRecallHit } from '../rag/intentRagRecallCore'
import { looksLikeSimpleRagKbQuery } from '../plan/clarifyContext'
import { resolveManagerEnvBool } from '../../../utils/platform/managerEnvModes'
import { textWantsVisualizeStructural } from '../../../utils/shared/visualizeMarkers'

export type UserExplicitCapabilities = {
  /** 用户原话允许出现的 agent 上界（含数据面基线 + 显式下游） */
  allowedAgents: Set<string>
  dataPlane: 'db' | 'rag' | 'admin' | 'media' | 'mixed' | 'unknown'
  wantsReport: boolean
  wantsVisualize: boolean
  wantsAdmin: boolean
  wantsWeb: boolean
}

const DOWNSTREAM = new Set(['clean', 'code', 'visualize', 'report'])
const DATA_AGENTS = new Set(['db', 'rag', 'crawler'])

function hasDbPlane(text: string): boolean {
  return /数据库|数据表|表里|SQL|查库|从库|表结构|从数据库/.test(text)
}

function hasRagPlane(text: string): boolean {
  return /知识库|文档库|手册|制度|内部资料|从知识库|在知识库|文档中/.test(text)
}

function hasAdminPlane(text: string): boolean {
  return /会议|日程|待办|邮件|提醒|创建.{0,6}(会议|日程)|发邮件|地铁|公交|路线|从.{1,12}到.{1,12}|多久|出行|天气/.test(text)
}

function hasWebPlane(text: string): boolean {
  return /公开网站|互联网|网上检索|网上查|网上搜|联网查|爬取|官网|权威网站/.test(text)
}

function hasMediaPlane(text: string): boolean {
  return /识图|图片里|生成音乐|生成视频|文生视频|文生音乐/.test(text)
}

/** 从用户末轮原话解析显式能力上界（legacy：仅经验召回漂移检测，路由决策勿用） */
export function parseUserExplicitCapabilities(userText: string): UserExplicitCapabilities {
  const s = String(userText || '').trim()
  const allowed = new Set<string>()
  const wantsVisualize = textWantsVisualizeStructural(s)
  const wantsReport = /生成.{0,6}报告|写.{0,4}报告|分析报告|整理成报告|输出报告/.test(s)
  const wantsAdmin = hasAdminPlane(s)
  const wantsWeb = hasWebPlane(s)
  const wantsCompute =
    (/计算|对比分析|汇总分析|统计分析|占比|百分比|比例|占有率/.test(s) && !looksLikeSimpleRagKbQuery(s)) ||
    /占比.{0,12}(多少|是多少)|多少.{0,12}占比/.test(s)

  const db = hasDbPlane(s)
  const rag = hasRagPlane(s) || looksLikeSimpleRagKbQuery(s)
  const admin = wantsAdmin
  const web = wantsWeb
  const media = hasMediaPlane(s)

  let dataPlane: UserExplicitCapabilities['dataPlane'] = 'unknown'
  const planes = [db && 'db', rag && 'rag', admin && 'admin', web && 'web', media && 'media'].filter(Boolean)
  if (planes.length === 1) dataPlane = planes[0] as UserExplicitCapabilities['dataPlane']
  else if (planes.length > 1) dataPlane = 'mixed'

  if (db) allowed.add('db')
  if (rag) allowed.add('rag')
  if (web) allowed.add('crawler')
  if (admin) allowed.add('admin')
  if (media) {
    allowed.add('multimodal')
    if (/音乐|歌曲/.test(s)) allowed.add('music')
    if (/视频|短片/.test(s)) allowed.add('video')
  }

  if (wantsReport) allowed.add('report')
  if (wantsVisualize) {
    allowed.add('visualize')
    allowed.add('code')
    allowed.add('clean')
  }
  if (wantsCompute) {
    allowed.add('code')
  }

  // 多数据源对齐才允许 clean（用户同时提了两种取数面，或明确要清洗）
  const multiData = (db ? 1 : 0) + (rag ? 1 : 0) + (web ? 1 : 0)
  if (multiData >= 2 || /清洗|对齐字段|去重/.test(s)) allowed.add('clean')

  // 纯知识库：默认不允许下游流水线，除非用户显式要报告/图表/计算；并列 db/联网/admin 时不得压成 rag-only
  if (looksLikeSimpleRagKbQuery(s) && !db && !web && !admin && !wantsReport && !wantsVisualize && !wantsCompute) {
    for (const a of [...allowed]) if (a !== 'rag') allowed.delete(a)
    allowed.add('rag')
  }

  return { allowedAgents: allowed, dataPlane, wantsReport, wantsVisualize, wantsAdmin, wantsWeb }
}

/** 召回命中是否携带用户未要求的 agent（能力漂移） */
export function recallHitHasCapabilityDrift(hit: IntentRecallHit, userText: string): boolean {
  const caps = parseUserExplicitCapabilities(userText)
  const agents = (hit.suggestedAgents || []).map((a) => String(a))
  if (!agents.length) return false

  for (const a of agents) {
    if (!caps.allowedAgents.has(a)) return true
  }

  if (hit.explicitWantsReport && !caps.wantsReport) return true
  if (hit.explicitWantsVisualize && !caps.wantsVisualize) return true
  if (hit.needsAdmin && !caps.wantsAdmin) return true
  if (hit.needsWeb && !caps.wantsWeb) return true

  const hitData = agents.filter((a) => DATA_AGENTS.has(a))
  if (caps.dataPlane === 'rag' && hitData.some((a) => a !== 'rag')) return true
  if (caps.dataPlane === 'db' && hitData.some((a) => a !== 'db')) return true

  const hitDownstream = agents.filter((a) => DOWNSTREAM.has(a))
  if (hitDownstream.length && !caps.wantsReport && !caps.wantsVisualize && caps.allowedAgents.size <= 2) {
    return true
  }

  return false
}

/** 将漂移命中降为弱提示（不参与 topHit / 快路径） */
export function demoteRecallHitForUser(hit: IntentRecallHit, userText: string): IntentRecallHit {
  if (!recallHitHasCapabilityDrift(hit, userText)) return hit
  return {
    ...hit,
    score: Math.min(hit.score, 0.48),
    explanation: `${hit.explanation}；⚠ 含用户未要求的步骤，仅作弱提示`
  }
}

export function recallHitAlignsWithUser(hit: IntentRecallHit, userText: string): boolean {
  return !recallHitHasCapabilityDrift(hit, userText)
}

/**
 * 经验召回是否允许走快路径。
 * 默认：仅 Playbook 且与用户能力一致；历史 experience 永不快路径（防相似问句绑架流水线）。
 */
export function experienceMayFastPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveManagerEnvBool('MANAGER_INTENT_RAG_EXPERIENCE_FAST_PATH', env)
}

export function filterRecallItemsForUser(items: IntentRecallHit[], userText: string): IntentRecallHit[] {
  const user = String(userText || '').trim()
  if (!user) return items

  const demoted = items.map((h) => demoteRecallHitForUser(h, user))
  const aligned = demoted.filter((h) => recallHitAlignsWithUser(h, user))
  const drifted = demoted.filter((h) => !recallHitAlignsWithUser(h, user))

  return [...aligned.sort((a, b) => b.score - a.score), ...drifted.sort((a, b) => b.score - a.score)]
}

export function pickTopRecallHitForUser(items: IntentRecallHit[], userText: string): IntentRecallHit | null {
  const ordered = filterRecallItemsForUser(items, userText)
  const aligned = ordered.find((h) => recallHitAlignsWithUser(h, userText))
  return aligned ?? null
}

/** 自进化 skill 草稿：执行路径是否与用户问句能力一致 */
export function skillPathAlignsWithUser(question: string, pathAgents: string[]): boolean {
  const agents = pathAgents.map((a) => String(a || '').trim()).filter(Boolean)
  if (!agents.length) return true
  const q = String(question || '').trim()
  if (!q) return true
  const hit: IntentRecallHit = {
    id: 'skill-path-check',
    score: 1,
    source: 'experience',
    matchedText: q.slice(0, 160),
    primaryIntent: (agents.length === 1 ? agents[0] : 'multi') as IntentRecallHit['primaryIntent'],
    isMulti: agents.length >= 2,
    suggestedAgents: agents as IntentRecallHit['suggestedAgents'],
    isDbAnchored: agents.includes('db'),
    needsAdmin: agents.includes('admin'),
    needsWeb: agents.includes('crawler') || agents.includes('gui'),
    explicitWantsReport: agents.includes('report'),
    explicitWantsVisualize: agents.includes('visualize'),
    planShortcut: 'none',
    explanation: 'skill draft path check'
  }
  return !recallHitHasCapabilityDrift(hit, q)
}
