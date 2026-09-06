<script setup lang="ts">
import type { CollaborationPosture, TurnGroup, WorkbenchMode } from '~/composables/managerChatTypes'
import { collaborationPostureLabel } from '~/composables/managerChatTypes'
import { agentDisplayLabel, agentToneClass } from '~/composables/managerAgentDisplay'
import {
  buildTurnActivityItems,
  type PipelineStepLike,
  type TurnActivityItem
} from '~/utils/turnActivity'
import { computed, ref, watch } from 'vue'

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

const summaryLabel = computed(() => {
  if (props.running) {
    const n = props.steps.length || items.value.length
    return n > 0 ? `执行面板 · ${n} 步` : '执行面板'
  }
  if (props.steps.length) return `执行面板 · ${props.doneCount}/${props.steps.length}`
  return professional.value ? '执行面板' : '进展'
})

const summaryRouteAgents = computed(() => {
  if (props.routeAgents?.length) return props.routeAgents
  const routeItem = items.value.find((it) => it.kind === 'route' && it.agents?.length)
  return routeItem?.agents || []
})

/** 运行中默认展开；空闲收成摘要行（仍可点开看完整步骤/要点） */
const bodyOpen = ref(false)
watch(
  () => [props.running, props.turn.id] as const,
  ([running]) => {
    bodyOpen.value = Boolean(running)
  },
  { immediate: true }
)

function onBodyToggle(e: Event) {
  bodyOpen.value = Boolean((e.target as HTMLDetailsElement)?.open)
}

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
  <details
    v-if="show"
    class="turn-activity chat-agent-stack"
    :class="{
      'is-running': running,
      'is-compact': !professional,
      'is-professional': professional,
      'is-collapsed': !bodyOpen
    }"
    :open="bodyOpen"
    aria-label="活动时间线"
    @toggle="onBodyToggle"
  >
    <summary class="turn-activity-summary">
      <div class="turn-activity-inner turn-activity-summary-inner">
        <header class="turn-activity-head">
          <span class="turn-activity-icon" aria-hidden="true">⬡</span>
          <span class="turn-activity-title">{{ summaryLabel }}</span>
          <span
            v-if="posture"
            class="pipeline-posture-badge"
            :class="`is-${posture}`"
          >{{ collaborationPostureLabel(posture) }}</span>
          <span v-if="running" class="turn-activity-live">进行中</span>
        </header>
        <div v-if="steps.length" class="turn-activity-progress" aria-hidden="true">
          <div class="turn-activity-progress-track">
            <div
              class="turn-activity-progress-fill"
              :class="{ 'is-running': running }"
              :style="{ width: `${Math.max(running && progressPct < 8 ? 8 : progressPct, 0)}%` }"
            />
          </div>
        </div>
        <!-- 收起时仍可见专才路由，避免「丢了执行面板」的体感 -->
        <div
          v-if="summaryRouteAgents.length"
          class="turn-activity-summary-route turn-activity-route-flow is-compact"
          aria-label="专才路由"
        >
          <span
            v-for="(a, ai) in summaryRouteAgents"
            :key="`sum-${a}-${ai}`"
            class="turn-agent-route-node"
            :class="agentToneClass(a)"
          >
            <span class="turn-agent-route-label">{{ agentDisplayLabel(a, professional) }}</span>
            <span
              v-if="ai < summaryRouteAgents.length - 1"
              class="turn-agent-route-arrow"
              aria-hidden="true"
            >→</span>
          </span>
        </div>
      </div>
    </summary>

    <div class="turn-activity-body-panel">
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
            {{ text }}
          </li>
        </ul>
      </div>
    </div>
  </details>
</template>
