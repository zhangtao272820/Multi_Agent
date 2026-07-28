<script setup lang="ts">
import type { SessionHistoryItem, WorkbenchMode } from '~/composables/managerChatTypes'

defineProps<{
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
</script>

<template>
  <div
    v-if="open && backdropVisible"
    class="spring-history-backdrop"
    @click="emit('closeBackdrop')"
  />
  <aside class="spring-history-sidebar" :class="{ collapsed: !open }" aria-label="历史会话">
    <div class="spring-history-head">
      <span class="spring-history-title">历史会话</span>
      <button type="button" class="spring-btn alt spring-btn-xs" @click="emit('newSession')">新会话</button>
    </div>
    <div class="spring-history-mode-row" role="group" aria-label="工作台模式">
      <button
        type="button"
        class="spring-history-mode-btn"
        :class="{ 'is-active': workbenchMode === 'chat' }"
        title="对话模式：DeepSeek 式网页聊天"
        @click="emit('setWorkbenchMode', 'chat')"
      >
        对话
      </button>
      <button
        type="button"
        class="spring-history-mode-btn"
        :class="{ 'is-active': workbenchMode === 'professional' }"
        title="专业模式：PU-Stack 编排工作台"
        @click="emit('setWorkbenchMode', 'professional')"
      >
        专业
      </button>
    </div>
    <p class="spring-history-mode-hint">
      {{
        workbenchMode === 'professional'
          ? '当前：专业工作台 · 会话与对话互不影响'
          : '当前：普通对话 · 不处理专业编排功能'
      }}
    </p>
    <div v-if="!items.length" class="spring-history-empty">
      {{
        workbenchMode === 'professional'
          ? '暂无历史记录，在专业模式发送消息后会自动保存。'
          : '暂无历史记录，发送消息后会自动保存。'
      }}
    </div>
    <ul v-else class="spring-history-list">
      <li
        v-for="item in items"
        :key="item.id"
        class="spring-history-row"
        :class="{ active: item.id === sessionId }"
      >
        <button type="button" class="spring-history-item" :title="item.title" @click="emit('select', item.id)">
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
