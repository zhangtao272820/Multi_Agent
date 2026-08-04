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
      'thought-view-user': thoughtViewMode === 'user',
      'thought-view-developer': thoughtViewMode === 'developer',
      'posture-debug': collaborationPosture === 'debug',
      'posture-ask': collaborationPosture === 'ask',
      'posture-plan': collaborationPosture === 'plan'
    }"
  >
    <ClientOnly>
      <CosmicGalaxyLane side="full" class="spring-bg-unified" :agent-thinking="agentCosmicActive" aria-hidden="true" />
    </ClientOnly>
    <div class="spring-container cosmic-command-deck">
      <div class="cosmic-hud-readout" :class="{ 'is-chat-hud': workbenchMode === 'chat' }" aria-hidden="true">
        <span class="cosmic-hud-tag">STELLAR CMD</span>
        <span class="cosmic-hud-tag">{{ connected ? 'LINK · OK' : 'LINK · OFF' }}</span>
      </div>
      <ManagerWorkbenchHeader
        :connected="connected"
        :current-run-id="currentRunId"
        :live-phase-text="livePhaseText"
        :route-cap-live="routeCapLive"
        :plan-steps-todo="planStepsTodo"
        :plan-steps-done-count="planStepsDoneCount"
        :current-phase="currentPhase"
        :collab-status-items="collabStatusItems"
        :step-progress-line="stepProgressLine"
        :active-trace-id="activeTraceId"
        :conversation-compact-live="conversationCompactLive"
        :workbench-mode="workbenchMode"
        :thought-view-mode="thoughtViewMode"
        :history-panel-open="historyPanelOpen"
        :sidebar-open="sidebarOpen"
        :tools-badge-count="toolsBadgeCount"
        :plan-agent-label="planAgentLabel"
        :collab-status-short="collabStatusShort"
        @set-thought-view-mode="setThoughtViewMode"
        @toggle-history="historyPanelOpen = !historyPanelOpen"
        @toggle-sidebar="sidebarOpen = !sidebarOpen"
        @open-trace-drawer="openTraceDrawer"
      />

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

      <ManagerHumanConfirmBar
        v-if="pendingHumanConfirm"
        :title="pendingHumanConfirm.title"
        :message="pendingHumanConfirm.message"
        :agent="pendingHumanConfirm.agent"
        :screenshot="pendingHumanConfirm.screenshotDataUrl || latestGuiScreenshot"
        :page-url="pendingHumanConfirm.pageUrl"
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
import AppModal from '~/components/AppModal.vue'
import ManagerTraceDrawer from '~/components/workbench/ManagerTraceDrawer.vue'

useHead({ title: '天机 · Manager' })

const {
  agentCosmicActive,
  workbenchMode,
  thoughtViewMode,
  collaborationPosture,
  connected,
  currentRunId,
  livePhaseText,
  routeCapLive,
  planStepsTodo,
  planStepsDoneCount,
  currentPhase,
  collabStatusItems,
  stepProgressLine,
  activeTraceId,
  conversationCompactLive,
  traceDrawerOpen,
  openTraceDrawer,
  closeTraceDrawer,
  runObservabilityLive,
  formatObsMs,
  formatTokenCount,
  obsDisplayLabel,
  historyPanelOpen,
  sidebarOpen,
  toolsBadgeCount,
  planAgentLabel,
  collabStatusShort,
  setWorkbenchMode,
  setThoughtViewMode,
  newSession,
  pendingHumanConfirm,
  latestGuiScreenshot,
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
