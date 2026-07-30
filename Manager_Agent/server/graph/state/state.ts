import type { BaseMessage } from '@langchain/core/messages'
import type { ForceIntent, Intent, Step, TaskPlan } from '../../utils/shared/taskPlan'
import type { TaskConstraints } from '../core/plan'

export type ExecutableAgent =
  | 'db'
  | 'rag'
  | 'code'
  | 'crawler'
  | 'gui'
  | 'admin'
  | 'visualize'
  | 'report'
  | 'clean'
  | 'multimodal'
  | 'music'
  | 'video'

export type ManagerEntities = {
  names: string[]
  records: string[]
  locations: string[]
  dates: string[]
}

export type ManagerProbe = {
  db: { matched: boolean; tables: string[] }
  rag: { hasDocs: boolean; hits: number; sources: string[]; snippets?: unknown[] }
}

export type ManagerScheduler = {
  maxParallel: number
  timeoutScale: number
  contextBudget?: Record<string, number>
  skipAgents?: string[]
  agentTimeoutScale?: Record<string, number>
  circuitOpenAgents?: string[]
  degradeOptionalAgents?: string[]
  healthSummary?: string
  reason?: string
  generatedAt?: string
}

export type ManagerGraphMeta = {
  taskConstraints?: TaskConstraints
  needsClarify?: boolean
  clarifyQuestions?: string[]
  lowCostMode?: boolean
  seedUrls?: string[]
  serpContext?: string
  needsWebSearch?: boolean
  uncertainty?: 'low' | 'medium' | 'high'
  [key: string]: unknown
}

/** LangGraph 节点共享状态（与 managerGraph.ts Annotation 对齐） */
export type ManagerGraphState = {
  messages: BaseMessage[]
  humanDecision?: 'confirm' | 'cancel' | null
  /** Admin HITL 确认后续跑短路（须在 Annotation 中，否则 LangGraph 丢弃） */
  resumeAdminConfirm?: boolean
  resumeToSynth?: boolean
  forceIntent?: ForceIntent
  mediaAttachment?: { filePath: string; mediaType: 'image' | 'video' | 'audio'; filename?: string } | null
  intent: Intent
  allowedAgents?: ExecutableAgent[]
  plan?: Step[]
  taskPlan?: TaskPlan | null
  routedQuery?: string
  fixQuery?: string
  fixIntent?: Intent
  entities?: ManagerEntities
  probe?: ManagerProbe
  scheduler?: ManagerScheduler
  executionMode?: { mode: 'serial' | 'parallel' | 'vote'; reason?: string; voteTargets?: string[] }
  votePolicy?: {
    enabled: boolean
    targets: string[]
    scoring: Record<string, number>
  }
  results?: Record<string, string>
  evidence?: Array<Record<string, unknown>>
  meta?: ManagerGraphMeta
  resources?: {
    budgetUsd?: number
    budgetTokens?: number
    usedUsd?: number
    usedTokens?: number
    deadlineAtMs?: number
  }
  toolHealth?: {
    agents?: Array<{ agent: string; status: string; p95Ms?: number }>
  }
}
