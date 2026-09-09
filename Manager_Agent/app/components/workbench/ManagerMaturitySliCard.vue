<script setup lang="ts">
/**
 * 侧栏成熟度 SLI + 预算条（观测用，中文指标名）。
 */
import {
  formatAcceptanceRateZh,
  type MaturitySliUi
} from '~/composables/managerMaturityUi'

const props = defineProps<{
  sli: MaturitySliUi | null
  totalTokens?: number
  formatTokenCount: (n: number) => string
}>()

const rate = computed(() => (props.sli ? formatAcceptanceRateZh(props.sli.acceptanceRate) : '—'))
const budgetPct = computed(() => {
  // 软预算可视化：以专才轮次 p95 / 4 为参考（硬帽 4），不冒充真实美元
  const rounds = Number(props.sli?.specialistRoundsP95 || 0)
  if (!Number.isFinite(rounds) || rounds <= 0) return 0
  return Math.min(100, Math.round((rounds / 4) * 100))
})
</script>

<template>
  <section v-if="sli" class="mgr-maturity-sli" aria-label="本轮执行质量">
    <div class="spring-side-title">执行质量</div>
    <div class="spring-run-obs-stats mgr-maturity-sli-grid">
      <div class="spring-run-obs-stat-card">
        <span class="spring-run-obs-stat-icon" aria-hidden="true">验</span>
        <div class="spring-run-obs-stat-body">
          <span class="spring-run-obs-stat-value">{{ rate }}</span>
          <span class="spring-run-obs-stat-label">步验收</span>
        </div>
      </div>
      <div class="spring-run-obs-stat-card">
        <span class="spring-run-obs-stat-icon" aria-hidden="true">调</span>
        <div class="spring-run-obs-stat-body">
          <span class="spring-run-obs-stat-value">{{ sli.stepsReplan }}</span>
          <span class="spring-run-obs-stat-label">调整步</span>
        </div>
      </div>
      <div class="spring-run-obs-stat-card">
        <span class="spring-run-obs-stat-icon" aria-hidden="true">轮</span>
        <div class="spring-run-obs-stat-body">
          <span class="spring-run-obs-stat-value">{{ sli.specialistRoundsP95 || '—' }}</span>
          <span class="spring-run-obs-stat-label">专才轮次</span>
        </div>
      </div>
      <div class="spring-run-obs-stat-card">
        <span class="spring-run-obs-stat-icon" aria-hidden="true">规</span>
        <div class="spring-run-obs-stat-body">
          <span class="spring-run-obs-stat-value">{{ sli.localReplanCount }}</span>
          <span class="spring-run-obs-stat-label">本地重规划</span>
        </div>
      </div>
    </div>
    <div class="mgr-maturity-budget">
      <div class="mgr-maturity-budget-row">
        <span>专才轮次占用</span>
        <span>{{ budgetPct }}%</span>
      </div>
      <div class="mgr-maturity-budget-track" aria-hidden="true">
        <div class="mgr-maturity-budget-fill" :style="{ width: `${budgetPct}%` }" />
      </div>
      <div class="mgr-maturity-budget-meta">
        <span>Brief {{ sli.briefAttached > 0 ? '已启用' : '未启用' }}</span>
        <span>竞速 {{ sli.raceEnabled ? '开' : '关' }}</span>
        <span v-if="totalTokens">Token {{ formatTokenCount(totalTokens) }}</span>
      </div>
    </div>
  </section>
</template>
