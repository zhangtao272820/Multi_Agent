<script setup lang="ts">
import { computed } from 'vue'
import type { ThoughtViewMode, WorkbenchMode } from '~/composables/managerChatTypes'

const props = defineProps<{
  connected: boolean
  currentRunId: string
  livePhaseText: string
  routeCapLive: { intent: string; agents: string[]; capLabel?: string } | null
  planStepsTodo: Array<{ status: string }>
  planStepsDoneCount: number
  currentPhase: string
  collabStatusItems: Array<{
    agent: string
    short: string
    label: string
    status: string
    preview?: string
  }>
  stepProgressLine: string
  activeTraceId: string
  conversationCompactLive: {
    compacted: boolean
    fullChars?: number
    compactChars?: number
    savedRatio?: number
    turns?: number
  } | null
  workbenchMode: WorkbenchMode
  thoughtViewMode: ThoughtViewMode
  historyPanelOpen: boolean
  sidebarOpen: boolean
  toolsBadgeCount: number
  planAgentLabel: (agent: string) => string
  collabStatusShort: (status: string) => string
}>()

const isProfessional = computed(() => props.workbenchMode === 'professional')

const compactBadgeTitle = computed(() => {
  const c = props.conversationCompactLive
  if (!c?.compacted) return '上下文已压缩'
  const ratio = typeof c.savedRatio === 'number' ? Math.round(c.savedRatio * 100) : null
  const parts = ['上下文已压缩']
  if (ratio != null) parts.push(`约省 ${ratio}%`)
  if (c.fullChars != null && c.compactChars != null) parts.push(`${c.fullChars}→${c.compactChars} 字`)
  return parts.join(' · ')
})

const emit = defineEmits<{
  setThoughtViewMode: [mode: ThoughtViewMode]
  toggleHistory: []
  toggleSidebar: []
  openTraceDrawer: []
}>()
</script>

<template>
  <header class="spring-topbar cosmic-bridge-header" :class="isProfessional ? 'is-pro-header' : 'is-chat-header'">
    <div class="spring-topbar-main">
      <h1 class="spring-title">{{ isProfessional ? '天机 · 总管' : '天机 · 对话' }}</h1>
      <div v-if="isProfessional" class="spring-phase conv-phase-rail" aria-label="执行阶段">
        <div class="conv-phase-track">
          <div class="conv-live-bar" :class="{ active: !!currentRunId }">
            <span class="conv-live-dot" aria-hidden="true"></span>
            <span class="conv-live-label">{{ livePhaseText }}</span>
            <span v-if="routeCapLive?.agents?.length && currentRunId" class="conv-live-route" :title="routeCapLive.capLabel">
              {{ routeCapLive.agents.map((a) => planAgentLabel(a)).join(' · ') }}
            </span>
            <span v-if="planStepsTodo.length && currentRunId" class="conv-live-plan">{{ planStepsDoneCount }}/{{ planStepsTodo.length }} 步</span>
            <span
              v-if="conversationCompactLive?.compacted"
              class="conv-live-compact"
              :title="compactBadgeTitle"
            >已压缩</span>
          </div>
          <div class="conv-phase-badges" aria-hidden="false">
            <div class="badge" :class="{ active: currentPhase === 'route' }">理解</div>
            <div class="badge" :class="{ active: currentPhase === 'planner' || currentPhase === 'plan_preview' }">计划</div>
            <div class="badge" :class="{ active: currentPhase?.startsWith('execute') }">执行</div>
            <div class="badge" :class="{ active: currentPhase === 'synth' || currentPhase === 'synth_stream' || currentPhase === 'critic' }">回答</div>
            <div class="badge" :class="{ active: currentPhase === 'finalize' }">完成</div>
          </div>
        </div>
      </div>
    </div>
    <div class="spring-topbar-actions">
      <template v-if="isProfessional">
        <div class="spring-collab-compact" title="固定协作：清洗 / 可视化 / 报告">
          <span
            v-for="item in collabStatusItems"
            :key="item.agent"
            class="collab-mini"
            :class="`is-${item.status}`"
            :title="item.preview ? `${item.label}：${item.preview}` : item.label"
          >
            {{ item.short }}·{{ collabStatusShort(item.status) }}
          </span>
        </div>
        <div v-if="stepProgressLine" class="spring-step-progress" :title="stepProgressLine">
          {{ stepProgressLine }}
        </div>
        <button
          v-if="activeTraceId"
          type="button"
          class="spring-trace-id spring-trace-id-btn"
          :title="`打开排障 Trace：${activeTraceId}`"
          @click="emit('openTraceDrawer')"
        >
          trace {{ activeTraceId.slice(0, 8) }}
        </button>
        <div class="spring-seg spring-thought-view-toggle" role="group" aria-label="思考过程展示">
          <button type="button" :class="{ 'is-active': thoughtViewMode === 'user' }" title="用户视图：自然语言描述进展" @click="emit('setThoughtViewMode', 'user')">
            用户
          </button>
          <button
            type="button"
            :class="{ 'is-active': thoughtViewMode === 'developer' }"
            title="开发视图：编排诊断、Agent 追踪与原始日志"
            @click="emit('setThoughtViewMode', 'developer')"
          >
            开发
          </button>
        </div>
      </template>
      <div class="spring-seg spring-seg-actions" role="group" aria-label="会话与侧栏">
        <button type="button" class="spring-seg-btn" :class="{ 'is-active': historyPanelOpen }" @click="emit('toggleHistory')">
          历史
        </button>
        <button
          v-if="isProfessional"
          type="button"
          class="spring-seg-btn"
          :class="{ 'is-active': sidebarOpen }"
          @click="emit('toggleSidebar')"
        >
          工具
          <span v-if="toolsBadgeCount" class="spring-tools-badge">{{ toolsBadgeCount }}</span>
        </button>
      </div>
      <span class="spring-conn" :class="{ on: connected }">
        <span class="spring-conn-dot" />
        {{ connected ? '已连接' : '未连接' }}
      </span>
    </div>
  </header>

  <div
    v-if="isProfessional"
    class="workbench-mode-banner is-professional"
    role="status"
  >
    <span class="workbench-mode-banner-bar" aria-hidden="true" />
    <div class="workbench-mode-banner-text">
      <span class="workbench-mode-banner-label">专业工作台</span>
      <span class="workbench-mode-banner-desc">领域任务：PU-Stack 读题 → 冻结 cap → 分步执行</span>
    </div>
  </div>
</template>
