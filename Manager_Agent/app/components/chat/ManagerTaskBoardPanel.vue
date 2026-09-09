<script setup lang="ts">
/**
 * 任务板面板：用户面 compact / 侧栏完整。
 */
import {
  humanizeAcceptanceReason,
  stepBoardStatusLabelZh,
  topologyLabelZh,
  type TaskBoardItemUi
} from '~/composables/managerMaturityUi'

const props = withDefaults(
  defineProps<{
    items: TaskBoardItemUi[]
    topology?: string
    /** compact：聊天气泡内轻量进度 */
    compact?: boolean
    planAgentLabel: (agent: string) => string
  }>(),
  { compact: false, topology: '' }
)

const topo = computed(() => topologyLabelZh(props.topology))
const doneCount = computed(
  () =>
    props.items.filter((i) => i.status === 'success' || i.status === 'skipped').length
)

function tipFor(it: TaskBoardItemUi): string {
  if (it.status === 'replan' || it.status === 'failed') {
    return humanizeAcceptanceReason(it.reason)
  }
  return ''
}
</script>

<template>
  <section
    class="mgr-task-board"
    :class="{ 'is-compact': compact }"
    :aria-label="compact ? '处理进度' : '任务板'"
  >
    <header class="mgr-task-board-head">
      <div class="mgr-task-board-title-row">
        <span class="mgr-task-board-title">{{ compact ? '处理进度' : '任务板' }}</span>
        <span v-if="topo" class="mgr-task-board-topo">{{ topo }}</span>
      </div>
      <span class="mgr-task-board-count">{{ doneCount }}/{{ items.length }}</span>
    </header>
    <ol class="mgr-task-board-list">
      <li
        v-for="(it, idx) in items"
        :key="it.id"
        class="mgr-task-board-item"
        :class="[`is-${it.status}`, { 'is-optional': it.optional }]"
      >
        <span class="mgr-task-board-idx" aria-hidden="true">{{ idx + 1 }}</span>
        <div class="mgr-task-board-body">
          <div class="mgr-task-board-row">
            <span class="mgr-task-board-agent">{{ planAgentLabel(it.agent) }}</span>
            <span class="mgr-task-board-status">{{ stepBoardStatusLabelZh(it.status) }}</span>
          </div>
          <p v-if="!compact && it.query" class="mgr-task-board-query" :title="it.query">
            {{ it.query }}
          </p>
          <p v-if="tipFor(it)" class="mgr-task-board-tip">{{ tipFor(it) }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>
