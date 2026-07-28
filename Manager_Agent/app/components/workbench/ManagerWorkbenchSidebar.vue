<script setup lang="ts">
import { inject, ref, watch } from 'vue'
import { MANAGER_WORKBENCH_SIDEBAR_KEY } from '~/composables/managerWorkbenchSidebarContext'

const ctx = inject(MANAGER_WORKBENCH_SIDEBAR_KEY)
if (!ctx) throw new Error('ManagerWorkbenchSidebar: missing context')

const {
  sidebarOpen,
  taskConstraintsLive,
  runObservabilityLive,
  formatObsMs,
  formatTokenCount,
  runPhaseBarMaxMs,
  obsPhaseColor,
  obsDisplayLabel,
  runTokenByAgentEntries,
  runTokenByTierEntries,
  obsAgentColor,
  runTokenBarMax,
  planAgentLabel,
  connected,
  clearingExperience,
  onClearExperience,
  evolutionLoading,
  loadEvolutionDashboard,
  evolutionSummary,
  healthChips,
  learningChartPoints,
  learningChartEl,
  learningRecent,
  opsToken,
  evolutionExperiments,
  previewText,
  opsBusy,
  promoteExperiment,
  rollbackExperiment,
  userGoalsActiveCount,
  userGoals,
  userId,
  userGoalOverdue,
  formatShortDate,
  taskPriorityLabel,
  setUserGoalStatus,
  removeUserGoal,
  userGoalDraft,
  userGoalsSaving,
  addUserGoal,
  taskStackActiveCount,
  taskStack,
  proactiveNudges,
  dismissProactiveNudge,
  taskStackSyncing,
  syncTaskStackInsights,
  taskOverdue,
  taskStatusLabel,
  setTaskStackItemStatus,
  removeTaskFromStack,
  taskStackDraft,
  taskStackSaving,
  addTaskToStack
} = ctx

const localLearningChartEl = ref<HTMLElement | null>(null)
watch(localLearningChartEl, (el) => {
  learningChartEl.value = el
})
</script>

<template>
        <div v-if="sidebarOpen" class="spring-sidebar-backdrop" @click="sidebarOpen = false" />
        <aside class="spring-sidebar cosmic-bridge-sidebar cursor-tools-pane" :class="{ collapsed: !sidebarOpen }" aria-label="偏好与工具">
          <div class="spring-sidebar-inner">
            <section v-if="taskConstraintsLive" class="spring-side-section spring-task-constraints">
              <div class="spring-side-title">任务约束</div>
              <ul class="spring-constraints-list">
                <li v-if="taskConstraintsLive.timeHints?.length">
                  <span class="spring-constraints-k">时间</span>
                  {{ taskConstraintsLive.timeHints.join('、') }}
                </li>
                <li v-if="taskConstraintsLive.subjectHints?.length">
                  <span class="spring-constraints-k">对象</span>
                  {{ taskConstraintsLive.subjectHints.join('、') }}
                </li>
                <li v-if="taskConstraintsLive.wantsVisualize">
                  <span class="spring-constraints-k">输出</span>需要图表/可视化
                </li>
                <li v-if="taskConstraintsLive.wantsReport">
                  <span class="spring-constraints-k">输出</span>需要报告/结论
                </li>
              </ul>
            </section>

            <section
              v-if="runObservabilityLive?.phaseTimeline?.length || runObservabilityLive?.tokenSummary?.totalTokens"
              class="spring-side-section spring-run-observability"
            >
              <div class="spring-side-title">本轮耗时 · Token</div>
              <div
                v-if="runObservabilityLive?.wallClockMs || runObservabilityLive?.tokenSummary?.totalTokens"
                class="spring-run-obs-stats"
              >
                <div v-if="runObservabilityLive?.wallClockMs" class="spring-run-obs-stat-card">
                  <span class="spring-run-obs-stat-icon" aria-hidden="true">⏱</span>
                  <div class="spring-run-obs-stat-body">
                    <span class="spring-run-obs-stat-value">{{ formatObsMs(runObservabilityLive.wallClockMs) }}</span>
                    <span class="spring-run-obs-stat-label">总耗时</span>
                  </div>
                </div>
                <div v-if="runObservabilityLive?.tokenSummary?.totalTokens" class="spring-run-obs-stat-card">
                  <span class="spring-run-obs-stat-icon" aria-hidden="true">◈</span>
                  <div class="spring-run-obs-stat-body">
                    <span class="spring-run-obs-stat-value">{{ formatTokenCount(runObservabilityLive.tokenSummary.totalTokens) }}</span>
                    <span class="spring-run-obs-stat-label">{{
                      runObservabilityLive?.tokenSummary?.tokenAccounting === 'actual'
                        ? 'Token'
                        : runObservabilityLive?.tokenSummary?.tokenAccounting === 'mixed'
                          ? 'Token·混合'
                          : 'Token·估算'
                    }}</span>
                  </div>
                </div>
                <div
                  v-if="runObservabilityLive?.tokenSummary?.totalUsd"
                  class="spring-run-obs-stat-card"
                  title="本轮估算费用"
                >
                  <span class="spring-run-obs-stat-icon" aria-hidden="true">$</span>
                  <div class="spring-run-obs-stat-body">
                    <span class="spring-run-obs-stat-value">{{
                      Number(runObservabilityLive.tokenSummary.totalUsd).toFixed(4)
                    }}</span>
                    <span class="spring-run-obs-stat-label">USD</span>
                  </div>
                </div>
              </div>
              <!-- U4：能力层 tier 成本条 -->
              <div v-if="runTokenByTierEntries.length" class="spring-run-token-chart spring-run-cost-bar">
                <div class="spring-run-chart-label">能力层 Token（T0～T3）</div>
                <ul class="spring-run-token-list spring-run-token-list--viz">
                  <li
                    v-for="([tier, tokens], i) in runTokenByTierEntries"
                    :key="tier"
                    class="spring-run-token-row"
                    :style="{ '--token-color': obsAgentColor(tier), '--bar-delay': `${i * 0.06}s` }"
                  >
                    <div class="spring-run-token-meta">
                      <span class="spring-run-token-agent" :title="tier">{{ tier }}</span>
                      <span class="spring-run-token-n">{{ formatTokenCount(tokens) }}</span>
                    </div>
                    <div class="spring-run-token-bar">
                      <div
                        class="spring-run-token-fill"
                        :style="{
                          width: `${Math.max(4, Math.round((tokens / Math.max(1, ...runTokenByTierEntries.map(([, n]) => n))) * 100))}%`
                        }"
                      />
                    </div>
                  </li>
                </ul>
              </div>
              <div v-if="runObservabilityLive?.phaseTimeline?.length" class="spring-run-phase-chart">
                <div class="spring-run-chart-label">阶段耗时</div>
                <ul class="spring-run-phase-list spring-run-phase-list--viz">
                  <li
                    v-for="(item, i) in runObservabilityLive.phaseTimeline"
                    :key="`${item.phase}-${i}`"
                    class="spring-run-phase-row"
                    :style="{ '--phase-color': obsPhaseColor(item), '--bar-delay': `${i * 0.07}s` }"
                  >
                    <div class="spring-run-phase-meta">
                      <span class="spring-run-phase-name" :title="item.agent || item.phase">{{ obsDisplayLabel(item) }}</span>
                      <span class="spring-run-phase-ms">{{ formatObsMs(item.ms) }}</span>
                    </div>
                    <div class="spring-run-phase-bar">
                      <div
                        class="spring-run-phase-fill spring-run-phase-fill--animated"
                        :style="{ width: `${Math.max(4, Math.round((item.ms / runPhaseBarMaxMs) * 100))}%` }"
                      />
                    </div>
                  </li>
                </ul>
              </div>
              <div v-if="runTokenByAgentEntries.length" class="spring-run-token-chart">
                <div class="spring-run-chart-label">Token 分布</div>
                <ul class="spring-run-token-list spring-run-token-list--viz">
                  <li
                    v-for="([agent, tokens], i) in runTokenByAgentEntries"
                    :key="agent"
                    class="spring-run-token-row"
                    :style="{ '--token-color': obsAgentColor(agent), '--bar-delay': `${i * 0.06}s` }"
                  >
                    <div class="spring-run-token-meta">
                      <span class="spring-run-token-agent" :title="agent">{{ planAgentLabel(agent) }}</span>
                      <span class="spring-run-token-n">{{ formatTokenCount(tokens) }}</span>
                    </div>
                    <div class="spring-run-token-bar">
                      <div
                        class="spring-run-token-fill spring-run-token-fill--animated"
                        :style="{ width: `${Math.max(4, Math.round((tokens / runTokenBarMax) * 100))}%` }"
                      />
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            <section class="spring-side-section spring-side-actions">
              <button type="button" class="spring-btn alt spring-btn-sm" :disabled="!connected || clearingExperience" @click="onClearExperience">
                {{ clearingExperience ? '清除中…' : '清除经验' }}
              </button>
              <button type="button" class="spring-btn alt spring-btn-sm" :disabled="evolutionLoading" @click="loadEvolutionDashboard">
                {{ evolutionLoading ? '…' : '刷新进化看板' }}
              </button>
            </section>

            <details v-if="evolutionSummary || healthChips.length" class="spring-evolution spring-side-fold">
              <summary>状态 · 进化</summary>
              <div class="spring-evolution-body">
                <div v-if="healthChips.length" class="spring-health-chips">
                  <span v-for="h in healthChips" :key="h.agent" class="health-chip" :class="`is-${h.status}`" :title="h.tip">
                    {{ h.agent }}<span class="health-transport">{{ h.transport }}</span>
                  </span>
                </div>
                <div v-if="evolutionSummary" class="spring-evo-stats">
                  <span v-if="evolutionSummary.metricLine" class="evo-pill">{{ evolutionSummary.metricLine }}</span>
                  <span v-if="evolutionSummary.evolveLine" class="evo-pill">{{ evolutionSummary.evolveLine }}</span>
                  <span v-if="evolutionSummary.canaryLine" class="evo-pill">{{ evolutionSummary.canaryLine }}</span>
                  <span v-if="evolutionSummary.experimentLine" class="evo-pill evo-pill-exp">{{ evolutionSummary.experimentLine }}</span>
                  <span v-if="evolutionSummary.memoryLine" class="evo-pill evo-pill-mem">{{ evolutionSummary.memoryLine }}</span>
                  <span v-if="evolutionSummary.learningLine" class="evo-pill">{{ evolutionSummary.learningLine }}</span>
                  <span v-if="evolutionSummary.searchMetricsLine" class="evo-pill evo-pill-search" :title="evolutionSummary.searchMetricsTip">{{
                    evolutionSummary.searchMetricsLine
                  }}</span>
                  <span v-if="evolutionSummary.proactiveLine" class="evo-pill evo-pill-pro">{{ evolutionSummary.proactiveLine }}</span>
                  <span v-if="evolutionSummary.userGoalsLine" class="evo-pill evo-pill-goal">{{ evolutionSummary.userGoalsLine }}</span>
                  <span v-if="evolutionSummary.weightsLine" class="evo-pill evo-pill-wt">{{ evolutionSummary.weightsLine }}</span>
                  <span v-if="evolutionSummary.satisfactionLine" class="evo-pill">{{ evolutionSummary.satisfactionLine }}</span>
                  <span v-if="evolutionSummary.routeStrategyLine" class="evo-pill evo-pill-strategy">{{ evolutionSummary.routeStrategyLine }}</span>
                  <span v-if="evolutionSummary.autonomousLine" class="evo-pill evo-pill-auto">{{ evolutionSummary.autonomousLine }}</span>
                  <span v-if="evolutionSummary.worldModelLine" class="evo-pill evo-pill-wm" :title="evolutionSummary.worldModelTip">{{ evolutionSummary.worldModelLine }}</span>
                  <span v-if="evolutionSummary.writeGateLine" class="evo-pill evo-pill-gate">{{ evolutionSummary.writeGateLine }}</span>
                  <span v-if="evolutionSummary.llmHypoLine" class="evo-pill evo-pill-llm">{{ evolutionSummary.llmHypoLine }}</span>
                  <span v-if="evolutionSummary.banditLine" class="evo-pill evo-pill-bandit">{{ evolutionSummary.banditLine }}</span>
                  <span v-if="evolutionSummary.policyRlLine" class="evo-pill evo-pill-rl">{{ evolutionSummary.policyRlLine }}</span>
                  <span v-if="evolutionSummary.causalLine" class="evo-pill evo-pill-causal">{{ evolutionSummary.causalLine }}</span>
                  <span v-if="evolutionSummary.finalizeExtractLine" class="evo-pill evo-pill-ts">{{
                    evolutionSummary.finalizeExtractLine
                  }}</span>
                </div>
                <div v-if="learningChartPoints.length" class="spring-learning-chart-wrap">
                  <div class="spring-learning-title">学习信号趋势</div>
                  <div ref="localLearningChartEl" class="spring-learning-chart" />
                </div>
                <div v-if="learningRecent.length" class="spring-learning-recent">
                  <div class="spring-learning-title">近期学习信号</div>
                  <div v-for="(s, i) in learningRecent.slice(0, 5)" :key="i" class="spring-learning-item">
                    <span>{{ s.intent || '—' }}</span>
                    <span class="spring-learning-score">综合 {{ s.compositeScore ?? '—' }}</span>
                    <span v-if="typeof s.feedbackScore === 'number'" class="spring-learning-fb">反馈 {{ s.feedbackScore }}</span>
                    <span v-if="s.searchRequested" class="spring-learning-search">
                      联网 {{ s.searchHitCount ?? 0 }} 命中{{ s.searchRounds ? ` · ${s.searchRounds} 轮` : '' }}
                    </span>
                  </div>
                </div>
                <div v-if="evolutionExperiments.length" class="spring-exp-ops">
                  <div class="spring-learning-title">进化实验运维</div>
                  <input
                    v-model="opsToken"
                    type="password"
                    class="spring-ops-token-input"
                    placeholder="MANAGER_OPS_TOKEN"
                    autocomplete="off"
                  />
                  <div v-for="exp in evolutionExperiments" :key="exp.id" class="spring-exp-row">
                    <div class="spring-exp-meta">
                      <span class="spring-exp-id">{{ exp.artifact }} · {{ exp.status }}</span>
                      <span class="spring-exp-rationale">{{ previewText(exp.rationale, 72) }}</span>
                    </div>
                    <div class="spring-exp-actions">
                      <button type="button" class="spring-btn alt spring-btn-xs" :disabled="opsBusy" @click="promoteExperiment(exp.id)">晋级</button>
                      <button type="button" class="spring-btn alt spring-btn-xs" :disabled="opsBusy" @click="rollbackExperiment(exp.id)">回滚</button>
                    </div>
                  </div>
                </div>
              </div>
            </details>

            <details class="spring-user-goals spring-side-fold">
              <summary>用户级目标（{{ userGoalsActiveCount }}/{{ userGoals.length }}）</summary>
              <div class="spring-user-goals-body">
                <div class="spring-task-stack-hint">用户 ID：<code>{{ userId || '—' }}</code></div>
                <div v-if="userGoals.length" class="spring-goal-timeline">
                  <div
                    v-for="goal in userGoals"
                    :key="`tl-${goal.id}`"
                    class="spring-goal-timeline-item"
                    :class="[`is-${goal.status}`, userGoalOverdue(goal) ? 'is-overdue' : '']"
                  >
                    <span class="spring-goal-timeline-dot" />
                    <div class="spring-goal-timeline-body">
                      <div class="spring-goal-timeline-title">{{ previewText(goal.title, 56) }}</div>
                      <div class="spring-goal-timeline-meta">
                        <span v-if="goal.createdAt">创建 {{ formatShortDate(goal.createdAt) }}</span>
                        <span v-if="goal.updatedAt">更新 {{ formatShortDate(goal.updatedAt) }}</span>
                        <span v-if="goal.deadline" :class="userGoalOverdue(goal) ? 'overdue' : ''">截止 {{ formatShortDate(goal.deadline) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="userGoals.length" class="spring-task-stack-list spring-panel-list-scroll">
                  <div
                    v-for="goal in userGoals"
                    :key="goal.id"
                    class="spring-task-stack-item"
                    :class="[`is-${goal.status}`, userGoalOverdue(goal) ? 'is-overdue' : '']"
                  >
                    <div class="spring-task-stack-head">
                      <span class="spring-task-stack-title" :title="goal.title">{{ previewText(goal.title, 80) }}</span>
                      <span class="spring-task-stack-priority" :class="`prio-${goal.priority}`">{{ taskPriorityLabel(goal.priority) }}</span>
                    </div>
                    <div class="spring-task-stack-item-actions">
                      <button v-if="goal.status === 'active'" type="button" class="spring-btn alt spring-btn-xs" @click="setUserGoalStatus(goal.id, 'paused')">暂停</button>
                      <button v-if="goal.status === 'paused'" type="button" class="spring-btn alt spring-btn-xs" @click="setUserGoalStatus(goal.id, 'active')">恢复</button>
                      <button v-if="goal.status !== 'done'" type="button" class="spring-btn alt spring-btn-xs" @click="setUserGoalStatus(goal.id, 'done')">完成</button>
                      <button type="button" class="spring-btn alt spring-btn-xs" @click="removeUserGoal(goal.id)">删除</button>
                    </div>
                  </div>
                </div>
                <textarea v-model="userGoalDraft" class="spring-task-stack-input" rows="2" placeholder="跨会话长期目标…" />
                <button type="button" class="spring-btn alt spring-btn-sm" :disabled="userGoalsSaving" @click="addUserGoal">
                  {{ userGoalsSaving ? '保存中…' : '添加' }}
                </button>
              </div>
            </details>

            <details class="spring-task-stack spring-side-fold">
              <summary>
                任务栈（{{ taskStackActiveCount }}/{{ taskStack.length }}）
                <span v-if="proactiveNudges.length" class="spring-inline-badge">{{ proactiveNudges.length }}</span>
              </summary>
              <div class="spring-task-stack-body">
                <div class="spring-task-stack-hint">对话可说：待办：…、记住…、加入任务栈：…（自动入栈）</div>
                <div v-if="proactiveNudges.length" class="spring-proactive-list">
                  <div v-for="n in proactiveNudges.slice(0, 3)" :key="n.id" class="spring-proactive-item">
                    <div class="spring-proactive-msg">{{ previewText(n.message, 120) }}</div>
                    <button type="button" class="spring-btn alt spring-btn-xs" @click="dismissProactiveNudge(n.id)">知道了</button>
                  </div>
                </div>
                <button type="button" class="spring-btn alt spring-btn-sm" :disabled="taskStackSyncing" @click="syncTaskStackInsights">
                  {{ taskStackSyncing ? '同步中…' : '同步洞察' }}
                </button>
                <div v-if="taskStack.length" class="spring-task-stack-list spring-panel-list-scroll">
                  <div
                    v-for="task in taskStack"
                    :key="task.id"
                    class="spring-task-stack-item"
                    :class="[`is-${task.status}`, taskOverdue(task) ? 'is-overdue' : '']"
                  >
                    <div class="spring-task-stack-head">
                      <span class="spring-task-stack-title" :title="task.title">{{ previewText(task.title, 80) }}</span>
                      <span class="spring-task-stack-status">{{ taskStatusLabel(task.status) }}</span>
                    </div>
                    <div class="spring-task-stack-item-actions">
                      <button v-if="task.status === 'active'" type="button" class="spring-btn alt spring-btn-xs" @click="setTaskStackItemStatus(task.id, 'paused')">暂停</button>
                      <button v-if="task.status === 'paused'" type="button" class="spring-btn alt spring-btn-xs" @click="setTaskStackItemStatus(task.id, 'active')">恢复</button>
                      <button v-if="task.status !== 'done'" type="button" class="spring-btn alt spring-btn-xs" @click="setTaskStackItemStatus(task.id, 'done')">完成</button>
                      <button type="button" class="spring-btn alt spring-btn-xs" @click="removeTaskFromStack(task.id)">删</button>
                    </div>
                  </div>
                </div>
                <div class="spring-task-stack-form">
                  <textarea v-model="taskStackDraft" class="spring-task-stack-input" rows="2" placeholder="会话任务…" />
                  <div class="spring-task-stack-actions">
                    <button type="button" class="spring-btn alt spring-btn-sm" :disabled="taskStackSaving" @click="addTaskToStack">
                      {{ taskStackSaving ? '…' : '加入任务栈' }}
                    </button>
                  </div>
                </div>
              </div>
            </details>
          </div>
        </aside>
</template>
