<script setup lang="ts">
import {
  listRosterAgents,
  type AgentDisplayTone
} from '~/composables/managerAgentDisplay'
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 本轮已参与的专才 key */
    activeKeys?: string[]
    /** 健康状态 map：agent -> status */
    healthByAgent?: Record<string, string>
    /** compact：空状态条；full：侧栏完整地图 */
    density?: 'compact' | 'full'
    title?: string
  }>(),
  {
    activeKeys: () => [],
    healthByAgent: () => ({}),
    density: 'full',
    title: '专才能力地图'
  }
)

const roster = computed(() => listRosterAgents())

const activeSet = computed(() => new Set((props.activeKeys || []).map((k) => String(k).toLowerCase())))

function isActive(agent: AgentDisplayTone) {
  return activeSet.value.has(agent.key)
}

function healthOf(agent: AgentDisplayTone) {
  return props.healthByAgent?.[agent.key] || ''
}

function cardStyle(agent: AgentDisplayTone) {
  return {
    '--cap-fg': agent.fg,
    '--cap-bg': agent.bg,
    '--cap-border': agent.border,
    '--cap-dot': agent.chart
  }
}
</script>

<template>
  <section
    class="agent-cap-map"
    :class="[`is-${density}`, { 'has-active': activeSet.size > 0 }]"
    :aria-label="title"
  >
    <header v-if="density === 'full'" class="agent-cap-map-head">
      <h3 class="agent-cap-map-title">{{ title }}</h3>
      <p class="agent-cap-map-hint">展示各专才能做什么；高亮为本轮已调用。不改变路由合同。</p>
    </header>
    <header v-else class="agent-cap-map-head is-compact">
      <span class="agent-cap-map-title">{{ title }}</span>
    </header>

    <div class="agent-cap-grid" :class="`density-${density}`">
      <article
        v-for="agent in roster"
        :key="agent.key"
        class="agent-cap-card"
        :class="[
          `agent-tone-${agent.key}`,
          {
            'is-active': isActive(agent),
            'is-idle': !isActive(agent) && activeSet.size > 0
          }
        ]"
        :style="cardStyle(agent)"
        :title="`${agent.starName} · ${agent.role}`"
      >
        <div class="agent-cap-card-top">
          <span class="agent-cap-dot" aria-hidden="true" />
          <div class="agent-cap-names">
            <span class="agent-cap-star">{{ agent.starName || agent.verbLabel }}</span>
            <span class="agent-cap-verb">{{ agent.verbLabel }}</span>
          </div>
          <span
            v-if="healthOf(agent)"
            class="agent-cap-health"
            :class="`is-${healthOf(agent)}`"
          >{{ healthOf(agent) }}</span>
          <span v-else-if="isActive(agent)" class="agent-cap-badge">本轮</span>
        </div>
        <ul v-if="density === 'full'" class="agent-cap-tags">
          <li v-for="cap in agent.capabilities.slice(0, 4)" :key="cap">{{ cap }}</li>
        </ul>
        <div v-else class="agent-cap-tags is-inline">
          <span v-for="cap in agent.capabilities.slice(0, 2)" :key="cap">{{ cap }}</span>
        </div>
      </article>
    </div>
  </section>
</template>
