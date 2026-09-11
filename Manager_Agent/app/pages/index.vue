<template>
  <ClientOnly>
    <ManagerLoginGate
      v-if="userAuthRequired && authReady && !isLoggedIn"
      @success="onLoginSuccess"
    />
  </ClientOnly>
  <div
    v-if="!userAuthRequired || (authReady && isLoggedIn)"
    class="spring-root cosmic-theme cursor-workbench"
    :class="{
      'cosmic-agent-thinking': agentCosmicActive,
      'mode-professional': workbenchMode === 'professional',
      'mode-chat': workbenchMode === 'chat',
      'thought-view-user': true,
      'thought-view-developer': false,
      'posture-debug': collaborationPosture === 'debug',
      'posture-ask': collaborationPosture === 'ask',
      'posture-plan': collaborationPosture === 'plan'
    }"
  >
    <div class="mgr-season-bg mgr-season-bg--xiaoxue" aria-hidden="true" />
    <ClientOnly>
      <BrandMotif motif="snow" :count="58" />
    </ClientOnly>
    <div class="spring-container cosmic-command-deck">
      <ManagerWorkbenchHeader
        :connected="connected"
        :current-run-id="currentRunId"
        :live-phase-text="livePhaseText"
        :route-cap-live="routeCapLive"
        :plan-steps-todo="planStepsTodo"
        :plan-steps-done-count="planStepsDoneCount"
        :conversation-compact-live="conversationCompactLive"
        :workbench-mode="workbenchMode"
        :history-panel-open="historyPanelOpen"
        :sidebar-open="sidebarOpen"
        :tools-badge-count="toolsBadgeCount"
        :plan-agent-label="planAgentLabel"
        @toggle-history="historyPanelOpen = !historyPanelOpen"
        @toggle-sidebar="sidebarOpen = !sidebarOpen"
      />

      <!-- 上线用户面：排障 Trace 抽屉保留代码但不在顶栏入口暴露 -->
      <ManagerTraceDrawer
        :open="traceDrawerOpen"
        :trace-id="activeTraceId || currentRunId"
        :run-id="currentRunId"
        :wall-clock-ms="runObservabilityLive?.wallClockMs"
        :phase-timeline="runObservabilityLive?.phaseTimeline"
        :token-total="runObservabilityLive?.tokenSummary?.totalTokens"
        :format-obs-ms="formatObsMs"
        :format-token-count="formatTokenCount"
        :obs-display-label="obsDisplayLabel"
        @close="closeTraceDrawer"
      />

      <ManagerReplyArtifactDrawer
        :open="artifactDrawerOpen"
        :turn="artifactDrawerTurn"
        :active-tab="artifactDrawerTab"
        :report-draft="artifactDrawerReportDraft"
        :build-turn-agent-results="buildTurnAgentResults"
        :user-facing-chart-option="userFacingChartOption"
        :user-facing-chart-title="userFacingChartTitle"
        :user-facing-table-html="userFacingTableHtml"
        :extract-echarts-option="extractEchartsOption"
        :extract-table-data="extractTableData"
        :render-table-data-html="renderTableDataHtml"
        :resolve-report-body="resolveReportBody"
        :render-report-markdown="renderReportMarkdown"
        :init-chart-el="initChartEl"
        :chart-container-class="chartContainerClass"
        :chart-container-style="chartContainerStyle"
        :download-echarts-png="downloadEchartsPng"
        :download-markdown="downloadMarkdown"
        @close="closeReplyArtifactDrawer"
        @update:active-tab="setArtifactDrawerTab"
        @apply-report="applyArtifactReportEdit"
        @export-bundle="exportArtifactBundle"
      />

      <ManagerHumanConfirmBar
        v-if="pendingHumanConfirm"
        :title="pendingHumanConfirm.title"
        :message="pendingHumanConfirm.message"
        :agent="pendingHumanConfirm.agent"
        :screenshot="pendingHumanConfirm.screenshotDataUrl || latestGuiScreenshot"
        :page-url="pendingHumanConfirm.pageUrl"
        :vnc-url="latestGuiVncUrl"
        :failure-type="pendingHumanConfirm.failureType"
        :lobster-run-id="pendingHumanConfirm.lobsterRunId"
        :sending="humanConfirmSending"
        @confirm="respondHumanConfirm('confirm')"
        @cancel="respondHumanConfirm('cancel')"
      />

      <div class="spring-body-row" ref="chatScrollHostEl">
        <ManagerSessionHistoryPanel
          :open="historyPanelOpen"
          :backdrop-visible="historyBackdropVisible"
          :session-id="sessionId"
          :items="sessionHistoryItems"
          :workbench-mode="workbenchMode"
          :format-history-time="formatHistoryTime"
          @close-backdrop="closeHistoryPanel"
          @new-session="newSession"
          @select="selectHistorySession"
          @rename="renameSessionHistory"
          @delete="deleteSessionHistory"
          @set-workbench-mode="setWorkbenchMode"
        />

        <div class="spring-main cursor-main-split" ref="chatMainEl">
          <ManagerWorkbenchSidebar v-if="workbenchMode === 'professional'" />

          <div
            class="spring-chat-column cursor-chat-main"
            ref="chatColumnEl"
            :class="workbenchMode === 'professional' ? 'wb-professional-column' : 'wb-chat-column'"
          >
            <ManagerChatRail :turns="visibleTurnGroups" />
          </div>
        </div>
      </div>
    </div>
    <AppModal
      v-model="modalOpen"
      :mode="modalMode"
      :title="modalTitle"
      :message="modalMessage"
      :confirm-text="modalConfirmText"
      :cancel-text="modalCancelText"
      :input-value="modalInputValue"
      :input-placeholder="modalInputPlaceholder"
      :input-max-length="80"
      @confirm="onModalConfirm"
      @cancel="onModalCancel"
    />
  </div>
</template>

<script setup lang="ts">
import BrandMotif from '@brand/vue/BrandMotif.vue'
import AppModal from '~/components/AppModal.vue'
import ManagerTraceDrawer from '~/components/workbench/ManagerTraceDrawer.vue'
import ManagerReplyArtifactDrawer from '~/components/workbench/ManagerReplyArtifactDrawer.vue'

useHead({ title: '天机 · Manager' })

const {
  agentCosmicActive,
  workbenchMode,
  collaborationPosture,
  connected,
  currentRunId,
  livePhaseText,
  routeCapLive,
  planStepsTodo,
  planStepsDoneCount,
  activeTraceId,
  conversationCompactLive,
  traceDrawerOpen,
  closeTraceDrawer,
  artifactDrawerOpen,
  artifactDrawerTurn,
  artifactDrawerTab,
  artifactDrawerReportDraft,
  closeReplyArtifactDrawer,
  setArtifactDrawerTab,
  applyArtifactReportEdit,
  exportArtifactBundle,
  buildTurnAgentResults,
  extractEchartsOption,
  userFacingChartOption,
  userFacingChartTitle,
  userFacingTableHtml,
  extractTableData,
  renderTableDataHtml,
  resolveReportBody,
  renderReportMarkdown,
  initChartEl,
  chartContainerClass,
  chartContainerStyle,
  downloadEchartsPng,
  downloadMarkdown,
  runObservabilityLive,
  formatObsMs,
  formatTokenCount,
  obsDisplayLabel,
  historyPanelOpen,
  sidebarOpen,
  toolsBadgeCount,
  planAgentLabel,
  setWorkbenchMode,
  newSession,
  pendingHumanConfirm,
  latestGuiScreenshot,
  latestGuiVncUrl,
  humanConfirmSending,
  respondHumanConfirm,
  chatScrollHostEl,
  historyBackdropVisible,
  sessionId,
  sessionHistoryItems,
  formatHistoryTime,
  closeHistoryPanel,
  selectHistorySession,
  renameSessionHistory,
  deleteSessionHistory,
  chatMainEl,
  visibleTurnGroups,
  chatColumnEl,
  modalOpen,
  modalMode,
  modalTitle,
  modalMessage,
  modalConfirmText,
  modalCancelText,
  modalInputValue,
  modalInputPlaceholder,
  onModalConfirm,
  onModalCancel
} = useManagerChatPage()

const runtimeConfig = useRuntimeConfig()
const userAuthRequired = computed(() => Boolean((runtimeConfig.public as any)?.managerUserAuth))
const { isLoggedIn, ready: authReady, loadFromStorage: loadClawAuth } = useClawhiveLogin()

/** 插件已 loadFromStorage；此处兜底 SSR/热更新后状态 */
onMounted(() => {
  if (!authReady.value) loadClawAuth()
})

function onLoginSuccess() {
  loadClawAuth()
}
</script>
