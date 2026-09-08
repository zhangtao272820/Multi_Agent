<script setup lang="ts">
import { computed } from 'vue'
import type { SessionHistoryItem, WorkbenchMode } from '~/composables/managerChatTypes'

const props = defineProps<{
  open: boolean
  backdropVisible: boolean
  sessionId: string
  items: SessionHistoryItem[]
  workbenchMode: WorkbenchMode
  formatHistoryTime: (iso: string) => string
}>()

const emit = defineEmits<{
  closeBackdrop: []
  newSession: []
  select: [id: string]
  rename: [item: SessionHistoryItem]
  delete: [id: string]
  setWorkbenchMode: [mode: WorkbenchMode]
}>()

function modeLabel(mode?: WorkbenchMode) {
  if (mode === 'professional') return '专业'
  if (mode === 'chat') return '对话'
  return '未标注'
}

/** 对话/专业分槽：未标注会话跟随当前模式展示，避免串台 */
const visibleItems = computed(() =>
  props.items.filter((item) => !item.workbenchMode || item.workbenchMode === props.workbenchMode)
)

const modeHint = computed(() =>
  props.workbenchMode === 'professional'
    ? '专业工作台 · 独立会话与编排工具'
    : '对话模式 · 轻量聊天，独立会话槽'
)

function onModeClick(mode: WorkbenchMode) {
  emit('setWorkbenchMode', mode)
}
</script>

<template>
  <div
    v-if="open && backdropVisible"
    class="spring-history-backdrop"
    @click="emit('closeBackdrop')"
  />
  <aside class="spring-history-sidebar brand-rail" :class="{ collapsed: !open }" aria-label="历史会话">
    <div class="spring-history-head harness-history-head">
      <div class="harness-rail-brand">
        <img class="harness-rail-logo" src="/brand/logos/manager.svg" alt="" width="28" height="28" />
        <div class="harness-rail-titles">
          <span class="harness-rail-name">天机 · 总管</span>
          <span class="harness-rail-sub">{{ workbenchMode === 'professional' ? '专业工作台' : '对话' }}</span>
        </div>
      </div>
      <button type="button" class="harness-new-session-btn" @click="emit('newSession')">
        + 新会话
      </button>
    </div>

    <div class="spring-history-mode-block">
      <div class="spring-history-mode-row" role="tablist" aria-label="工作台模式">
        <button
          type="button"
          role="tab"
          class="spring-history-mode-btn"
          :class="{ 'is-active': workbenchMode === 'professional' }"
          :aria-selected="workbenchMode === 'professional'"
          title="专业模式：PU-Stack 编排工作台"
          @click="onModeClick('professional')"
        >
          专业
        </button>
        <button
          type="button"
          role="tab"
          class="spring-history-mode-btn"
          :class="{ 'is-active': workbenchMode === 'chat' }"
          :aria-selected="workbenchMode === 'chat'"
          title="对话模式：网页聊天（独立会话槽）"
          @click="onModeClick('chat')"
        >
          对话
        </button>
      </div>
      <p class="spring-history-mode-hint" :key="workbenchMode">{{ modeHint }}</p>
    </div>

    <div class="spring-history-section-label">
      工作区
      <span class="spring-history-count">{{ visibleItems.length }}</span>
    </div>

    <div v-if="!visibleItems.length" class="spring-history-empty">
      {{
        workbenchMode === 'professional'
          ? '暂无专业会话。发送消息后会自动保存到本工作区。'
          : '暂无对话会话。切换到对话模式后发送消息会保存在此。'
      }}
    </div>
    <ul v-else class="spring-history-list">
      <li
        v-for="item in visibleItems"
        :key="item.id"
        class="spring-history-row"
        :class="{ active: item.id === sessionId }"
      >
        <button
          type="button"
          class="spring-history-item brand-nav-item"
          :class="{ 'is-active': item.id === sessionId }"
          :title="item.title"
          @click="emit('select', item.id)"
        >
          <span class="spring-history-item-title-row">
            <span
              class="spring-history-mode-badge"
              :class="item.workbenchMode === 'professional' ? 'is-pro' : item.workbenchMode === 'chat' ? 'is-chat' : 'is-untagged'"
            >{{ modeLabel(item.workbenchMode) }}</span>
            <span class="spring-history-item-title">{{ item.title }}</span>
          </span>
          <span class="spring-history-item-meta">{{ formatHistoryTime(item.updatedAt) }} · {{ item.userMessageCount }} 轮</span>
        </button>
        <div class="spring-history-item-actions">
          <button type="button" class="spring-history-action-btn" title="重命名" @click.stop="emit('rename', item)">
            重命名
          </button>
          <button type="button" class="spring-history-action-btn danger" title="删除" @click.stop="emit('delete', item.id)">
            删除
          </button>
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.harness-rail-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.harness-rail-logo {
  flex: 0 0 auto;
  border-radius: 8px;
}

.harness-rail-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}

.harness-rail-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--brand-ink, #0f172a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.harness-rail-sub {
  font-size: 11px;
  font-weight: 500;
  color: var(--brand-text-muted, #64748b);
}

.spring-history-mode-hint {
  margin: 8px 2px 0;
  padding: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--brand-text-muted, #64748b);
  animation: harness-mode-hint-in 0.28s var(--brand-ease, ease);
}

@keyframes harness-mode-hint-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.spring-history-count {
  margin-left: 6px;
  font-weight: 600;
  color: var(--brand-text-muted, #94a3b8);
  letter-spacing: 0;
  text-transform: none;
}
</style>
