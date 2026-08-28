<script setup lang="ts">
import ManagerChatThread from '~/components/chat/ManagerChatThread.vue'
import ManagerChatComposer from '~/components/chat/ManagerChatComposer.vue'
import ManagerAgentCapabilityMap from '~/components/chat/ManagerAgentCapabilityMap.vue'
import { inject, ref, watch } from 'vue'
import type { CollaborationPosture, TurnGroup } from '~/composables/managerChatTypes'
import { MANAGER_CHAT_RAIL_KEY } from '~/composables/managerChatRailContext'

defineProps<{ turns: TurnGroup[] }>()

const ctx = inject(MANAGER_CHAT_RAIL_KEY)
if (!ctx) throw new Error('ManagerChatRail: missing context')

const {
  pendingPlanPreview,
  enabledPlanPreviewCount,
  workbenchMode,
  collaborationPosture,
  previewText,
  planAgentLabel,
  planPreviewSending,
  respondPlanPreview,
  planStepsTodo,
  planStepsDoneCount,
  planStepStatusIcon,
  quickQuestions,
  quickCardTitle,
  onQuickQuestion,
  sessionSwitching,
  visibleTurnGroups,
  systemEvents,
  kindClass,
  kindLabel,
  dismissError,
  logEl,
  input,
  connected,
  isRunActive,
  sendCancelDisabled,
  uploadingAttachment,
  pendingAttachment,
  setCollaborationPosture,
  lastPostureHint,
  dismissPostureHint,
  onInputKeydown,
  onSendOrCancel,
  clearPendingAttachment,
  onFileSelected,
  onAttachmentFile
} = ctx
const chatComposerRef = ctx.chatComposerRef

const localLogEl = ref<HTMLElement | null>(null)
watch(localLogEl, (el) => {
  logEl.value = el
})
</script>

<template>
  <div class="chat-rail-stack" :class="{ 'has-plan-preview': !!pendingPlanPreview }">
    <div
      v-if="lastPostureHint"
      class="posture-gate-card"
      :class="{
        'is-ask': String(lastPostureHint.reason || '').includes('write') || lastPostureHint.reason === 'ask_read_only',
        'is-compact': workbenchMode === 'chat'
      }"
      role="status"
    >
      <span class="posture-gate-card-title">{{ workbenchMode === 'chat' ? '姿态提示' : '协作姿态门禁' }}</span>
      <p>{{ lastPostureHint.text }}</p>
      <div class="conv-plan-preview-actions" style="margin-top: 8px; border: none; padding: 0">
        <button
          v-if="lastPostureHint.suggest"
          type="button"
          class="spring-btn spring-btn-sm"
          @click="setCollaborationPosture(String(lastPostureHint.suggest) as CollaborationPosture)"
        >
          切换到 {{ String(lastPostureHint.suggest) }}
        </button>
        <button type="button" class="spring-btn alt spring-btn-sm" @click="dismissPostureHint">知道了</button>
      </div>
    </div>

    <div
      v-if="pendingPlanPreview"
      class="conv-plan-preview cursor-plan-card plan-mode-card"
      :class="{
        'is-professional-plan': workbenchMode === 'professional',
        'is-tier-strict': pendingPlanPreview.approveTier === 'strict',
        'is-tier-plan': pendingPlanPreview.approveTier !== 'strict'
      }"
      role="dialog"
      aria-label="计划确认"
    >
      <div class="conv-plan-preview-head">
        <div class="plan-mode-title-row">
          <span class="plan-mode-badge">Plan Mode</span>
          <strong>{{ workbenchMode === 'professional' ? '诊断&执行计划' : '确认执行蓝图' }}</strong>
        </div>
        <div class="plan-mode-meta-row">
          <span
            v-if="pendingPlanPreview.approveTier === 'strict'"
            class="plan-mode-risk-chip is-high"
            >高风险审核</span
          >
          <span v-else class="plan-mode-risk-chip is-normal">协作确认</span>
          <span v-if="pendingPlanPreview.riskScore" class="plan-mode-risk-score"
            >风险 {{ Math.round((pendingPlanPreview.riskScore || 0) * 100) }}%</span
          >
          <span class="conv-plan-preview-meta"
            >{{ enabledPlanPreviewCount }}/{{ pendingPlanPreview.steps.length }} 步</span
          >
        </div>
        <div class="plan-mode-progress" aria-hidden="true">
          <div class="plan-mode-progress-track">
            <div
              class="plan-mode-progress-fill"
              :style="{
                width: `${Math.max(
                  8,
                  Math.round((enabledPlanPreviewCount / Math.max(1, pendingPlanPreview.steps.length)) * 100)
                )}%`
              }"
            />
          </div>
        </div>
      </div>
      <div class="conv-plan-preview-body">
        <div v-if="pendingPlanPreview.routePlan" class="conv-route-plan-block">
          <div class="conv-route-plan-row">
            <span class="conv-route-plan-label">数据面</span>
            <span class="conv-route-plan-value">{{ pendingPlanPreview.routePlan.dataSources?.join(' + ') || '—' }}</span>
          </div>
          <div v-if="pendingPlanPreview.routePlan.clauses?.length" class="conv-route-plan-clauses">
            <span class="conv-route-plan-label">子句</span>
            <ul class="conv-route-plan-clause-list">
              <li v-for="c in pendingPlanPreview.routePlan.clauses" :key="c.id">
                <span class="conv-route-clause-id">{{ c.id }}</span>
                {{ previewText(c.text, 100) }}
                <span v-if="c.agents?.length" class="conv-route-clause-agents">→ {{ c.agents.map((a) => planAgentLabel(a)).join('、') }}</span>
              </li>
            </ul>
          </div>
          <div v-if="pendingPlanPreview.routePlan.blueprintDag" class="conv-route-plan-row">
            <span class="conv-route-plan-label">蓝图</span>
            <span class="conv-route-plan-dag">{{ pendingPlanPreview.routePlan.blueprintDag }}</span>
          </div>
          <div v-if="pendingPlanPreview.routePlan.lintIssues?.length" class="conv-route-plan-lint" :class="`is-${pendingPlanPreview.routePlan.lintSeverity || 'warn'}`">
            <span class="conv-route-plan-label">结构检查</span>
            <ul>
              <li v-for="(issue, li) in pendingPlanPreview.routePlan.lintIssues.slice(0, 4)" :key="li">{{ issue }}</li>
            </ul>
          </div>
          <p v-if="pendingPlanPreview.routePlan.judgeRationale" class="conv-route-plan-judge">{{ previewText(pendingPlanPreview.routePlan.judgeRationale, 160) }}</p>
        </div>
        <p v-if="pendingPlanPreview.hint" class="conv-plan-preview-hint">{{ pendingPlanPreview.hint }}</p>
        <label class="conv-plan-preview-constraints">
          <span class="conv-plan-preview-constraints-label">补充约束（可选）</span>
          <textarea
            v-model="pendingPlanPreview.constraints"
            class="conv-plan-preview-constraints-input"
            rows="2"
            maxlength="500"
            placeholder="例如：只用正式制度、不要发邮件、优先库表…"
            :disabled="planPreviewSending"
          />
        </label>
        <ol class="conv-plan-preview-list">
          <li
            v-for="(step, si) in pendingPlanPreview.steps"
            :key="step.id"
            class="conv-plan-preview-item"
            :class="{ 'is-disabled': !step.enabled }"
          >
            <span class="plan-step-index" aria-hidden="true">{{ si + 1 }}</span>
            <label class="conv-plan-preview-check">
              <input v-model="step.enabled" type="checkbox" :disabled="planPreviewSending" />
              <span class="conv-plan-preview-agent">{{ step.agentLabel || planAgentLabel(step.agent) }}</span>
              <span v-if="step.optional" class="conv-plan-preview-optional">可选</span>
              <span
                v-if="step.confirmMode === 'hitl'"
                class="conv-plan-preview-confirm is-hitl"
                :title="step.confirmReason || '执行前需人工确认'"
                >人审</span
              >
              <span
                v-else-if="step.confirmMode === 'auto_confirm'"
                class="conv-plan-preview-confirm is-auto"
                :title="step.confirmReason || '策略允许自动确认'"
                >自动确认</span
              >
            </label>
            <textarea
              v-model="step.query"
              class="conv-plan-preview-query-edit"
              rows="3"
              maxlength="2000"
              :disabled="planPreviewSending || !step.enabled"
              :placeholder="`${planAgentLabel(step.agent)}任务描述`"
            />
          </li>
        </ol>
      </div>
      <div class="conv-plan-preview-actions">
        <button type="button" class="spring-btn alt spring-btn-sm hitl-btn" :disabled="planPreviewSending" @click="respondPlanPreview('cancel')">
          取消
        </button>
        <button type="button" class="spring-btn spring-btn-sm plan-mode-primary hitl-btn" :disabled="planPreviewSending || enabledPlanPreviewCount < 1" @click="respondPlanPreview('execute')">
          {{ planPreviewSending ? '提交中…' : '确认并执行' }}
        </button>
      </div>
    </div>

    <div v-else-if="planStepsTodo.length" class="spring-plan-todo conv-plan-panel cursor-plan-rail run-todo-panel" aria-label="执行计划">
      <div class="spring-plan-todo-head conv-plan-head">
        <div class="run-todo-title-wrap">
          <span class="spring-plan-todo-title">本轮进度</span>
          <div class="run-todo-progress-track" aria-hidden="true">
            <div
              class="run-todo-progress-fill"
              :style="{ width: `${planStepsTodo.length ? Math.round((planStepsDoneCount / planStepsTodo.length) * 100) : 0}%` }"
            />
          </div>
        </div>
        <span class="spring-plan-todo-count">{{ planStepsDoneCount }}/{{ planStepsTodo.length }}</span>
      </div>
      <ol class="spring-plan-todo-list">
        <li
          v-for="(step, si) in planStepsTodo"
          :key="step.id"
          class="spring-plan-todo-item"
          :class="`is-${step.status}`"
          :title="step.query"
        >
          <span class="run-todo-index" aria-hidden="true">{{ si + 1 }}</span>
          <span class="spring-plan-todo-check" aria-hidden="true">{{ planStepStatusIcon(step.status) }}</span>
          <span class="spring-plan-todo-agent">{{ planAgentLabel(step.agent) }}</span>
          <span v-if="step.optional" class="spring-plan-todo-optional">可选</span>
          <span class="spring-plan-todo-query">{{ previewText(step.query, 88) }}</span>
          <span class="spring-plan-todo-status">{{
            step.status === 'running'
              ? '进行中'
              : step.status === 'success'
                ? '完成'
                : step.status === 'failed'
                  ? '失败'
                  : step.status === 'skipped'
                    ? '已跳过'
                    : '待执行'
          }}</span>
        </li>
      </ol>
    </div>

    <details v-if="!pendingPlanPreview" class="spring-examples cosmic-examples-strip">
      <summary class="spring-examples-summary">✦ 快捷示例（{{ quickQuestions.length }}）</summary>
      <div class="spring-quick-start">
        <button
          v-for="(q, i) in quickQuestions"
          :key="i"
          type="button"
          class="quick-card"
          :title="q"
          @click="onQuickQuestion(q)"
        >
          <span class="quick-card-title">{{ quickCardTitle(q) }}</span>
        </button>
      </div>
    </details>

    <div class="cosmic-chat-stage cosmic-hud-shell">
      <div class="spring-log cosmic-panel cosmic-hud-panel chat-scroll" ref="localLogEl">
        <div v-if="sessionSwitching" class="cosmic-chat-empty cosmic-chat-empty-compact">
          <span class="cosmic-chat-empty-icon cosmic-chat-loading" aria-hidden="true">◌</span>
          <p class="cosmic-chat-empty-title">正在加载会话…</p>
        </div>
        <div v-else-if="!visibleTurnGroups.length && !systemEvents.length" class="cosmic-chat-empty">
          <span class="cosmic-chat-empty-icon" aria-hidden="true">{{ workbenchMode === 'professional' ? '⚡' : '✦' }}</span>
          <p class="cosmic-chat-empty-title">{{ workbenchMode === 'professional' ? '专业工作台就绪' : '开始对话' }}</p>
          <p class="cosmic-chat-empty-hint">
            {{ workbenchMode === 'professional'
              ? '输入领域任务，总管将读题分析、冻结能力集合并分步编排执行；进展会显示在下方活动时间线与「正在思考」面板。'
              : '像成熟 Agent 一样：下方切换 Ask / Plan / Agent / Debug；总管会按姿态调度专才。' }}
          </p>
          <div class="empty-posture-tips" aria-label="协作姿态说明">
            <span class="empty-posture-chip is-ask">Ask 只读</span>
            <span class="empty-posture-chip is-plan">Plan 先批蓝图</span>
            <span class="empty-posture-chip is-agent">Agent 自主</span>
            <span class="empty-posture-chip is-debug">Debug 重验</span>
          </div>
          <ManagerAgentCapabilityMap
            class="empty-cap-map"
            density="compact"
            title="可调度专才"
          />
        </div>
        <div v-else-if="!visibleTurnGroups.length" class="cosmic-chat-empty cosmic-chat-empty-compact">
          <p class="cosmic-chat-empty-title">暂无可见对话</p>
          <p class="cosmic-chat-empty-hint">发送新问题开始对话；若曾撤回全部消息，可直接在下方输入。系统信号见上方折叠区。</p>
        </div>
        <details v-if="systemEvents.length" class="spring-thoughts spring-thoughts-system" :open="!visibleTurnGroups.length">
          <summary>系统信号（{{ systemEvents.length }}）</summary>
          <div class="spring-thoughts-list">
            <div v-for="(m, idx) in systemEvents" :key="idx" class="spring-thoughts-item" :class="kindClass(m.kind)">
              <div class="spring-thoughts-meta">
                <span class="meta-time">{{ m.ts }}</span>
                <span class="meta-pill">{{ kindLabel(m.kind) }}</span>
                <button
                  v-if="String(m.kind).toLowerCase() === 'error'"
                  type="button"
                  class="spring-error-dismiss spring-error-dismiss-inline"
                  aria-label="关闭"
                  @click="dismissError(m)"
                >
                  ×
                </button>
              </div>
              <pre class="spring-thoughts-text" :class="{ 'spring-error-text': String(m.kind).toLowerCase() === 'error' }">{{ m.text }}</pre>
            </div>
          </div>
        </details>

        <ManagerChatThread :turns="turns" />
      </div>
    </div>

    <ManagerChatComposer
      ref="chatComposerRef"
      v-model="input"
      :workbench-mode="workbenchMode"
      :collaboration-posture="collaborationPosture"
      :connected="connected"
      :is-run-active="isRunActive"
      :send-cancel-disabled="sendCancelDisabled"
      :uploading-attachment="uploadingAttachment"
      :pending-attachment="pendingAttachment"
      @set-collaboration-posture="setCollaborationPosture"
      @input-keydown="onInputKeydown"
      @send-or-cancel="onSendOrCancel"
      @clear-attachment="clearPendingAttachment"
      @file-selected="onFileSelected"
      @attachment-file="onAttachmentFile"
    />
  </div>
</template>
