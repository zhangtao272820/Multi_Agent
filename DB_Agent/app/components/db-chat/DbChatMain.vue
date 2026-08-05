<script setup lang="ts">
import { inject } from "vue";
import AppModal from "~/components/AppModal.vue";
import { DbChatKey } from "./context";

const chat = inject(DbChatKey)!;
const {
  historyPanelOpen,
  conversationId,
  newSession,
  sessionSwitching,
  appModal,
  onAppModalConfirm,
  onAppModalCancel,
  messages,
  chatContainer,
  loading,
  editingTurnId,
  editDraft,
  copyAckTurnId,
  processSteps,
  isTurnRunning,
  isProcessExpanded,
  toggleProcessPanel,
  copyMessageText,
  cancelEditTurn,
  submitEditResend,
  startEditTurn,
  withdrawTurn,
  regenerateTurn,
  turnFeedbackSubmitted,
  turnFeedbackAckText,
  feedbackSendingUserIndex,
  feedbackUserIndexForMessage,
  applyClarificationChip,
  sendFeedback,
  tierLabel,
  isFastReuseMeta,
  primaryPathLabel,
  primaryBadgeClass,
  domainLabel,
  input,
  inputEl,
  useStream,
  onSendOrCancel,
  onInputKeydown,
  currentTraceUrl,
  isSharing,
  shareRun,
} = chat;
</script>

<template>
  <section class="chat">
    <div class="db-chat-toolbar">
      <span class="db-chat-toolbar-title">
        会话 {{ conversationId ? conversationId.slice(0, 10) + '…' : '未开始' }}
      </span>
      <div style="display: flex; gap: 6px;">
        <button
          type="button"
          class="db-toolbar-btn"
          :class="{ active: historyPanelOpen }"
          @click="historyPanelOpen = !historyPanelOpen"
        >
          历史
        </button>
        <button type="button" class="db-toolbar-btn" @click="newSession">新会话</button>
      </div>
    </div>

    <AppModal
      v-model="appModal.open"
      :mode="appModal.mode"
      :title="appModal.title"
      :message="appModal.message"
      :input-value="appModal.inputValue"
      :input-placeholder="appModal.inputPlaceholder"
      @confirm="onAppModalConfirm"
      @cancel="onAppModalCancel"
    />

    <div v-if="sessionSwitching" class="db-chat-loading messages">
      <span class="db-chat-loading-dot" aria-hidden="true"></span>
      <span>正在加载会话…</span>
    </div>

    <div v-else ref="chatContainer" class="messages">
      <div v-if="messages.length === 0" class="brand-empty empty">
        <p class="db-empty-lead">谷雨 · 用自然语言查库</p>
        <p class="db-empty-hint">例如「张三最近一周的健康记录」或「60岁以上住在北京的男性」</p>
      </div>
      <div
        v-for="(m, idx) in messages"
        :key="m.turnId != null ? `turn-${m.turnId}-${m.role}` : `msg-${idx}`"
        class="message"
        :class="m.role"
      >
        <div class="role">{{ m.role === 'user' ? '你' : '助手' }}</div>

        <template v-if="m.role === 'user'">
          <div v-if="editingTurnId === m.turnId" class="user-edit-wrap">
            <textarea v-model="editDraft" rows="3" class="user-edit-input" placeholder="编辑后重发…" />
            <div class="message-actions message-actions-user">
              <button type="button" class="msg-action-btn" @click="cancelEditTurn">取消</button>
              <button type="button" class="msg-action-btn msg-action-primary" @click="submitEditResend(m)">重发</button>
            </div>
          </div>
          <div v-else class="content db-answer-main">{{ m.content }}</div>
          <div v-if="m.turnId && m.turnId > 0 && editingTurnId !== m.turnId" class="message-actions message-actions-user">
            <button v-if="m.content?.trim()" type="button" class="msg-action-btn" @click="copyMessageText(m.content, m.turnId)">
              {{ copyAckTurnId === m.turnId ? '已复制' : '复制' }}
            </button>
            <button type="button" class="msg-action-btn" :disabled="loading" @click="startEditTurn(m)">编辑</button>
            <button type="button" class="msg-action-btn" :disabled="isTurnRunning(m.turnId)" @click="m.turnId != null && withdrawTurn(m.turnId)">
              撤回
            </button>
            <button
              v-if="typeof m.userMessageIndex === 'number'"
              type="button"
              class="msg-action-btn"
              :disabled="loading || isTurnRunning(m.turnId)"
              @click="regenerateTurn(m)"
            >
              重新生成
            </button>
          </div>
        </template>

        <div v-if="m.role === 'assistant' && processSteps(m).length" class="db-process-panel">
          <button type="button" class="db-process-toggle" @click="toggleProcessPanel(m.turnId)">
            <span class="db-process-dot" :style="{ animation: isTurnRunning(m.turnId) ? 'pulse 2s infinite' : undefined }"></span>
            <span>{{ isTurnRunning(m.turnId) ? '思考中' : '思考过程' }}</span>
            <span class="db-process-count">{{ processSteps(m).length }} 步</span>
            <span class="db-process-chevron">{{ isProcessExpanded(m) ? '▾' : '▸' }}</span>
          </button>
          <div v-if="isProcessExpanded(m)" class="db-process-steps">
            <div
              v-for="(step, si) in processSteps(m)"
              :key="step.at != null ? `p-${step.at}` : `p-${si}`"
              :class="['db-process-step', `kind-${step.kind}`]"
            >
              <span class="db-process-dot"></span>
              <span class="db-process-text">{{ step.text }}</span>
            </div>
          </div>
        </div>

        <div
          v-if="m.role === 'assistant'"
          class="content db-answer-main"
          :class="{ 'is-streaming': loading && isTurnRunning(m.turnId) }"
        >{{ m.content }}</div>

        <div v-if="m.role === 'assistant' && m.meta" class="run-meta">
          <div v-if="m.meta.needs_clarification" class="run-meta-clarify-block">
            <div class="run-meta-title">需要您补充信息</div>
            <p v-if="m.meta.clarification_question" class="run-meta-clarify-hint">{{ m.meta.clarification_question }}</p>
            <div v-if="m.meta.clarification_suggestions?.length" class="clarify-chips">
              <button
                v-for="(chip, ci) in m.meta.clarification_suggestions"
                :key="ci"
                type="button"
                class="clarify-chip"
                :disabled="loading"
                @click="applyClarificationChip(m, chip)"
              >
                {{ chip }}
              </button>
            </div>
          </div>
          <template v-else>
            <div class="run-meta-lite">
              <span class="run-meta-badge" :class="primaryBadgeClass(m.meta)" :title="m.meta.route_reason || undefined">
                {{ primaryPathLabel(m.meta) }}
              </span>
              <span v-if="tierLabel(m.meta.query_tier) && !isFastReuseMeta(m.meta)" class="run-meta-badge run-meta-badge-muted">
                {{ tierLabel(m.meta.query_tier) }}
              </span>
              <span v-if="domainLabel(m.meta.data_domain)" class="run-meta-badge run-meta-badge-muted">
                {{ domainLabel(m.meta.data_domain) }}
              </span>
              <span v-if="m.meta.query_ir_used" class="run-meta-badge run-meta-badge-muted">QueryIR</span>
              <span v-if="m.meta.sql_template_direct" class="run-meta-badge run-meta-badge-muted">模板直出</span>
              <span v-if="m.meta.sql_plan_direct" class="run-meta-badge run-meta-badge-muted">合并 SQL</span>
              <span v-if="m.meta.structural_plan_used" class="run-meta-badge run-meta-badge-muted">结构规划</span>
              <span v-if="m.meta.llm_calls != null" class="run-meta-badge run-meta-badge-muted">{{ m.meta.llm_calls }} 次模型调用</span>
              <span v-if="m.meta.task_stack_steps && m.meta.task_stack_steps > 1" class="run-meta-badge run-meta-badge-muted">
                分 {{ m.meta.task_stack_steps }} 步完成
              </span>
            </div>
          </template>
          <div v-if="m.turnId && m.turnId > 0 && m.content?.trim()" class="feedback-row">
            <template v-if="!turnFeedbackSubmitted(m)">
              <button
                type="button"
                class="fb"
                :disabled="feedbackSendingUserIndex === feedbackUserIndexForMessage(m)"
                @click="sendFeedback(m, 1)"
              >回答有帮助</button>
              <button
                type="button"
                class="fb fb-neg"
                :disabled="feedbackSendingUserIndex === feedbackUserIndexForMessage(m)"
                @click="sendFeedback(m, -1)"
              >回答不准确</button>
            </template>
            <p v-else class="db-feedback-ack">{{ turnFeedbackAckText(m) }}</p>
          </div>
        </div>
      </div>
    </div>

    <form class="composer" @submit.prevent="onSendOrCancel">
      <div class="db-input-hint">{{ loading ? 'Esc 或再次点击取消停止' : 'Enter 发送 · Shift+Enter 换行' }}</div>
      <div class="composer-row">
        <textarea
          ref="inputEl"
          v-model="input"
          class="input"
          placeholder="例如：张三最近一周的健康记录；或：60岁以上且住在北京的男性有多少人"
          :disabled="loading"
          rows="3"
          @keydown="onInputKeydown"
        />
        <button class="send db-send-cancel" type="submit" :class="{ 'is-cancel': loading }" :disabled="!loading && !input.trim()">
          {{ loading ? '取消' : '发送' }}
        </button>
      </div>
      <label class="db-stream-toggle">
        <input type="checkbox" v-model="useStream" :disabled="loading" />
        实时显示思考过程
      </label>
    </form>
    <div class="trace" v-if="false">
      <button class="share" v-if="!currentTraceUrl" :disabled="isSharing" @click="shareRun">
        {{ isSharing ? '生成分享链接…' : '分享运行追踪' }}
      </button>
      <a v-else class="share-link" :href="currentTraceUrl ?? undefined" target="_blank" rel="noreferrer">打开追踪</a>
    </div>
  </section>
</template>
