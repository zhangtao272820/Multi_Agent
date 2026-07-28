import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { CollaborationPosture, LogItem, PendingAttachment, PlanStepTodo, TurnGroup, WorkbenchMode } from './managerChatTypes'

export type ManagerChatRailContext = {
  pendingPlanPreview: Ref<{
    hint?: string
    constraints?: string
    approveTier?: 'auto' | 'plan' | 'strict'
    riskScore?: number
    steps: Array<{
      id: string
      agent: string
      agentLabel?: string
      query: string
      enabled: boolean
      optional?: boolean
      confirmMode?: 'hitl' | 'auto_confirm' | 'none'
      confirmReason?: string
    }>
    routePlan?: {
      dataSources?: string[]
      clauses?: Array<{ id: string; text: string; agents?: string[] }>
      blueprintDag?: string
      lintIssues?: string[]
      lintSeverity?: string
      judgeRationale?: string
    }
  } | null>
  enabledPlanPreviewCount: ComputedRef<number>
  workbenchMode: Ref<WorkbenchMode>
  collaborationPosture: Ref<CollaborationPosture>
  previewText: (text: string, max?: number) => string
  planAgentLabel: (agent: string) => string
  planPreviewSending: Ref<boolean>
  respondPlanPreview: (action: 'execute' | 'cancel') => void
  planStepsTodo: Ref<PlanStepTodo[]>
  planStepsDoneCount: ComputedRef<number>
  planStepStatusIcon: (status: string) => string
  quickQuestions: Ref<string[]>
  quickCardTitle: (q: string) => string
  onQuickQuestion: (q: string) => void
  sessionSwitching: Ref<boolean>
  visibleTurnGroups: ComputedRef<TurnGroup[]>
  systemEvents: ComputedRef<LogItem[]>
  kindClass: (kind: string) => string
  kindLabel: (kind: string) => string
  dismissError: (item: LogItem) => void
  logEl: Ref<HTMLElement | null>
  input: Ref<string>
  connected: Ref<boolean>
  isRunActive: ComputedRef<boolean>
  sendCancelDisabled: ComputedRef<boolean>
  uploadingAttachment: Ref<boolean>
  pendingAttachment: Ref<PendingAttachment | null>
  setCollaborationPosture: (mode: CollaborationPosture) => void
  lastPostureHint: Ref<{
    reason: string
    suggest?: CollaborationPosture | string
    text: string
  } | null>
  dismissPostureHint: () => void
  onInputKeydown: (e: KeyboardEvent) => void
  onSendOrCancel: () => void
  clearPendingAttachment: () => void
  onFileSelected: (e: Event) => void
  chatComposerRef: Ref<{ resetFileInput: () => void } | null>
}

export const MANAGER_CHAT_RAIL_KEY: InjectionKey<ManagerChatRailContext> = Symbol('managerChatRail')
