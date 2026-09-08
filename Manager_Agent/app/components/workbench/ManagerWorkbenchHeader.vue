<script setup lang="ts">
import { computed } from 'vue'
import type { WorkbenchMode } from '~/composables/managerChatTypes'

const props = defineProps<{
  connected: boolean
  currentRunId: string
  livePhaseText: string
  routeCapLive: { intent: string; agents: string[]; capLabel?: string } | null
  planStepsTodo: Array<{ status: string }>
  planStepsDoneCount: number
  conversationCompactLive: {
    compacted: boolean
    fullChars?: number
    compactChars?: number
    savedRatio?: number
    turns?: number
  } | null
  workbenchMode: WorkbenchMode
  historyPanelOpen: boolean
  sidebarOpen: boolean
  toolsBadgeCount: number
  planAgentLabel: (agent: string) => string
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
  toggleHistory: []
  toggleSidebar: []
}>()
</script>

<template>
  <header
    class="spring-topbar cosmic-bridge-header harness-slim-header"
    :class="isProfessional ? 'is-pro-header' : 'is-chat-header'"
  >
    <div class="spring-topbar-primary harness-topbar-primary">
      <div class="spring-topbar-main harness-topbar-left">
        <template v-if="!isProfessional">
          <div class="spring-brand-row">
            <img class="spring-brand-logo" src="/brand/logos/manager.svg" alt="" width="28" height="28" />
            <div class="spring-brand-text">
              <h1 class="spring-title">天机 · 对话</h1>
            </div>
          </div>
        </template>
        <div v-else class="harness-live-inline" aria-label="执行状态">
          <span class="harness-live-dot" :class="{ on: !!currentRunId }" aria-hidden="true" />
          <span class="harness-live-label">{{ livePhaseText }}</span>
          <span v-if="routeCapLive?.agents?.length && currentRunId" class="harness-live-meta" :title="routeCapLive.capLabel">
            {{ routeCapLive.agents.map((a) => planAgentLabel(a)).join(' · ') }}
          </span>
          <span v-if="planStepsTodo.length && currentRunId" class="harness-live-meta">
            {{ planStepsDoneCount }}/{{ planStepsTodo.length }} 步
          </span>
          <span
            v-if="conversationCompactLive?.compacted"
            class="harness-live-meta"
            :title="compactBadgeTitle"
          >已压缩</span>
        </div>
      </div>
      <div class="spring-topbar-actions harness-topbar-actions">
        <div class="harness-toolbar-cluster" role="group" aria-label="会话与侧栏">
          <button
            type="button"
            class="harness-toolbar-btn spring-seg-btn"
            :class="{ 'is-active': historyPanelOpen }"
            @click="emit('toggleHistory')"
          >
            历史
          </button>
          <button
            v-if="isProfessional"
            type="button"
            class="harness-toolbar-btn spring-seg-btn"
            :class="{ 'is-active': sidebarOpen }"
            @click="emit('toggleSidebar')"
          >
            工作台
            <span v-if="toolsBadgeCount" class="spring-tools-badge">{{ toolsBadgeCount }}</span>
          </button>
        </div>

        <span class="harness-toolbar-divider" aria-hidden="true" />
        <div class="harness-toolbar-meta">
          <ManagerUserMenu />
          <span class="spring-conn" :class="{ on: connected }" :title="connected ? 'WebSocket 已连接' : 'WebSocket 未连接'">
            <span class="spring-conn-dot" aria-hidden="true" />
            {{ connected ? '已连接' : '未连接' }}
          </span>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.spring-brand-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
  margin: 0;
}

.spring-brand-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  min-width: 0;
  text-align: left;
}

.spring-brand-logo {
  flex: 0 0 auto;
  border-radius: 6px;
}

.harness-live-inline {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
  color: var(--brand-text-muted, #475569);
}

.harness-live-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
  flex: 0 0 auto;
}

.harness-live-dot.on {
  background: var(--brand-accent, #2563eb);
  box-shadow: 0 0 0 3px var(--brand-accent-soft, rgba(37, 99, 235, 0.14));
}

.harness-live-label {
  color: var(--brand-ink, #0f172a);
  font-weight: 600;
  white-space: nowrap;
}

.harness-live-meta {
  color: var(--brand-text-muted, #475569);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
</style>
