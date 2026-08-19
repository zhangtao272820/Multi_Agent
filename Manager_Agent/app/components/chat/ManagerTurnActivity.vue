<script setup lang="ts">
import type { CollaborationPosture, TurnGroup, WorkbenchMode } from '~/composables/managerChatTypes'
import { collaborationPostureLabel } from '~/composables/managerChatTypes'
import { agentDisplayLabel, agentToneClass } from '~/composables/managerAgentDisplay'
import {
  buildTurnActivityItems,
  type PipelineStepLike,
  type TurnActivityItem
} from '~/utils/turnActivity'
import { computed } from 'vue'

const props = defineProps<{
  turn: TurnGroup
  workbenchMode: WorkbenchMode
  running: boolean
  steps: PipelineStepLike[]
  doneCount: number
  routeAgents?: string[]
  posture?: CollaborationPosture
  postureNote?: string
  suggestedPosture?: CollaborationPosture | string
  awaitingPlanConfirm?: boolean
  planStepCount?: number
  hitlTitle?: string
  hitlAgent?: string
  /** 用户气泡已有姿态徽章 */
  hasUserPostureBadge?: boolean
  /** 专业模式任务要点 */
  clauseTexts?: string[]
  statusLabel: (status: string) => string
}>()

const professional = computed(() => props.workbenchMode === 'professional')

const items = computed(() =>
  buildTurnActivityItems({
    turn: props.turn,
    workbenchMode: props.workbenchMode,
    steps: props.steps,
    routeAgents: props.routeAgents,
    posture: props.posture,
    postureNote: props.postureNote,
    suggestedPosture: props.suggestedPosture,
    awaitingPlanConfirm: props.awaitingPlanConfirm,
    planStepCount: props.planStepCount,
    hitlTitle: props.hitlTitle,
    hitlAgent: props.hitlAgent,
    skipUserPostureBadge: props.hasUserPostureBadge
  })
)

const show = computed(() => items.value.length > 0 || props.steps.length > 0)

const progressPct = computed(() => {
  if (!props.steps.length) return 0
  return Math.round((props.doneCount / props.steps.length) * 100)
})

function itemKindLabel(item: TurnActivityItem): string {
  if (item.kind === 'posture') return '模式'
  if (item.kind === 'plan') return '计划'
  if (item.kind === 'route') return '路由'
  if (item.kind === 'step') return '步骤'
  if (item.kind === 'hitl') return '确认'
  return ''
}
</script>

<template>
  <div
    v-if="show"
    class="turn-activity chat-agent-stack"
    :class="{
      'is-running': running,
      'is-compact': !professional,
      'is-professional': professional
    }"
    aria-label="活动时间线"
  >
    <div class="turn-activity-inner">
      <header class="turn-activity-head">
        <span class="turn-activity-icon" aria-hidden="true">⬡</span>
        <span class="turn-activity-title">{{ professional ? '活动' : '进展' }}</span>
        <span
          v-if="posture"
          class="pipeline-posture-badge"
          :class="`is-${posture}`"
        >{{ collaborationPostureLabel(posture) }}</span>
        <span v-if="steps.length" class="turn-activity-count">{{ doneCount }}/{{ steps.length }} 步</span>
        <span v-if="running" class="turn-activity-live">进行中</span>
      </header>

      <!-- Cursor 式进度条：步骤完成度 -->
      <div v-if="steps.length" class="turn-activity-progress" aria-hidden="true">
        <div class="turn-activity-progress-track">
          <div
            class="turn-activity-progress-fill"
            :class="{ 'is-running': running }"
            :style="{ width: `${Math.max(running && progressPct < 8 ? 8 : progressPct, 0)}%` }"
          />
        </div>
      </div>

      <ul class="turn-activity-list" :class="{ 'is-compact': !professional }">
        <li
          v-for="item in items"
          :key="item.id"
          class="turn-activity-item"
          :class="[
            `kind-${item.kind}`,
            item.status ? `is-${item.status}` : '',
            item.agentTone || (item.agent ? agentToneClass(item.agent) : '')
          ]"
        >
          <span class="turn-activity-kind" aria-hidden="true">{{ itemKindLabel(item) }}</span>
          <div class="turn-activity-body">
            <div class="turn-activity-item-head">
              <span class="turn-activity-item-title">{{ item.title }}</span>
              <span v-if="item.status" class="turn-activity-status">{{ statusLabel(item.status) }}</span>
            </div>
            <p v-if="item.detail && professional" class="turn-activity-detail">{{ item.detail }}</p>
            <div
              v-if="item.kind === 'route' && item.agents?.length"
              class="turn-activity-route-flow"
              :class="{ 'is-compact': !professional }"
            >
              <span
                v-for="(a, ai) in item.agents"
                :key="`flow-${a}-${ai}`"
                class="turn-agent-route-node"
                :class="agentToneClass(a)"
              >
                <span class="turn-agent-route-label">{{ agentDisplayLabel(a, professional) }}</span>
                <span
                  v-if="ai < (item.agents!.length - 1)"
                  class="turn-agent-route-arrow"
                  aria-hidden="true"
                >→</span>
              </span>
            </div>
          </div>
        </li>
      </ul>

      <div v-if="professional && clauseTexts?.length" class="turn-agent-clauses">
        <div class="turn-agent-clauses-title">任务要点</div>
        <ul class="turn-agent-clause-list">
          <li v-for="(text, ci) in clauseTexts" :key="`clause-${ci}`">
            <span class="turn-agent-clause-text">{{ text }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
