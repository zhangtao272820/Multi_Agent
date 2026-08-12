import { BaseMessage, HumanMessage } from '@langchain/core/messages'
import { extractManagerCoreQuestion, stripDbManagerPrefixes, stripPlanConstraintsFromQuery } from '#agent-shared/managerSubAgentProtocol'
import { estimateTokensSync } from '#agent-shared/tokenEstimate'
import { normalizeEntities, type Intent, type Step, type TaskPlan } from '../../../utils/shared/taskPlan'
import { safeJsonParse } from '../shared/llmJson'
import type { TaskConstraints } from '../plan'
import { compositeMediaFromMeta, type CompositeMediaAgents } from '../../llm/mediaRouteLlm'
import { EMPTY_TASK_CONSTRAINTS } from '../../llm/taskConstraintsLlm'
import { resolveDbStepQuestionSync } from '../db/dbStepQuestion'
import { shouldRunNlCoalesce } from '../routing/nlResolve'
import { hasStructuralMultiLineBullets } from './routingContext'

export function normalizeForScenario(text: string) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
    .toLowerCase()
}

function normalizeEntityToken(token: string) {
  return String(token ?? '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9_-]/g, '')
    .trim()
}

/** 学习/记忆场景键：不做业务 intent 正则，统一中性标签 */
export function inferIntentForScenario(text: string): Intent {
  if (hasStructuralMultiLineBullets(String(text || ''))) return 'multi'
  return 'multi'
}

export function topEntitySignature(text: string) {
  const raw = String(text ?? '').slice(0, 500)
  // 仅保留字母数字标识符，不做中文 NER 正则
  const idLike = raw.match(/\b[A-Za-z0-9][A-Za-z0-9_-]{2,24}\b/g) || []
  const merged = Array.from(new Set(idLike.map(normalizeEntityToken).filter(Boolean)))
  return merged.slice(0, 3)
}

export function timeSignature(text: string) {
  const t = normalizeForScenario(text)
  if (!t) return 't:none'
  // 学习场景键：不做业务时间正则，统一中性标签
  return 't:semantic'
}

export function deriveScenarioKey(text: string) {
  const normalized = normalizeForScenario(text)
  if (!normalized) return 'struct:none|entities:none|t:none'
  const struct = hasStructuralMultiLineBullets(String(text || '')) ? 'multi-line' : 'single'
  const entities = topEntitySignature(text)
  const entityPart = entities.length ? entities.join(',') : 'none'
  const timePart = timeSignature(text)
  return `struct:${struct}|entities:${entityPart}|${timePart}`
}

/** 越权/高风险由 securityNode + 路由模型判定，不用问句关键词表 */
export function isCapabilityOutOfScope(_text: string) {
  return { out: false as const }
}

export function uncertaintyFromConfidence(conf?: number): 'low' | 'medium' | 'high' {
  const c = typeof conf === 'number' ? conf : 0.5
  if (c >= 0.8) return 'low'
  if (c >= 0.6) return 'medium'
  return 'high'
}

export function estimateTokensFromText(text: string) {
  const r = estimateTokensSync(String(text ?? ''))
  return Math.max(1, r.tokens || 1)
}

export function estimateTokensFromMessages(messages: BaseMessage[]) {
  let total = 0
  for (const m of Array.isArray(messages) ? messages : []) {
    total += estimateTokensFromText((m as any)?.content ?? '')
  }
  return total
}

export function stripLatexMath(text: string) {
  let s = String(text ?? '')
  s = s.replace(/\\\(|\\\)|\\\[|\\\]/g, '')
  s = s.replace(/\$\$[\s\S]*?\$\$/g, (m) => m.replace(/\$\$/g, ''))
  s = s.replace(/\$([^\n$]{1,200})\$/g, '$1')
  s = s.replace(/\\times/g, '×')
  s = s.replace(/\\cdot/g, '·')
  s = s.replace(/\\approx/g, '≈')
  s = s.replace(/\\text\{([^}]+)\}/g, '$1')
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')
  s = s.replace(/\\%/g, '%')
  s = s.replace(/\s{2,}/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function extractLeadingJsonObject(text: string) {
  const s = String(text ?? '')
  const leading = s.trimStart()
  if (!leading.startsWith('{')) return null
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = 0; i < leading.length; i++) {
    const ch = leading[i]
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  const jsonText = leading.slice(0, end + 1)
  const rest = leading.slice(end + 1)
  try {
    const obj = JSON.parse(jsonText)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    return { obj, rest: rest.trim() }
  } catch {
    return null
  }
}

export function normalizeFinalUserText(text: string) {
  const raw = String(text ?? '').trim()
  if (!raw) return raw
  const lead = extractLeadingJsonObject(raw)
  if (!lead) return raw
  const obj: any = lead.obj
  const report = typeof obj?.report === 'string' ? obj.report : typeof obj?.answer === 'string' ? obj.answer : ''
  if (report.trim()) {
    const rest = String(lead.rest || '').trim()
    if (!rest) return String(report).trim()
    // Keep appended blocks (e.g. ECHARTS/TABLE markers) after the JSON wrapper.
    return `${String(report).trim()}\n\n${rest}`
  }
  if (lead.rest) return String(lead.rest).trim()
  return raw
}
