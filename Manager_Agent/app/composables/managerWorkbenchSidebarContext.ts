import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { CollaborationPosture, PlanStepTodo } from './managerChatTypes'

export type SidebarRunPhaseItem = { phase?: string; agent?: string; ms: number }
export type TaskStatus = 'active' | 'paused' | 'done' | string

export type ManagerWorkbenchSidebarContext = {
  sidebarOpen: Ref<boolean>
  collaborationPosture: Ref<CollaborationPosture>
  planStepsTodo: Ref<PlanStepTodo[]>
  planStepsDoneCount: ComputedRef<number>
  taskBoardLive: Ref<{
    items: import('./managerMaturityUi').TaskBoardItemUi[]
    topology: string
  } | null>
  maturitySliLive: Ref<import('./managerMaturityUi').MaturitySliUi | null>
  routeCapLive: Ref<{ intent: string; agents: string[]; capLabel: string; dag?: string } | null>
  agentDisplayLabel: (agent: string, professional?: boolean) => string
  taskConstraintsLive: Ref<{
    timeHints?: string[]
    subjectHints?: string[]
    wantsVisualize?: boolean
    wantsReport?: boolean
  } | null>
  runObservabilityLive: Ref<{
    wallClockMs?: number
    tokenSummary?: {
      totalTokens?: number
      totalUsd?: number
      byModelTier?: Record<string, number>
      /** E3：estimated | mixed | actual */
      tokenAccounting?: 'estimated' | 'mixed' | 'actual'
    }
    phaseTimeline?: SidebarRunPhaseItem[]
  } | null>
  formatObsMs: (ms: number) => string
  formatTokenCount: (n: number) => string
  runPhaseBarMaxMs: ComputedRef<number>
  obsPhaseColor: (item: SidebarRunPhaseItem) => string
  obsDisplayLabel: (item: SidebarRunPhaseItem) => string
  runTokenByAgentEntries: ComputedRef<Array<[string, number]>>
  runTokenByTierEntries: ComputedRef<Array<[string, number]>>
  obsAgentColor: (agent: string) => string
  runTokenBarMax: ComputedRef<number>
  planAgentLabel: (agent: string) => string
  connected: Ref<boolean>
  clearingExperience: Ref<boolean>
  onClearExperience: () => void | Promise<void>
  clearingMemory: Ref<boolean>
  onClearMemory: () => void | Promise<void>
  clearingEvolution: Ref<boolean>
  onClearEvolution: () => void | Promise<void>
  evolutionLoading: Ref<boolean>
  loadEvolutionDashboard: () => void | Promise<void>
  evolutionSummary: Ref<Record<string, string | undefined> | null>
  healthChips: Ref<Array<{ agent: string; status: string; transport: string; tip?: string }>>
  learningChartPoints: Ref<Array<{ i: number; composite: number; feedback: number | null }>>
  learningChartEl: Ref<HTMLElement | null>
  learningRecent: Ref<Array<Record<string, unknown>>>
  opsToken: Ref<string>
  evolutionExperiments: Ref<Array<{ id: string; artifact: string; status: string; rationale?: string }>>
  previewText: (text: string, max?: number) => string
  opsBusy: Ref<boolean>
  promoteExperiment: (id: string) => void | Promise<void>
  rollbackExperiment: (id: string) => void | Promise<void>
  userGoalsActiveCount: ComputedRef<number>
  userGoals: Ref<Array<{ id: string; title: string; status: TaskStatus; priority?: string; createdAt?: string; updatedAt?: string; deadline?: string }>>
  userId: Ref<string>
  userGoalOverdue: (goal: { deadline?: string; status: TaskStatus }) => boolean
  formatShortDate: (iso: string) => string
  taskPriorityLabel: (p: string) => string
  setUserGoalStatus: (id: string, status: TaskStatus) => void | Promise<void>
  removeUserGoal: (id: string) => void | Promise<void>
  userGoalDraft: Ref<string>
  userGoalsSaving: Ref<boolean>
  addUserGoal: () => void | Promise<void>
  taskStackActiveCount: ComputedRef<number>
  taskStack: Ref<Array<{ id: string; title: string; status: TaskStatus; deadline?: string }>>
  proactiveNudges: Ref<Array<{ id: string; message: string }>>
  dismissProactiveNudge: (id: string) => void | Promise<void>
  taskStackSyncing: Ref<boolean>
  syncTaskStackInsights: () => void | Promise<void>
  taskOverdue: (task: { deadline?: string; status: TaskStatus }) => boolean
  taskStatusLabel: (status: TaskStatus) => string
  setTaskStackItemStatus: (id: string, status: TaskStatus) => void | Promise<void>
  removeTaskFromStack: (id: string) => void | Promise<void>
  taskStackDraft: Ref<string>
  taskStackSaving: Ref<boolean>
  addTaskToStack: () => void | Promise<void>
}

export const MANAGER_WORKBENCH_SIDEBAR_KEY: InjectionKey<ManagerWorkbenchSidebarContext> = Symbol('managerWorkbenchSidebar')
