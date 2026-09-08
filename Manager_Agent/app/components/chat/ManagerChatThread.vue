<script setup lang="ts">
import AmapReplyCards from '~/components/AmapReplyCards.vue'
import CosmicMidiPlayer from '~/components/CosmicMidiPlayer.vue'
import ManagerSpecialistCards from '~/components/chat/ManagerSpecialistCards.vue'
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
  streamingSynthText,
  streamingSynthProvisional,
  streamingSynthDisplayText,
  streamingMarkdownHtml,
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
  hasTurnActivity,
  turnAgentPipelineSteps,
  turnAgentPipelineDoneCount,
  turnRouteCap,
  turnCollaborationPosture,
  turnPostureNote,
  turnSuggestedPosture,
  turnAwaitingPlanConfirm,
  turnHitlInfo,
  pendingPlanPreview,
  workbenchMode,
  agentPipelineStatusLabel,
  turnRoutePlanCard,
  previewText,
  turnPlanOutline,
  hasThoughtContent,
  thoughtPanelOpen,
  onThoughtPanelToggle,
  thoughtPanelLabel,
  stepResultsForTurn,
  executionStepCountForTurn,
  thoughtLogCountForTurn,
  userThoughtNarrative,
  userThoughtStreamText,
  turnThoughtStages,
  userCreatedPlanLabels,
  turnGuiVisuals,
  thoughtPanelPreview,
  processStepKey,
  isProcessStepClampable,
  phaseLabel,
  formatProcessText,
  toggleProcessStep,
  isSynthPhaseActive,
  turnRunStatusPill,
  onReplyMarkdownClick,
  renderAssistantMarkdown,
  cachedResultMarkdownHtml,
  turnRenderMemoKey,
  renderReportMarkdown,
  resultItemClasses,
  resultKindLabel,
  turnSearchSources,
  turnUnifiedCiteSources,
  citeSourcesForMarkdown,
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
  shouldShowUserFacingMetrics,
  shouldShowUserFacingHeadline,
  applyFollowUpSuggestion,
  shouldShowArtifactLaunchBar,
  artifactPanelSlots,
  artifactTabLabel,
  openReplyArtifactDrawer,
  streamingArtifactHintForTurn,
  turnReportEditedBadge,
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
  memoryCaptureBusy,
  memoryCaptureKindLabel,
  respondMemoryCapture,
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
  feedbackKeyForTurn,
  isFeedbackPendingForTurn,
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

let lastStreamScrollAt = 0
watch(streamingSynthText, async () => {
  if (!streamingSynthText.value) return
  const now = Date.now()
  if (now - lastStreamScrollAt < 280) return
  lastStreamScrollAt = now
  await nextTick()
  const node = resolveScrollTarget(streamingReplyEl.value)
  node?.scrollIntoView?.({ behavior: 'auto', block: 'nearest' })
})
</script>

<template>
  <div class="chat-thread chat-messenger ch-thread">
        <div
          v-for="t in turns"
          :key="t.id"
          v-memo="
            isTurnLive(t)
              ? [turnRenderMemoKey(t), streamingSynthText.length, streamingMarkdownHtml.length]
              : [turnRenderMemoKey(t)]
          "
          class="spring-turn"
        >
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

          <div
            v-if="turnRunStatusPill(t) || hasThoughtContent(t) || turnRouteCap(t)?.agents?.length || turnAgentPipelineSteps(t).length"
            class="turn-storyline"
          >
          <div
            v-for="pill in [turnRunStatusPill(t)].filter(Boolean)"
            :key="`${t.id}-pill`"
            class="harness-status-pill"
            :class="[`is-${pill!.kind}`, { 'is-live': isTurnRunning(t) || isTurnLive(t) }]"
            role="status"
          >
            <span class="harness-status-pill-dot" aria-hidden="true"></span>
            <span class="harness-status-pill-label">{{ pill!.label }}</span>
            <span v-if="pill!.elapsed" class="harness-status-pill-elapsed">{{ pill!.elapsed }}</span>
          </div>

          <details
            v-if="hasThoughtContent(t)"
            class="cursor-thought-panel process-panel chat-agent-stack thought-panel-user harness-think-only"
            :class="{
              'is-running': isTurnRunning(t),
              'is-collapsed': !thoughtPanelOpen(t)
            }"
            :open="thoughtPanelOpen(t)"
            @toggle="onThoughtPanelToggle(t, $event)"
          >
            <summary class="process-panel-summary">
              <div class="process-panel-summary-row">
                <span class="process-chevron" aria-hidden="true"></span>
                <span class="process-panel-spark" aria-hidden="true"></span>
                <span class="process-panel-label">{{ thoughtPanelLabel() }}</span>
                <span v-if="isTurnRunning(t)" class="cursor-thought-spinner" aria-hidden="true"></span>
                <div class="process-panel-summary-meta">
                  <span v-if="isTurnRunning(t)" class="process-panel-badge process-panel-badge-live">进行中</span>
                  <span v-else-if="userThoughtStreamText(t)" class="process-panel-badge process-panel-badge-muted"
                    >已思考</span
                  >
                </div>
              </div>
              <span
                v-if="!thoughtPanelOpen(t) && thoughtPanelPreview(t)"
                class="process-panel-preview"
              >{{ thoughtPanelPreview(t) }}</span>
            </summary>
            <div class="process-panel-body process-panel-scroll">
              <div class="harness-think" aria-label="思考进展">
                <div
                  v-if="turnThoughtStages(t).length"
                  class="harness-think-stages"
                  aria-label="分阶段思考"
                >
                  <details
                    v-for="(stage, si) in turnThoughtStages(t)"
                    :key="si"
                    class="harness-think-stage"
                    :class="{
                      'is-active': si === turnThoughtStages(t).length - 1 && isTurnRunning(t),
                      'is-done': si < turnThoughtStages(t).length - 1 || !isTurnRunning(t)
                    }"
                    :open="si === turnThoughtStages(t).length - 1 && isTurnRunning(t)"
                  >
                    <summary class="harness-think-stage-sum">
                      <span class="harness-think-stage-dot" aria-hidden="true"></span>
                      <span class="harness-think-stage-label">{{ stage.label }}</span>
                      <span v-if="stage.secs != null" class="harness-think-stage-secs">{{ stage.secs }}s</span>
                    </summary>
                    <div class="harness-think-stage-body">{{ stage.text }}</div>
                  </details>
                </div>
                <div
                  v-else
                  class="harness-think-stream"
                  :class="{ 'is-live': isTurnRunning(t) }"
                >
                  <span class="harness-think-rail" aria-hidden="true"></span>
                  <div class="harness-think-stream-body">
                    <template v-if="userThoughtStreamText(t)">{{ userThoughtStreamText(t) }}</template>
                    <template v-else-if="isTurnRunning(t)">正在理解并处理你的问题…</template>
                    <span v-if="isTurnRunning(t)" class="harness-think-caret" aria-hidden="true"></span>
                  </div>
                </div>
                <div v-if="userCreatedPlanLabels(t).length" class="harness-created-plan">
                  <div class="harness-created-plan-head">
                    <span class="harness-created-plan-icon" aria-hidden="true"></span>
                    <div class="harness-created-plan-title">处理计划</div>
                  </div>
                  <div class="harness-created-plan-agents" role="list">
                    <template v-for="(label, ai) in userCreatedPlanLabels(t)" :key="ai">
                      <span v-if="ai > 0" class="harness-plan-arrow" aria-hidden="true">→</span>
                      <span class="harness-plan-chip" role="listitem">{{ label }}</span>
                    </template>
                  </div>
                </div>
                <div
                  v-if="turnGuiVisuals(t).shot || turnGuiVisuals(t).vncUrl"
                  class="user-gui-visual"
                >
                  <img
                    v-if="turnGuiVisuals(t).shot"
                    :src="turnGuiVisuals(t).shot"
                    alt="操作画面预览"
                    class="gui-screenshot-preview"
                  />
                  <a
                    v-if="turnGuiVisuals(t).vncUrl"
                    class="gui-live-view-link"
                    :href="turnGuiVisuals(t).vncUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >打开实时画面</a>
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
            </div>
          </details>

          <ManagerSpecialistCards
            v-if="turnRouteCap(t)?.agents?.length || turnAgentPipelineSteps(t).length"
            :turn="t"
            :running="isTurnRunning(t)"
            :steps="turnAgentPipelineSteps(t)"
            :route-agents="turnRouteCap(t)?.agents"
            :status-label="agentPipelineStatusLabel"
          />
          </div>

          <div
            v-if="isTurnLive(t) && (streamingSynthText || isSynthPhaseActive())"
            :ref="bindStreamingReplyEl"
            class="spring-log-item reply-panel chat-agent-row reply-panel-streaming"
            :class="[
              t.userFacing?.replyTier ? `reply-tier-${t.userFacing.replyTier}` : '',
              streamingSynthProvisional ? 'is-provisional-draft' : 'is-stream-committed'
            ]"
          >
            <div class="spring-log-bubble reply-panel-inner cosmic-bubble-reply">
              <header class="reply-panel-header">
                <div class="reply-panel-avatar" aria-hidden="true">
                  <span class="reply-panel-avatar-mark">答</span>
                </div>
                <div class="reply-panel-header-body">
                  <div class="reply-panel-header-top">
                    <span class="reply-panel-title">回答</span>
                    <span
                      v-if="streamingSynthProvisional"
                      class="reply-panel-kind reply-stream-badge reply-draft-badge"
                      >草稿</span
                    >
                    <span v-else class="reply-panel-kind reply-stream-badge">整理中…</span>
                    <span class="reply-stream-dot" aria-hidden="true"></span>
                  </div>
                </div>
              </header>
              <div class="reply-panel-body">
                <div
                  v-if="streamingSynthText"
                  class="reply-summary md-body reply-chat reply-streaming-body"
                  :class="{ 'ch-streaming': !!streamingSynthText }"
                  @click="onReplyMarkdownClick"
                  v-html="streamingMarkdownHtml || renderAssistantMarkdown(streamingSynthDisplayText)"
                ></div>
                <p v-else class="reply-stream-placeholder">正在整理结论…</p>
                <p
                  v-if="streamingArtifactHintForTurn(t)"
                  class="reply-stream-artifact-hint"
                  role="status"
                >
                  <button
                    type="button"
                    class="reply-stream-artifact-hint-btn"
                    @click="openReplyArtifactDrawer(t.id)"
                  >
                    {{ streamingArtifactHintForTurn(t) }}
                    <span class="reply-stream-artifact-hint-cta">打开面板</span>
                  </button>
                </p>
              </div>
            </div>
          </div>

          <div
            v-for="(r, idx) in t.results"
            :key="`r-${idx}`"
            class="spring-log-item reply-panel chat-agent-row"
            :class="[
              resultItemClasses(r),
              t.userFacing?.replyTier ? `reply-tier-${t.userFacing.replyTier}` : ''
            ]"
          >
            <div class="spring-log-bubble reply-panel-inner cosmic-bubble cosmic-bubble-reply">
              <header class="reply-panel-header">
                <div class="reply-panel-avatar" aria-hidden="true">
                  <span class="reply-panel-avatar-mark">答</span>
                </div>
                <div class="reply-panel-header-body">
                  <div class="reply-panel-header-top">
                    <span class="reply-panel-title">回答</span>
                    <span
                      v-if="t.userFacing?.replyTier === 'lite'"
                      class="reply-panel-kind"
                    >简答</span>
                    <span class="meta-time">{{ r.ts }}</span>
                  </div>
                </div>
              </header>
              <div class="reply-panel-body" @click="onReplyMarkdownClick">

              <details
                v-if="turnUnifiedCiteSources(t).length"
                class="reply-sources-panel"
              >
                <summary class="reply-sources-summary">
                  <span class="reply-web-read-icon" aria-hidden="true"></span>
                  <span class="reply-web-read-label"
                    >已阅读 {{ turnUnifiedCiteSources(t).length }} 个来源</span
                  >
                  <span class="reply-sources-chevron" aria-hidden="true"></span>
                </summary>
                <ol class="reply-source-cards">
                  <li
                    v-for="src in turnUnifiedCiteSources(t)"
                    :key="`cite-${src.index}-${src.title.slice(0, 24)}`"
                    class="reply-source-card"
                  >
                    <span class="reply-source-index">{{ src.index }}</span>
                    <div class="reply-source-body">
                      <a
                        v-if="src.url"
                        class="reply-source-title"
                        :href="src.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        @click.stop
                        >{{ src.title }}</a
                      >
                      <span v-else class="reply-source-title">{{ src.title }}</span>
                      <span v-if="src.url" class="reply-source-host">{{
                        webSourceHost({ title: src.title, url: src.url })
                      }}</span>
                      <p v-if="src.excerpt" class="reply-source-excerpt">{{ src.excerpt }}</p>
                    </div>
                  </li>
                </ol>
              </details>

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

              <AmapReplyCards v-if="t.adminUiCards?.length" :cards="(t.adminUiCards || []) as any" />

              <!-- 正文：headline 置顶 + DeepSeek 式文章体 -->
              <p
                v-if="shouldShowUserFacingHeadline(t)"
                class="reply-headline"
              >{{ t.userFacing.headline }}</p>
              <section v-if="replyMarkdownBody(r.text, t)" class="reply-primary-section reply-article" aria-label="回复正文">
                <div
                  class="reply-summary md-body reply-chat"
                  v-html="cachedResultMarkdownHtml(r.text, t, idx)"
                ></div>
              </section>

              <ul v-if="shouldShowUserFacingMetrics(t)" class="reply-metrics">
                <li v-for="(m, mi) in t.userFacing.metrics" :key="`metric-${mi}`">
                  <span class="reply-metric-label">{{ m.label }}</span>
                  <span class="reply-metric-value">{{ m.value }}</span>
                </li>
              </ul>

              <!-- Cursor Artifact 面板入口（report 档 chart/table/report 不进气泡） -->
              <div
                v-if="turnReportEditedBadge(t)"
                class="reply-revision-banner"
                role="status"
              >
                <span class="reply-revision-banner-text">{{
                  t.userFacing?.reportRevisionNote || '报告已在分析面板修订'
                }}</span>
                <button
                  type="button"
                  class="reply-revision-banner-btn"
                  @click="openReplyArtifactDrawer(t.id, 'report')"
                >
                  查看修订版
                </button>
              </div>
              <div
                v-if="shouldShowArtifactLaunchBar(t)"
                class="reply-artifact-launch"
                aria-label="分析面板"
              >
                <button
                  v-for="slot in artifactPanelSlots(t)"
                  :key="slot.id"
                  type="button"
                  class="reply-artifact-launch-btn"
                  @click="openReplyArtifactDrawer(t.id, slot.kind)"
                >
                  <span class="reply-artifact-launch-label">{{ artifactTabLabel(slot.kind) }}</span>
                  <span class="reply-artifact-launch-title">{{ slot.title }}</span>
                  <span
                    v-if="slot.kind === 'report' && turnReportEditedBadge(t)"
                    class="reply-artifact-edited-chip"
                    >已编辑</span
                  >
                </button>
              </div>

              <!-- 图表/表格：inline 模块才在气泡内展示 -->
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

              <div
                v-if="t.userFacing?.suggestions?.length"
                class="reply-suggestions"
                aria-label="可接着问"
              >
                <button
                  v-for="(s, si) in t.userFacing.suggestions"
                  :key="`suggest-${t.id}-${si}`"
                  type="button"
                  class="reply-suggestion-chip"
                  @click="applyFollowUpSuggestion(s)"
                >
                  {{ s }}
                </button>
              </div>

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

              <!-- Wave 8：记忆提案轻确认 -->
              <div
                v-if="t.memoryCapture && t.memoryCapture.kind && t.memoryCapture.kind !== 'none'"
                class="memory-capture-card"
                :class="`memory-capture-${t.memoryCapture.uiStatus || 'open'}`"
                role="status"
              >
                <div class="memory-capture-card__badge">{{ memoryCaptureKindLabel(t.memoryCapture.kind) }}</div>
                <div class="memory-capture-card__body">
                  <div class="memory-capture-card__title">
                    {{ t.memoryCapture.title || '已为你起草记忆提案' }}
                  </div>
                  <p class="memory-capture-card__summary">
                    {{
                      t.memoryCapture.summary ||
                      (t.memoryCapture.kind === 'save_preference'
                        ? '确认后写入偏好（弱 hint，不改路由）'
                        : t.memoryCapture.kind === 'todo'
                          ? '待办已交由任务栈处理'
                          : '草稿已生成，管理员在控制面审核后才会生效')
                    }}
                  </p>
                  <p v-if="t.memoryCapture.skillId || t.memoryCapture.ruleCandidateId || t.memoryCapture.experienceCandidateId" class="memory-capture-card__meta">
                    <span v-if="t.memoryCapture.skillId">技能草稿 {{ t.memoryCapture.skillId }}</span>
                    <span v-if="t.memoryCapture.ruleCandidateId">规则 {{ t.memoryCapture.ruleCandidateId }}</span>
                    <span v-if="t.memoryCapture.experienceCandidateId">经验候选 {{ t.memoryCapture.experienceCandidateId }}</span>
                  </p>
                </div>
                <div
                  v-if="(t.memoryCapture.uiStatus || 'open') === 'open' || t.memoryCapture.uiStatus === 'sending'"
                  class="memory-capture-card__actions"
                >
                  <template v-if="t.memoryCapture.kind === 'save_preference'">
                    <button
                      type="button"
                      class="action-card-btn action-card-btn-confirm"
                      :disabled="memoryCaptureBusy"
                      @click="respondMemoryCapture(t.id, 'confirm_prefs')"
                    >
                      确认偏好
                    </button>
                    <button
                      type="button"
                      class="action-card-btn action-card-btn-cancel"
                      :disabled="memoryCaptureBusy"
                      @click="respondMemoryCapture(t.id, 'reject_prefs')"
                    >
                      不用了
                    </button>
                  </template>
                  <template v-else-if="t.memoryCapture.kind !== 'todo'">
                    <button
                      type="button"
                      class="action-card-btn action-card-btn-confirm"
                      :disabled="memoryCaptureBusy"
                      @click="respondMemoryCapture(t.id, 'ack')"
                    >
                      知道了，待审核
                    </button>
                  </template>
                </div>
                <p v-else-if="t.memoryCapture.uiStatus === 'confirmed'" class="memory-capture-card__status">已确认偏好</p>
                <p v-else-if="t.memoryCapture.uiStatus === 'rejected'" class="memory-capture-card__status">已拒绝偏好</p>
                <p v-else-if="t.memoryCapture.uiStatus === 'acked'" class="memory-capture-card__status">已提交控制面审核</p>
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

              <!-- 用户面：完成态不展示执行摘要；失败/待确认仅短状态条 -->
              <div
                v-if="replyUserOutcomeBanner(t)"
                class="reply-outcome-banner"
                :class="{
                  'is-outcome-fail': replyUserOutcomeBanner(t)?.tone === 'fail',
                  'is-outcome-human': replyUserOutcomeBanner(t)?.tone === 'human'
                }"
                role="status"
              >
                {{ replyUserOutcomeBanner(t)?.label }}
              </div>

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

              <p
                v-if="
                  !replyMarkdownBody(r.text, t) &&
                  !replyUserOutcomeBanner(t) &&
                  !replyUserDetailAppendix(t, r.text) &&
                  !hasMediaContent(r.text) &&
                  !replyHasAnalytics(r.text, t)
                "
                class="spring-log-empty"
              >
                （正文为空，请展开上方「思考过程」查看进展说明）
              </p>
              </div>
              <footer class="reply-panel-footer">
                <div class="message-actions reply-actions-bar">
                  <button
                    type="button"
                    class="message-action-btn"
                    @click="copyMessageText(r.text, { replyKey: `${t.id}-${idx}` })"
                  >
                    {{ copyAckKey === `${t.id}-${idx}` ? '已复制' : '复制' }}
                  </button>
                  <button
                    type="button"
                    class="message-action-btn"
                    @click="downloadMarkdown(`report_${t.id}_${idx}.md`, r.text)"
                  >
                    下载 .md
                  </button>
                  <span
                    v-if="turnUnifiedCiteSources(t).length"
                    class="reply-actions-meta"
                  >来源 {{ turnUnifiedCiteSources(t).length }}</span>
                </div>
              </footer>
            </div>
          </div>

          <div v-if="shouldShowTurnFeedback(t)" class="turn-feedback-bar chat-agent-stack">
            <template v-if="!turnFeedbackSubmitted(t)">
              <span class="turn-feedback-label">这轮回复有帮助吗？</span>
              <div class="turn-feedback-actions">
                <span v-if="isFeedbackPendingForTurn(t)" class="turn-feedback-pending">{{ FEEDBACK_PENDING_ACK }}</span>
                <button
                  type="button"
                  class="message-action-btn message-action-btn-fb"
                  :disabled="isFeedbackPendingForTurn(t)"
                  :title="connected ? undefined : '离线也可标记，联网后将同步到服务端'"
                  @click.stop="void sendFeedback(t, 1)"
                >
                  有用
                </button>
                <button
                  type="button"
                  class="message-action-btn message-action-btn-fb"
                  :disabled="isFeedbackPendingForTurn(t)"
                  :title="connected ? undefined : '离线也可标记，联网后将同步到服务端'"
                  @click.stop="void sendFeedback(t, 0)"
                >
                  无用
                </button>
                <button
                  type="button"
                  class="message-action-btn message-action-btn-fb"
                  :disabled="isFeedbackPendingForTurn(t) || routeFeedbackSubmitted(t)"
                  @click.stop="sendRouteWrongFeedback(t)"
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
