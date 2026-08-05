<script setup lang="ts">
import { inject } from "vue";
import { DbChatKey } from "./context";

const chat = inject(DbChatKey)!;
const {
  historyPanelOpen,
  sessionHistoryItems,
  conversationId,
  formatHistoryTime,
  newSession,
  switchSession,
  renameSessionHistory,
  deleteSessionHistory,
} = chat;
</script>

<template>
  <aside class="db-history-aside" :class="{ open: historyPanelOpen }" aria-label="历史会话">
    <div class="db-history-inner">
      <div class="db-chat-toolbar">
        <span class="db-chat-toolbar-title">历史会话</span>
        <button type="button" class="db-toolbar-btn" @click="newSession">新会话</button>
      </div>
      <div v-if="!sessionHistoryItems.length" class="brand-empty">
        暂无历史记录，发送消息后会自动保存。
      </div>
      <ul v-else class="db-history-list">
        <li
          v-for="item in sessionHistoryItems"
          :key="item.id"
          class="db-history-row"
          :class="{ active: item.id === conversationId }"
        >
          <button type="button" class="db-history-item" :title="item.title" @click="switchSession(item.id)">
            <span class="db-history-item-title">{{ item.title }}</span>
            <span class="db-history-item-meta">
              {{ formatHistoryTime(item.updatedAt) }} · {{ item.userMessageCount }} 轮
            </span>
          </button>
          <div class="db-history-item-actions">
            <button type="button" class="db-history-action-btn" title="重命名" @click.stop="renameSessionHistory(item)">
              重命名
            </button>
            <button type="button" class="db-history-action-btn danger" title="删除" @click.stop="deleteSessionHistory(item.id)">
              删除
            </button>
          </div>
        </li>
      </ul>
    </div>
  </aside>
</template>
