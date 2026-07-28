<script setup lang="ts">
import AmapReplyCards from '~/components/AmapReplyCards.vue'
import CosmicMidiPlayer from '~/components/CosmicMidiPlayer.vue'
import type { TurnGroup } from '~/composables/managerChatTypes'
import { MANAGER_CHAT_THREAD_KEY } from '~/composables/managerChatThreadContext'
import { FEEDBACK_PENDING_ACK } from '~/composables/useManagerSession'
import { inject, nextTick, watch, type ComponentPublicInstance } from 'vue'

defineProps<{ turns: TurnGroup[] }>()

const {
  editingTurnId,
  editDraft,
  currentRunId,
  connected,
  thoughtViewMode,
  streamingSynthText,
  streamingSynthDisplayText,
  copyAckTurnId,
  copyAckKey,
  feedbackSendingRunId,
  expandedProcessKeys,
  streamingReplyEl,
  kindClass,
  kindLabel,
  userBubbleText,
  copyMessageText,
  isTurnRunning,
  isTurnLive,
  startEditTurn,
  cancelEditTurn,
  submitEditResend,
  withdrawTurn,
  regenerateTurn,
  hasAgentPipeline,
  turnAgentPipelineSteps,
  turnAgentPipelineDoneCount,
  turnRouteCap,
  turnCollaborationPosture,
  turnPostureNote,
  planAgentLabel,
  agentPipelineStatusLabel,
  turnRoutePlanCard,
  previewText,
  turnPlanOutline,
  hasThoughtContent,
  thoughtPanelOpen,
  onThoughtPanelToggle,
  thoughtPanelLabel,
  stepResultsForTurn,
  userThoughtNarrative,
  thoughtPanelPreview,
  processStepKey,
  isProcessStepClampable,
  phaseLabel,
  formatProcessText,
  toggleProcessStep,
  isSynthPhaseActive,
  onReplyMarkdownClick,
  renderAssistantMarkdown,
  renderReportMarkdown,
  resultItemClasses,
  resultKindLabel,
  turnSearchSources,
  webSourceHost,
  mediaForReply,
  resolveMediaUrl,
  openMediaInNewTab,
  downloadMediaFile,
  mediaDownloadName,
  adminUiCardsFromTurn,
  replyMarkdownBody,
  replyExecutionSummaryMarkdown,
  replyUserOutcomeBanner,
  replyExecSummaryTone,
  turnExpertFailureCards,
  replyHasInlineAnalytics,
  buildTurnAgentResults,
  extractEchartsOption,
  chartTitleFromText,
  downloadEchartsPng,
  initChartEl,
  chartContainerClass,
  chartContainerStyle,
  extractTableData,
  renderTableDataHtml,
  userFacingChartOption,
  userFacingChartTitle,
  userFacingTableHtml,
  canConfirmActionCard,
  respondActionCardConfirm,
  respondActionCardCancel,
  humanConfirmSending,
  resolveReportBody,
  replyUserDetailAppendix,
  downloadMarkdown,
  replyHasCollapsibleSources,
  replySourceCount,
  replySourcesMarkdown,
  hasMediaContent,
  replyHasAnalytics,
  shouldShowTurnFeedback,
  turnFeedbackSubmitted,
  turnFeedbackKey,
  sendFeedback,
  routeFeedbackSubmitted,
  sendRouteWrongFeedback,
  turnFeedbackAckText,
  visibleTurnErrors,
  errorItemKey,
  dismissError,
  dismissAllTurnErrors
} = inject(MANAGER_CHAT_THREAD_KEY)!

function resolveScrollTarget(el: unknown): HTMLElement | null {
  if (!el) return null
  if (el instanceof HTMLElement) return el
  if (Array.isArray(el)) {
    for (let i = el.length - 1; i >= 0; i--) {
      const hit = resolveScrollTarget(el[i])
      if (hit) return hit
    }
    return null
  }
  return null
}

/** 图表 details 展开后触发 echarts resize，避免收起再展开高度塌成 0 */
function onChartDetailsToggle(ev: Event) {
  const root = ev.currentTarget as HTMLDetailsElement | null
  if (!root?.open) return
  nextTick(() => {
    requestAnimationFrame(() => {
      root.querySelectorAll('.echarts-container').forEach((node) => {
        const inst = (node as HTMLElement & { __chart_inst__?: { resize?: () => void } }).__chart_inst__
        try {
          inst?.resize?.()
        } catch {
          /* ignore */
        }
      })
    })
  })
}

function bindStreamingReplyEl(el: Element | ComponentPublicInstance | null) {
  if (!el) {
    streamingReplyEl.value = null
    return
  }
  if (el instanceof HTMLElement) {
    streamingReplyEl.value = el
    return
  }
  const root = (el as ComponentPublicInstance).$el
  streamingReplyEl.value = root instanceof HTMLElement ? root : null
}

watch(streamingSynthText, async () => {
  if (!streamingSynthText.value) return
  await nextTick()
  const node = resolveScrollTarget(streamingReplyEl.value)
  node?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
})
</script>

<template>
  <div class="chat-thread chat-messenger">
        <div v-for="t in turns" :key="t.id" class="spring-turn">
          <div
            v-if="t.user"
            class="spring-log-item chat-user-row"
            :class="[kindClass(t.user.kind), t.user.from ? `from-${String(t.user.from).toLowerCase()}` : '']"
          >
            <div class="spring-log-bubble cosmic-bubble cosmic-bubble-user" :class="{ 'user-bubble-editing': editingTurnId === t.id }">
              <div class="spring-log-meta">
                <span class="meta-time">{{ t.user.ts }}</span>
                <span class="meta-pill">{{ kindLabel(t.user.kind) }}</span>
                <span
                  v-if="turnCollaborationPosture(t)"
                  class="turn-posture-badge"
                  :class="`is-${turnCollaborationPosture(t)}`"
                  :title="turnPostureNote(t) || turnCollaborationPosture(t)"
                >{{ turnCollaborationPosture(t) }}</span>
              </div>
              <div v-if="t.user.attachmentPreview && t.user.attachmentMediaType === 'image'" class="user-attach-preview">
                <img :src="t.user.attachmentPreview" alt="附件预览" class="user-attach-img" />
              </div>
              <div v-else-if="t.user.attachmentName" class="user-attach-chip">{{ t.user.attachmentName }}</div>
              <div v-if="editingTurnId === t.id" class="user-edit-panel">
                <textarea v-model="editDraft" class="user-edit-textarea" rows="4" placeholder="编辑后重发…" />
                <div class="message-actions">
                  <button type="button" class="message-action-btn message-action-btn-primary" :disabled="!editDraft.trim()" @click="submitEditResend(t)">重发</button>
                  <button type="button" class="message-action-btn" @click="cancelEditTurn">取消</button>
                </div>
              </div>
              <pre v-else-if="userBubbleText(t.user)" class="spring-log-text">{{ userBubbleText(t.user) }}</pre>
              <div v-if="editingTurnId !== t.id" class="message-actions message-actions-user">
                <button
                  v-if="userBubbleText(t.user)"
                  type="button"
                  class="message-action-btn"
                  @click="copyMessageText(userBubbleText(t.user), { turnId: t.id })"
                >
                  {{ copyAckTurnId === t.id ? '已复制' : '复制' }}
                </button>
                <button
                  v-if="userBubbleText(t.user)"
                  type="button"
                  class="message-action-btn"
                  :disabled="isTurnRunning(t) || !!currentRunId"
                  @click="startEditTurn(t)"
                >
                  编辑
                </button>
                <button type="button" class="message-action-btn" :disabled="isTurnRunning(t)" @click="withdrawTurn(t.id)">撤回</button>
                <button
                  v-if="typeof t.user.userMessageIndex === 'number' && userBubbleText(t.user)"
                  type="button"
                  class="message-action-btn"
                  :disabled="!connected || isTurnRunning(t) || !!currentRunId || editingTurnId === t.id"
                  @click="regenerateTurn(t)"
                >
                  重新生成
                </button>
              </div>
            </div>
          </div>

          <!-- Agent 任务编排 · 独立于思考过程，用户可见 -->
          <div
            v-if="hasAgentPipeline(t)"
            class="turn-agent-pipeline chat-agent-stack"
            :class="{ 'is-running': isTurnRunning(t) }"
            aria-label="任务执行"
          >
            <div class="turn-agent-pipeline-inner">
              <header class="turn-agent-pipeline-head">
                <span class="turn-agent-pipeline-icon" aria-hidden="true">⬡</span>
                <span class="turn-agent-pipeline-title">任务执行</span>
                <span
                  v-if="turnCollaborationPosture(t)"
                  class="pipeline-posture-badge"
                  :class="`is-${turnCollaborationPosture(t)}`"
                >{{ turnCollaborationPosture(t) }}</span>
                <span v-if="turnAgentPipelineSteps(t).length" class="turn-agent-pipeline-count"
                  >{{ turnAgentPipelineDoneCount(t) }}/{{ turnAgentPipelineSteps(t).length }} 步</span
                >
                <span v-if="isTurnRunning(t)" class="turn-agent-pipeline-live">进行中</span>
              </header>
              <p v-if="turnPostureNote(t)" class="turn-posture-note" role="status">{{ turnPostureNote(t) }}</p>

              <div v-if="turnRouteCap(t)?.agents?.length" class="turn-agent-route-flow">
                <span
                  v-for="(a, ai) in turnRouteCap(t)!.agents"
                  :key="`flow-${a}`"
                  class="turn-agent-route-node"
                  :class="`agent-tone-${String(a).toLowerCase()}`"
                >
                  <span class="turn-agent-route-label">{{ planAgentLabel(a) }}</span>
                  <span v-if="ai < (turnRouteCap(t)!.agents.length - 1)" class="turn-agent-route-arrow" aria-hidden="true">→</span>
                </span>
              </div>

              <ol class="turn-agent-step-list">
                <li
                  v-for="(step, si) in turnAgentPipelineSteps(t)"
                  :key="step.id"
                  class="turn-agent-step"
                  :class="[`is-${step.status}`, `agent-tone-${step.agent}`]"
                >
                  <span class="turn-agent-step-marker" aria-hidden="true">
                    <span class="turn-agent-step-idx">{{ si + 1 }}</span>
                  </span>
                  <div class="turn-agent-step-body">
                    <div class="turn-agent-step-head">
                      <span class="turn-agent-step-label">{{ step.label }}</span>
                      <span class="turn-agent-step-status">{{ agentPipelineStatusLabel(step.status) }}</span>
                    </div>
                    <p v-if="step.query" class="turn-agent-step-query">{{ step.query }}</p>
                    <p v-if="step.summary" class="turn-agent-step-summary">{{ step.summary }}</p>
                  </div>
                </li>
              </ol>

              <div v-if="turnRoutePlanCard(t)?.clauses?.length" class="turn-agent-clauses">
                <div class="turn-agent-clauses-title">任务要点</div>
                <ul class="turn-agent-clause-list">
                  <li v-for="c in turnRoutePlanCard(t)!.clauses" :key="c.id">
                    <span class="turn-agent-clause-text">{{ previewText(c.text, thoughtViewMode === 'user' ? 72 : 120) }}</span>
                  </li>
                </ul>
              </div>

              <details v-if="thoughtViewMode === 'developer' && turnRoutePlanCard(t)" class="turn-agent-pipeline-dev">
                <summary>编排技术详情</summary>
                <div v-if="turnRoutePlanCard(t)?.dataSources?.length" class="turn-agent-dev-row">
                  <span class="turn-agent-dev-k">数据面</span>
                  <span>{{ turnRoutePlanCard(t)!.dataSources!.join(' + ') }}</span>
                </div>
                <div v-if="turnRoutePlanCard(t)?.blueprintDag" class="turn-agent-dev-row">
                  <span class="turn-agent-dev-k">蓝图</span>
                  <code class="turn-agent-dev-code">{{ turnRoutePlanCard(t)!.blueprintDag }}</code>
                </div>
                <div v-if="turnPlanOutline(t)?.dag" class="turn-agent-dev-row">
                  <span class="turn-agent-dev-k">DAG</span>
                  <code class="turn-agent-dev-code">{{ turnPlanOutline(t)!.dag }}</code>
                </div>
                <ul v-if="turnRoutePlanCard(t)?.lintIssues?.length" class="turn-agent-dev-lint">
                  <li v-for="(issue, li) in turnRoutePlanCard(t)!.lintIssues!.slice(0, 4)" :key="li">{{ issue }}</li>
                </ul>
              </details>
            </div>
          </div>

          <details
            v-if="hasThoughtContent(t)"
            class="cursor-thought-panel process-panel chat-agent-stack"
            :class="{
              'is-running': isTurnRunning(t),
              'is-collapsed': !thoughtPanelOpen(t),
              'thought-panel-user': thoughtViewMode === 'user',
              'thought-panel-developer': thoughtViewMode === 'developer'
            }"
            :open="thoughtPanelOpen(t)"
            @toggle="onThoughtPanelToggle(t, $event)"
          >
            <summary class="process-panel-summary">
              <div class="process-panel-summary-row">
                <span class="process-chevron" aria-hidden="true"></span>
                <span class="process-panel-label">{{ thoughtPanelLabel() }}</span>
                <span v-if="isTurnRunning(t)" class="cursor-thought-spinner" aria-hidden="true"></span>
                <div class="process-panel-summary-meta">
                  <template v-if="thoughtViewMode === 'developer'">
                    <span v-if="stepResultsForTurn(t).length || t.process.length" class="process-panel-badge">{{
                      stepResultsForTurn(t).length || t.process.length
                    }} 日志</span>
                    <span v-if="t.ragEvidence.length" class="process-panel-badge process-panel-badge-muted"
                      >RAG {{ t.ragEvidence.length }}</span
                    >
                  </template>
                  <template v-else>
                    <span v-if="isTurnRunning(t)" class="process-panel-badge process-panel-badge-live">进行中</span>
                    <span v-else-if="userThoughtNarrative(t).length" class="process-panel-badge process-panel-badge-muted"
                      >{{ userThoughtNarrative(t).length }} 条</span
                    >
                  </template>
                </div>
              </div>
              <span
                v-if="!thoughtPanelOpen(t) && thoughtPanelPreview(t)"
                class="process-panel-preview"
              >{{ thoughtPanelPreview(t) }}</span>
            </summary>
            <div class="process-panel-body process-panel-scroll">
              <!-- 用户视图：自然语言进展 -->
              <div v-if="thoughtViewMode === 'user'" class="user-thought-narrative" aria-label="思考进展">
                <div
                  v-if="isTurnRunning(t) && !userThoughtNarrative(t).length"
                  class="user-thought-line is-active"
                >
                  <span class="user-thought-dot" aria-hidden="true"></span>
                  <span class="user-thought-text">正在理解并处理你的问题…</span>
                </div>
                <div
                  v-for="(line, ni) in userThoughtNarrative(t)"
                  :key="`uth-${ni}-${line.text.slice(0, 24)}`"
                  class="user-thought-line"
                  :class="{ 'is-done': line.done, 'is-active': line.active, 'is-failed': line.failed, 'is-stream': line.active }"
                >
                  <span class="user-thought-dot" aria-hidden="true"></span>
                  <span class="user-thought-text">{{ line.text }}</span>
                </div>
                <details v-if="t.searchSources.length" class="user-thought-sources">
                  <summary>参考来源（{{ t.searchSources.length }}）</summary>
                  <ul class="spring-search-sources-list">
                    <li v-for="(hit, si) in t.searchSources" :key="si">
                      <a v-if="hit.url" :href="hit.url" target="_blank" rel="noopener noreferrer">{{ hit.title || hit.url }}</a>
                      <span v-else>{{ hit.title || '（无链接）' }}</span>
                    </li>
                  </ul>
                </details>
              </div>

              <!-- 开发视图：原始日志 -->
              <template v-else>
              <details v-if="t.ragEvidence.length" class="spring-search-sources-panel">
                <summary>知识库引用（{{ t.ragEvidence.length }}）</summary>
                <ul class="spring-search-sources-list">
                  <li v-for="(hit, ri) in t.ragEvidence" :key="ri">
                    <a v-if="hit.url" :href="hit.url" target="_blank" rel="noopener noreferrer">{{ hit.title || hit.source || hit.url }}</a>
                    <span v-else>{{ hit.title || hit.source || '（无标题）' }}</span>
                    <span v-if="hit.excerpt" class="rag-evidence-excerpt">{{ hit.excerpt.slice(0, 120) }}</span>
                  </li>
                </ul>
              </details>
              <details v-if="t.searchSources.length" class="spring-search-sources-panel">
                <summary>参考来源（{{ t.searchSources.length }}）</summary>
                <ul class="spring-search-sources-list">
                  <li v-for="(hit, si) in t.searchSources" :key="si">
                    <a v-if="hit.url" :href="hit.url" target="_blank" rel="noopener noreferrer">{{ hit.title || hit.url }}</a>
                    <span v-else>{{ hit.title || '（无链接）' }}</span>
                  </li>
                </ul>
              </details>
              <div v-if="t.process.length" class="process-timeline">
                <div
                  v-for="(p, idx) in t.process"
                  :key="idx"
                  class="process-step"
                  :class="[
                    kindClass(p.kind),
                    p.from ? `from-${String(p.from).toLowerCase()}` : '',
                    {
                      'is-expanded': expandedProcessKeys.has(processStepKey(t, idx)),
                      'is-clampable': isProcessStepClampable(p.text, p.kind),
                      'is-latest': idx === t.process.length - 1,
                      'is-latest-live': idx === t.process.length - 1 && isTurnRunning(t)
                    }
                  ]"
                >
                  <div class="process-step-marker" aria-hidden="true">
                    <span class="process-step-dot"></span>
                  </div>
                  <div class="process-step-body">
                    <div class="process-step-meta">
                      <span class="process-step-kind">{{ kindLabel(p.kind) }}</span>
                      <span v-if="p.from" class="process-step-from">{{ p.from }}</span>
                      <span v-if="phaseLabel(p)" class="process-step-phase">{{ phaseLabel(p) }}</span>
                      <span class="meta-time">{{ p.ts }}</span>
                    </div>
                    <div v-if="String(p.kind).toLowerCase() !== 'phase'" class="process-step-text">{{ formatProcessText(p.text, p.kind) }}</div>
                    <img
                      v-if="p.guiScreenshot"
                      :src="p.guiScreenshot"
                      alt="GUI 截图预览"
                      class="gui-screenshot-preview"
                    />
                    <button
                      v-if="isProcessStepClampable(p.text, p.kind)"
                      type="button"
                      class="process-step-expand-btn"
                      @click="toggleProcessStep(t, idx)"
                    >
                      {{ expandedProcessKeys.has(processStepKey(t, idx)) ? '收起' : '展开' }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="t.codePatches.length" class="process-timeline process-timeline-patches">
                <div v-for="(patch, idx) in t.codePatches" :key="idx" class="process-step from-code">
                  <div class="process-step-marker" aria-hidden="true">
                    <span class="process-step-dot"></span>
                  </div>
                  <div class="process-step-body">
                    <div class="process-step-meta">
                      <span class="process-step-kind">patch</span>
                      <span class="process-step-from">code</span>
                    </div>
                    <pre class="process-step-text process-step-code">{{ patch }}</pre>
                  </div>
                </div>
              </div>
              </template>
            </div>
          </details>

          <div
            v-if="isTurnLive(t) && (streamingSynthText || isSynthPhaseActive())"
            :ref="bindStreamingReplyEl"
            class="spring-log-item reply-panel chat-agent-row reply-panel-streaming"
          >
            <div class="spring-log-bubble reply-panel-inner cosmic-bubble-reply">
              <header class="reply-panel-header">
                <div class="reply-panel-avatar" aria-hidden="true">
                  <span class="reply-panel-avatar-mark">总</span>
                </div>
                <div class="reply-panel-header-body">
                  <div class="reply-panel-header-top">
                    <span class="reply-panel-title">总管</span>
                    <span class="reply-panel-kind reply-stream-badge">流式输出</span>
                    <span class="reply-stream-dot" aria-hidden="true"></span>
                  </div>
                </div>
              </header>
              <div class="reply-panel-body">
                <div
                  v-if="streamingSynthText"
                  class="reply-summary md-body reply-chat reply-streaming-body"
                  @click="onReplyMarkdownClick"
                  v-html="renderAssistantMarkdown(streamingSynthDisplayText)"
                ></div>
                <p v-else class="reply-stream-placeholder">正在整合多源结果，即将开始流式输出…</p>
              </div>
            </div>
          </div>

          <div
            v-for="(r, idx) in t.results"
            :key="`r-${idx}`"
            class="spring-log-item reply-panel chat-agent-row"
            :class="resultItemClasses(r)"
          >
            <div class="spring-log-bubble reply-panel-inner cosmic-bubble cosmic-bubble-reply">
              <header class="reply-panel-header">
                <div class="reply-panel-avatar" aria-hidden="true">
                  <span class="reply-panel-avatar-mark">总</span>
                </div>
                <div class="reply-panel-header-body">
                  <div class="reply-panel-header-top">
                    <span class="reply-panel-title">总管</span>
                    <span class="reply-panel-kind">{{ resultKindLabel(r) }}</span>
                    <span class="meta-time">{{ r.ts }}</span>
                  </div>
                </div>
              </header>
              <div class="reply-panel-body" @click="onReplyMarkdownClick">

              <div v-if="turnSearchSources(t).length" class="reply-web-read-bar">
                <span class="reply-web-read-icon" aria-hidden="true">🌐</span>
                <span class="reply-web-read-label">已阅读 {{ turnSearchSources(t).length }} 个来源</span>
                <span class="reply-web-read-chips">
                  <a
                    v-for="(hit, wi) in turnSearchSources(t).slice(0, 8)"
                    :key="`web-${wi}`"
                    class="reply-web-read-chip"
                    :href="hit.url || undefined"
                    :title="hit.title"
                    target="_blank"
                    rel="noopener noreferrer"
                    @click.stop
                  >{{ webSourceHost(hit) }}</a>
                </span>
              </div>

              <div v-if="mediaForReply(r, t).videos.length" class="media-block media-block-grid">
                <div v-for="(v, vi) in mediaForReply(r, t).videos" :key="`v-${vi}`" class="media-card media-card-video">
                  <div class="media-card-head">
                    <span class="media-label">{{ v.label }}</span>
                    <div class="media-actions">
                      <button type="button" class="media-btn" @click="openMediaInNewTab(resolveMediaUrl(v.url))">打开</button>
                      <button type="button" class="media-btn" @click="downloadMediaFile(resolveMediaUrl(v.url), mediaDownloadName(v.url, 'video'))">下载视频</button>
                    </div>
                  </div>
                  <video class="media-video" controls playsinline preload="metadata" :src="resolveMediaUrl(v.url)" />
                </div>
              </div>
              <div v-if="mediaForReply(r, t).midis.length" class="media-block media-block-grid">
                <div v-for="(m, mi) in mediaForReply(r, t).midis" :key="`m-${mi}`" class="media-card media-card-midi">
                  <CosmicMidiPlayer :url="resolveMediaUrl(m.url)" :label="m.label" />
                </div>
              </div>
              <div v-if="mediaForReply(r, t).audios.length" class="media-block media-block-grid">
                <div v-for="(a, ai) in mediaForReply(r, t).audios" :key="`a-${ai}`" class="media-card media-card-audio">
                  <div class="media-card-head">
                    <span class="media-label">{{ a.label }}</span>
                    <div class="media-actions">
                      <button type="button" class="media-btn" @click="openMediaInNewTab(resolveMediaUrl(a.url))">打开</button>
                      <button type="button" class="media-btn" @click="downloadMediaFile(resolveMediaUrl(a.url), mediaDownloadName(a.url, 'audio'))">下载音频</button>
                    </div>
                  </div>
                  <audio class="media-audio" controls preload="metadata" :src="resolveMediaUrl(a.url)" />
                </div>
              </div>
              <div v-if="mediaForReply(r, t).images.length" class="media-block media-block-grid">
                <div v-for="(im, ii) in mediaForReply(r, t).images" :key="`i-${ii}`" class="media-card media-card-image">
                  <div class="media-card-head">
                    <span class="media-label">{{ im.label }}</span>
                    <div class="media-actions">
                      <a class="media-btn" :href="resolveMediaUrl(im.url)" target="_blank" rel="noopener noreferrer">打开</a>
                      <a class="media-btn" :href="resolveMediaUrl(im.url)" download target="_blank" rel="noopener noreferrer">下载图片</a>
                    </div>
                  </div>
                  <img class="media-image" :src="resolveMediaUrl(im.url)" alt="" loading="lazy" />
                </div>
              </div>

              <AmapReplyCards v-if="adminUiCardsFromTurn(t).length" :cards="adminUiCardsFromTurn(t) as any" />

              <!-- 主要回复：常显分区，与图表/详细说明拉开层次 -->
              <section v-if="replyMarkdownBody(r.text, t)" class="reply-primary-section" aria-label="主要回复">
                <header class="reply-primary-head">
                  <span class="reply-primary-mark" aria-hidden="true"></span>
                  <span class="reply-primary-title">主要回复</span>
                </header>
                <div
                  class="reply-summary md-body reply-chat"
                  v-html="renderAssistantMarkdown(replyMarkdownBody(r.text, t), turnSearchSources(t))"
                ></div>
              </section>

              <ul v-if="t.userFacing?.metrics?.length" class="reply-metrics">
                <li v-for="(m, mi) in t.userFacing.metrics" :key="`metric-${mi}`">
                  <span class="reply-metric-label">{{ m.label }}</span>
                  <span class="reply-metric-value">{{ m.value }}</span>
                </li>
              </ul>

              <!-- 图表/表格：可折叠，默认展开 -->
              <details
                v-if="replyHasInlineAnalytics(r.text, buildTurnAgentResults(t), t)"
                class="chart-details reply-inline-analytics"
                open
                @toggle="onChartDetailsToggle"
              >
                <summary class="chart-details-summary">
                  <span class="chart-card-mark" aria-hidden="true"></span>
                  <span class="chart-card-title">{{
                    userFacingChartTitle(t) ||
                    chartTitleFromText(r.text, buildTurnAgentResults(t)) ||
                    (userFacingTableHtml(t) || extractTableData(r.text) ? '数据看板' : '数据图表')
                  }}</span>
                  <button
                    v-if="userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))"
                    type="button"
                    class="reply-tool-btn reply-tool-btn-inline"
                    @click.stop="
                      downloadEchartsPng(
                        `chart_${t.id}_${idx}.png`,
                        userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))
                      )
                    "
                  >
                    下载 .png
                  </button>
                </summary>
                <div class="chart-details-body">
                  <div
                    v-if="userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))"
                    class="chart-card"
                  >
                    <div class="chart-wrap">
                      <div
                        :ref="
                          (el) => {
                            if (el)
                              initChartEl(
                                el as HTMLElement,
                                userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))
                              )
                          }
                        "
                        :data-option="
                          JSON.stringify(
                            userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))
                          )
                        "
                        class="echarts-container"
                        :class="
                          chartContainerClass(
                            userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))
                          )
                        "
                        :style="
                          chartContainerStyle(
                            userFacingChartOption(t) || extractEchartsOption(r.text, buildTurnAgentResults(t))
                          )
                        "
                      ></div>
                    </div>
                  </div>
                  <div
                    v-if="userFacingTableHtml(t)"
                    class="data-table-wrap md-body reply-rich"
                    v-html="userFacingTableHtml(t)"
                  ></div>
                  <div
                    v-else-if="extractTableData(r.text)"
                    class="data-table-wrap md-body reply-rich"
                    v-html="renderTableDataHtml(r.text)"
                  ></div>
                </div>
              </details>

              <div v-if="t.userFacing?.actions?.length" class="reply-action-cards">
                <div
                  v-for="a in t.userFacing.actions"
                  :key="a.id"
                  class="action-card"
                  :class="`action-card-${a.status}`"
                >
                  <div class="action-card-title">{{ a.title }}</div>
                  <p class="action-card-summary">{{ a.summary }}</p>
                  <p v-if="a.failureReasonZh" class="action-card-fail">{{ a.failureReasonZh }}</p>
                  <div v-if="a.preview?.screenshotUrl || a.preview?.pageUrl" class="action-card-preview">
                    <img
                      v-if="a.preview.screenshotUrl"
                      class="action-card-shot"
                      :src="a.preview.screenshotUrl"
                      alt="操作预览"
                    />
                    <a
                      v-if="a.preview.pageUrl"
                      class="action-card-link"
                      :href="a.preview.pageUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      >{{ a.preview.pageUrl }}</a
                    >
                  </div>
                  <div
                    v-if="a.status === 'awaiting_confirm' || a.status === 'proposed'"
                    class="action-card-actions"
                  >
                    <button
                      type="button"
                      class="action-card-btn action-card-btn-confirm"
                      :disabled="!canConfirmActionCard(a.id) || humanConfirmSending"
                      @click="respondActionCardConfirm(a.id)"
                    >
                      确认执行
                    </button>
                    <button
                      type="button"
                      class="action-card-btn action-card-btn-cancel"
                      :disabled="!canConfirmActionCard(a.id) || humanConfirmSending"
                      @click="respondActionCardCancel(a.id)"
                    >
                      取消
                    </button>
                  </div>
                  <p v-else-if="a.status === 'running'" class="action-card-status">执行中…</p>
                  <p v-else-if="a.status === 'done'" class="action-card-status">已确认</p>
                  <p v-else-if="a.status === 'cancelled'" class="action-card-status">已取消</p>
                </div>
              </div>

              <!-- U2：专家失败可解释卡片（超时/熔断/5xx/业务） -->
              <div
                v-if="turnExpertFailureCards(t).length"
                class="reply-fail-cards"
                role="status"
              >
                <div
                  v-for="card in turnExpertFailureCards(t)"
                  :key="`${t.id}-${card.agent}-${card.code}`"
                  class="reply-fail-card"
                  :data-error-code="card.code"
                >
                  <span class="reply-fail-card-badge">{{ card.codeLabel }}</span>
                  <div class="reply-fail-card-body">
                    <div class="reply-fail-card-title">{{ card.label }}</div>
                    <p class="reply-fail-card-msg">{{ card.message }}</p>
                  </div>
                </div>
              </div>

              <!-- U3：无证据拒答 / 需补充 — 显著徽章 -->
              <div
                v-if="t.userFacing?.badge"
                class="reply-evidence-badge"
                :class="{
                  'is-rejected': t.userFacing.badge === 'evidence_rejected',
                  'is-clarify': t.userFacing.badge === 'needs_clarify'
                }"
                role="status"
              >
                {{ t.userFacing.badgeLabel || (t.userFacing.badge === 'evidence_rejected' ? '无证据拒答' : '需补充信息') }}
              </div>

              <!-- U3：有引用时证据上移（正文前默认展开） -->
              <details
                v-if="t.ragEvidence.length || t.userFacing?.sources?.length"
                class="reply-evidence-first"
                open
              >
                <summary>
                  依据与引用
                  <span class="reply-attachments-badge">
                    {{ t.ragEvidence.length || t.userFacing?.sources?.length || 0 }}
                  </span>
                </summary>
                <ul v-if="t.ragEvidence.length" class="spring-search-sources-list">
                  <li v-for="(hit, ri) in t.ragEvidence" :key="'rag-' + ri">
                    <strong>{{ hit.source || '文档' }}</strong>
                    <span v-if="hit.excerpt" class="rag-evidence-excerpt">{{ hit.excerpt.slice(0, 160) }}</span>
                  </li>
                </ul>
                <ul v-else-if="t.userFacing?.sources?.length" class="spring-search-sources-list">
                  <li v-for="(s, si) in t.userFacing.sources" :key="'src-' + si">
                    <a v-if="s.url" :href="s.url" target="_blank" rel="noopener">{{ s.title }}</a>
                    <span v-else>{{ s.title }}</span>
                  </li>
                </ul>
              </details>

              <!-- 用户视图：完成态不展示执行摘要；失败/待确认仅短状态条 -->
              <div
                v-if="thoughtViewMode === 'user' && replyUserOutcomeBanner(t)"
                class="reply-outcome-banner"
                :class="{
                  'is-outcome-fail': replyUserOutcomeBanner(t)?.tone === 'fail',
                  'is-outcome-human': replyUserOutcomeBanner(t)?.tone === 'human'
                }"
                role="status"
              >
                {{ replyUserOutcomeBanner(t)?.label }}
              </div>
              <details
                v-else-if="thoughtViewMode === 'developer' && replyExecutionSummaryMarkdown(r.text, t)"
                class="reply-exec-summary"
                :class="{
                  'is-outcome-ok': replyExecSummaryTone(r.text, t) === 'ok',
                  'is-outcome-fail': replyExecSummaryTone(r.text, t) === 'fail',
                  'is-outcome-human': replyExecSummaryTone(r.text, t) === 'human'
                }"
              >
                <summary>执行摘要</summary>
                <div
                  class="md-body reply-chat reply-exec-summary-body"
                  v-html="renderAssistantMarkdown(replyExecutionSummaryMarkdown(r.text, t))"
                ></div>
              </details>

              <!-- 详细说明：可折叠，默认收起，避免与主回复重复灌屏 -->
              <details
                v-if="replyUserDetailAppendix(t, r.text)"
                class="report-details reply-inline-report"
              >
                <summary class="report-label report-card-head">
                  <span class="report-card-mark" aria-hidden="true"></span>
                  <span class="report-card-title">详细说明</span>
                  <button
                    type="button"
                    class="reply-tool-btn reply-tool-btn-inline"
                    @click.stop="
                      downloadMarkdown(
                        `report_detail_${t.id}_${idx}.md`,
                        replyUserDetailAppendix(t, r.text)
                      )
                    "
                  >
                    下载 .md
                  </button>
                </summary>
                <div class="report-card report-body">
                  <div
                    class="report-card-body md-body reply-rich"
                    v-html="
                      renderReportMarkdown(replyUserDetailAppendix(t, r.text))
                    "
                  ></div>
                </div>
              </details>

              <details
                v-if="t.userFacing?.sources?.length || replyHasCollapsibleSources(r.text, t)"
                class="reply-attachments"
              >
                <summary class="reply-attachments-summary">
                  <span class="reply-attachments-icon" aria-hidden="true"></span>
                  参考来源
                  <span
                    v-if="t.userFacing?.sources?.length || replySourceCount(r, t)"
                    class="reply-attachments-badge"
                    >来源 {{ t.userFacing?.sources?.length || replySourceCount(r, t) }}</span
                  >
                </summary>
                <div class="reply-attachments-body">
                  <div class="reply-toolbar">
                    <button type="button" class="reply-tool-btn" @click="downloadMarkdown(`report_${t.id}_${idx}.md`, r.text)">下载完整回复 .md</button>
                  </div>
                  <details
                    v-if="replySourceCount(r, t)"
                    class="sources-panel"
                    open
                  >
                    <summary class="sources-panel-summary">参考来源（{{ replySourceCount(r, t) }}）</summary>
                    <div
                      class="sources-panel-body md-body reply-rich"
                      v-html="renderAssistantMarkdown(replySourcesMarkdown(r, t))"
                    ></div>
                  </details>
                </div>
              </details>

              <p
                v-if="
                  !replyMarkdownBody(r.text, t) &&
                  !replyExecutionSummaryMarkdown(r.text, t) &&
                  !replyUserOutcomeBanner(t) &&
                  !replyUserDetailAppendix(t, r.text) &&
                  !hasMediaContent(r.text) &&
                  !replyHasAnalytics(r.text, t)
                "
                class="spring-log-empty"
              >
                {{ thoughtViewMode === 'user'
                  ? '（正文为空，请展开上方「正在思考」查看进展说明）'
                  : '（正文为空，请展开上方「思考过程」查看各 Agent 输出）' }}
              </p>
              </div>
              <footer class="reply-panel-footer">
                <div class="message-actions">
                  <button type="button" class="message-action-btn" @click="copyMessageText(r.text, { replyKey: `${t.id}-${idx}` })">
                    {{ copyAckKey === `${t.id}-${idx}` ? '已复制' : '复制' }}
                  </button>
                </div>
              </footer>
            </div>
          </div>

          <div v-if="shouldShowTurnFeedback(t)" class="turn-feedback-bar chat-agent-stack">
            <template v-if="!turnFeedbackSubmitted(t)">
              <span class="turn-feedback-label">这轮回复有帮助吗？</span>
              <div class="turn-feedback-actions">
                <span v-if="feedbackSendingRunId === turnFeedbackKey(t)" class="turn-feedback-pending">{{ FEEDBACK_PENDING_ACK }}</span>
                <button
                  type="button"
                  class="message-action-btn message-action-btn-fb"
                  :disabled="!connected || feedbackSendingRunId === turnFeedbackKey(t)"
                  @click="sendFeedback(t, 1)"
                >
                  有用
                </button>
                <button
                  type="button"
                  class="message-action-btn message-action-btn-fb"
                  :disabled="!connected || feedbackSendingRunId === turnFeedbackKey(t)"
                  @click="sendFeedback(t, 0)"
                >
                  无用
                </button>
                <button
                  type="button"
                  class="message-action-btn message-action-btn-fb"
                  :disabled="!connected || feedbackSendingRunId === turnFeedbackKey(t) || routeFeedbackSubmitted(t)"
                  @click="sendRouteWrongFeedback(t)"
                >
                  {{ routeFeedbackSubmitted(t) ? '已记录路由问题' : '路由不对' }}
                </button>
                <button
                  v-if="t.user && typeof t.user.userMessageIndex === 'number'"
                  type="button"
                  class="message-action-btn"
                  :disabled="!connected || isTurnRunning(t) || !!currentRunId || editingTurnId === t.id"
                  @click="regenerateTurn(t)"
                >
                  重新生成
                </button>
              </div>
            </template>
            <template v-else>
              <p class="turn-feedback-ack turn-feedback-ack-done">{{ turnFeedbackAckText(t) }}</p>
              <div v-if="t.user && typeof t.user.userMessageIndex === 'number'" class="turn-feedback-actions">
                <button
                  type="button"
                  class="message-action-btn"
                  :disabled="!connected || isTurnRunning(t) || !!currentRunId || editingTurnId === t.id"
                  @click="regenerateTurn(t)"
                >
                  重新生成
                </button>
              </div>
            </template>
          </div>

          <div v-if="visibleTurnErrors(t).length" class="spring-error-stack">
            <div class="spring-error-stack-head">
              <span class="spring-error-stack-label">运行异常（{{ visibleTurnErrors(t).length }}）</span>
              <button type="button" class="spring-error-dismiss-all" @click="dismissAllTurnErrors(t.id)">全部关闭</button>
            </div>
            <div
              v-for="(e, idx) in visibleTurnErrors(t)"
              :key="errorItemKey(e, idx)"
              class="spring-log-item kind-error spring-error-item"
              :class="[e.from ? `from-${String(e.from).toLowerCase()}` : '']"
            >
              <div class="spring-log-bubble spring-error-bubble">
                <button type="button" class="spring-error-dismiss" aria-label="关闭错误" title="关闭" @click="dismissError(e)">×</button>
                <div class="spring-log-meta">
                  <span class="meta-time">{{ e.ts }}</span>
                  <span class="meta-pill spring-error-pill">{{ kindLabel(e.kind) }}</span>
                  <span v-if="e.from" class="meta-pill alt spring-error-pill-alt">{{ e.from }}</span>
                </div>
                <pre class="spring-log-text spring-error-text">{{ e.text }}</pre>
              </div>
            </div>
          </div>
        </div>
  </div>
</template>
