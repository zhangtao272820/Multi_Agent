/**
 * Field Guide：回合级目标板（Phase D）。确定性合成，不调 LLM；字符预算控 token。
 */
import { fieldGuideMaxChars } from '#agent-shared/specialistBrief'
import type { TaskBoardItem } from './taskBoard'
import { formatTaskBoardForParent } from './taskBoard'
import {
  multimodalFactsForFieldGuide,
  type MultimodalStructuredHandoff
} from '#agent-shared/multimodalStructuredHandoff'

export type FieldGuideInput = {
  userGoal?: string
  taskBoard?: TaskBoardItem[]
  softHandoffDigest?: string
  globalFacts?: string[]
  failedNotes?: string[]
  /** multimodal 结构化交接 → 已决事实槽 */
  multimodalStructured?: MultimodalStructuredHandoff | null
  maxChars?: number
}

/**
 * 合成 Field Guide 文本（append-only 风格摘要）。
 * 失败步保留在 failedNotes，禁静默抹错。
 */
export function buildFieldGuideDigest(input: FieldGuideInput, env: NodeJS.ProcessEnv = process.env): string {
  const max = input.maxChars ?? fieldGuideMaxChars(env)
  const parts: string[] = ['【FieldGuide】']
  const goal = String(input.userGoal || '').trim()
  if (goal) parts.push(`目标: ${goal.slice(0, 200)}`)

  const board = Array.isArray(input.taskBoard) ? input.taskBoard : []
  if (board.length) {
    const boardText = formatTaskBoardForParent(board, 6)
    if (boardText) parts.push(boardText)
  }

  const mmFacts = multimodalFactsForFieldGuide(input.multimodalStructured)
  const facts = [
    ...mmFacts,
    ...(Array.isArray(input.globalFacts) ? input.globalFacts : [])
      .map((f) => String(f || '').trim())
      .filter(Boolean)
  ].slice(0, 5)
  if (facts.length) {
    parts.push('已决:')
    for (const f of facts) parts.push(`- ${f.slice(0, 120)}`)
  }

  const fails = (Array.isArray(input.failedNotes) ? input.failedNotes : [])
    .map((f) => String(f || '').trim())
    .filter(Boolean)
    .slice(0, 4)
  if (fails.length) {
    parts.push('失败保留:')
    for (const f of fails) parts.push(`- ${f.slice(0, 120)}`)
  }

  const soft = String(input.softHandoffDigest || '').trim()
  if (soft) parts.push(`交接: ${soft.slice(0, 300)}`)

  let out = parts.join('\n')
  if (out.length > max) out = `${out.slice(0, Math.max(0, max - 1))}…`
  return out
}
