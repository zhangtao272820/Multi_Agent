<script setup lang="ts">
/**
 * DeepSeek Harness 风专才可视化：工具调用卡片 + 运行态脉冲 + 高级专才徽章。
 * 纯展示，不改路由合同。
 */
import type { TurnGroup } from '~/composables/managerChatTypes'
import {
  getAgentDisplay,
  agentToneClass,
  type AgentDisplayTone
} from '~/composables/managerAgentDisplay'
import type { PipelineStepLike } from '~/utils/turnActivity'
import { computed, ref, watch } from 'vue'

const ADVANCED_KEYS = new Set(['gui', 'lobster', 'admin', 'multimodal', 'music', 'video', 'code'])

const TOOL_GLYPH: Record<string, string> = {
  db: '⊞',
  rag: '◈',
  crawler: '◎',
  code: '⌘',
  clean: '◇',
  visualize: '▦',
  report: '▤',
  admin: '✦',
  gui: '▣',
  lobster: '▣',
  multimodal: '◉',
  music: '♪',
  video: '▶'
}

const props = defineProps<{
  turn: TurnGroup
  running: boolean
  steps: PipelineStepLike[]
  routeAgents?: string[]
  statusLabel: (status: string) => string
}>()

type SpecialistCard = {
  key: string
  display: AgentDisplayTone
  status: string
  summary?: string
  query?: string
  advanced: boolean
  toneClass: string
  glyph: string
}

function normalizeStatus(raw: string): string {
  const s = String(raw || '').toLowerCase()
  if (s === 'running' || s === 'success' || s === 'failed' || s === 'pending' || s === 'replan') return s
  if (s.includes('replan')) return 'replan'
  return 'pending'
}

const cards = computed((): SpecialistCard[] => {
  const byKey = new Map<string, SpecialistCard>()

  const ensure = (agent: string, status = 'pending', summary?: string, query?: string) => {
    const d = getAgentDisplay(agent)
    const key = d.key || String(agent || '').toLowerCase()
    if (!key || key === 'manager' || key === 'manager_llm' || key === 'synth' || key === 'route' || key === 'planner' || key === 'multi') {
      return
    }
    const existing = byKey.get(key)
    const nextStatus = normalizeStatus(status)
    if (!existing) {
      byKey.set(key, {
        key,
        display: d,
        status: nextStatus,
        summary: summary || undefined,
        query: query || undefined,
        advanced: ADVANCED_KEYS.has(key),
        toneClass: agentToneClass(key),
        glyph: TOOL_GLYPH[key] || '⬡'
      })
      return
    }
    const rank = { pending: 0, running: 1, replan: 2, success: 3, failed: 4 } as Record<string, number>
    if ((rank[nextStatus] ?? 0) >= (rank[existing.status] ?? 0)) {
      existing.status = nextStatus
    }
    if (summary) existing.summary = summary
    if (query) existing.query = query
  }

  for (const a of props.routeAgents || []) ensure(a, props.running ? 'pending' : 'success')
  for (const s of props.steps || []) {
    ensure(s.agent, s.status, s.summary, s.query)
  }

  return Array.from(byKey.values())
})

const show = computed(() => cards.value.length > 0)

const openKeys = ref<Set<string>>(new Set())

watch(
  () => [props.turn.id, props.running, cards.value.map((c) => `${c.key}:${c.status}`).join('|')] as const,
  () => {
    const next = new Set<string>()
    for (const c of cards.value) {
      if (c.status === 'running' || (props.running && c.status === 'pending' && cards.value.length <= 3)) {
        next.add(c.key)
      }
    }
    // 保留用户已展开的卡
    for (const k of openKeys.value) {
      if (cards.value.some((c) => c.key === k)) next.add(k)
    }
    openKeys.value = next
  },
  { immediate: true }
)

function isOpen(key: string): boolean {
  return openKeys.value.has(key)
}

function toggleCard(key: string) {
  const next = new Set(openKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openKeys.value = next
}

function statusChip(status: string): string {
  if (status === 'running') return '执行中'
  if (status === 'success') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'replan') return '调整中'
  return '等待'
}
</script>

<template>
  <div v-if="show" class="mgr-tool-rail" aria-label="专才执行">
    <div class="mgr-tool-rail-head">
      <span class="mgr-tool-rail-title">专才执行</span>
      <span class="mgr-tool-rail-count">{{ cards.filter((c) => c.status === 'success').length }}/{{ cards.length }}</span>
    </div>
    <!-- Harness 顶栏：专才流水线缩略 -->
    <div class="mgr-tool-rail-flow" aria-hidden="true">
      <span
        v-for="(c, i) in cards"
        :key="`flow-${c.key}`"
        class="mgr-tool-flow-node"
        :class="[c.toneClass, `is-${c.status}`]"
        :style="{
          '--spec-fg': c.display.fg,
          '--spec-bg': c.display.bg,
          '--spec-border': c.display.border
        }"
      >
        <span class="mgr-tool-flow-dot" aria-hidden="true"></span>
        <span class="mgr-tool-flow-glyph">{{ c.glyph }}</span>
        <span class="mgr-tool-flow-name">{{ c.display.starName || c.display.verbLabel }}</span>
        <span v-if="i < cards.length - 1" class="mgr-tool-flow-arrow">→</span>
      </span>
    </div>

    <div class="mgr-tool-calls">
      <article
        v-for="c in cards"
        :key="`${turn.id}-${c.key}`"
        class="mgr-tool-call"
        :class="[
          c.toneClass,
          `is-${c.status}`,
          {
            'is-advanced': c.advanced,
            'is-open': isOpen(c.key),
            'is-running': c.status === 'running',
            'is-success': c.status === 'success',
            'is-failed': c.status === 'failed'
          }
        ]"
        :style="{
          '--spec-fg': c.display.fg,
          '--spec-bg': c.display.bg,
          '--spec-border': c.display.border
        }"
      >
        <button
          type="button"
          class="mgr-tool-call-summary"
          :aria-expanded="isOpen(c.key)"
          @click="toggleCard(c.key)"
        >
          <span class="mgr-tool-call-chevron" aria-hidden="true">{{ isOpen(c.key) ? '▾' : '▸' }}</span>
          <span class="mgr-tool-call-status-dot" aria-hidden="true"></span>
          <span class="mgr-tool-call-glyph" aria-hidden="true">{{ c.glyph }}</span>
          <span class="mgr-tool-call-meta">
            <span class="mgr-tool-call-title">
              <span v-if="c.display.starName" class="mgr-tool-star">{{ c.display.starName }}</span>
              <span class="mgr-tool-verb">{{ c.display.verbLabel }}</span>
              <span v-if="c.advanced" class="mgr-tool-advanced">高级</span>
            </span>
            <span class="mgr-tool-call-one-line">{{
              c.summary || c.query || (c.status === 'running' ? '处理中…' : c.display.verbLabel)
            }}</span>
          </span>
          <span class="mgr-tool-call-chip" :class="`is-${c.status}`">{{ statusChip(c.status) }}</span>
        </button>

        <div v-if="isOpen(c.key)" class="mgr-tool-call-body">
          <div v-if="c.query" class="mgr-tool-block">
            <div class="mgr-tool-block-label">正在处理</div>
            <pre class="mgr-tool-block-pre">{{ c.query.slice(0, 200) }}</pre>
          </div>
          <div v-if="c.summary" class="mgr-tool-block">
            <div class="mgr-tool-block-label">进展</div>
            <pre class="mgr-tool-block-pre">{{ c.summary.slice(0, 240) }}</pre>
          </div>
          <p v-if="!c.query && !c.summary && c.status === 'running'" class="mgr-tool-waiting">
            处理中…
          </p>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.mgr-tool-rail {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  width: 100%;
  max-width: 100%;
  margin: 0 0 0.85rem;
}

.mgr-tool-rail-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.15rem;
  padding: 0.15rem 0.1rem;
}

.mgr-tool-flow-node {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  font-size: 11px;
  color: #64748b;
}

.mgr-tool-flow-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #cbd5e1;
  flex-shrink: 0;
}

.mgr-tool-flow-node.is-running .mgr-tool-flow-dot {
  background: var(--spec-fg, #2563eb);
}

.mgr-tool-flow-node.is-success .mgr-tool-flow-dot {
  background: #16a34a;
}

.mgr-tool-flow-node.is-failed .mgr-tool-flow-dot {
  background: #dc2626;
}

.mgr-tool-call-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
  flex-shrink: 0;
}

.mgr-tool-call.is-running .mgr-tool-call-status-dot {
  background: var(--spec-fg, #2563eb);
}

.mgr-tool-call.is-success .mgr-tool-call-status-dot {
  background: #16a34a;
}

.mgr-tool-call.is-failed .mgr-tool-call-status-dot {
  background: #dc2626;
}

.mgr-tool-call-one-line {
  font-size: 11.5px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.mgr-tool-rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 0.2rem;
}

.mgr-tool-rail-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #64748b;
}

.mgr-tool-rail-count {
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.mgr-tool-flow-node.is-running {
  color: var(--spec-fg, #2563eb);
  font-weight: 650;
}

.mgr-tool-flow-node.is-success {
  color: #334155;
}

.mgr-tool-flow-node.is-failed {
  color: #b91c1c;
}

.mgr-tool-flow-glyph {
  font-size: 11px;
  opacity: 0.85;
}

.mgr-tool-flow-name {
  max-width: 6.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mgr-tool-flow-arrow {
  margin: 0 0.2rem;
  color: #94a3b8;
  font-size: 10px;
}

.mgr-tool-calls {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.mgr-tool-call {
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 10px;
  background: rgba(248, 250, 252, 0.92);
  overflow: hidden;
  box-shadow: none;
}

.mgr-tool-call.is-advanced {
  border-color: var(--spec-border, rgba(148, 163, 184, 0.45));
  background: linear-gradient(165deg, rgba(255, 255, 255, 0.96), var(--spec-bg, rgba(248, 250, 252, 0.92)));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--spec-border) 28%, transparent);
}

.mgr-tool-call.is-running {
  border-color: color-mix(in srgb, var(--spec-fg, #2563eb) 45%, rgba(148, 163, 184, 0.35));
  animation: mgr-tool-pulse 1.7s ease-in-out infinite;
}

@keyframes mgr-tool-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--spec-fg, #2563eb) 28%, transparent);
  }
}

.mgr-tool-call-summary {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 0.7rem;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: inherit;
}

.mgr-tool-call-summary:hover {
  background: rgba(15, 23, 42, 0.03);
}

.mgr-tool-call-chevron {
  flex-shrink: 0;
  width: 0.9rem;
  font-size: 10px;
  color: #94a3b8;
}

.mgr-tool-call-glyph {
  flex-shrink: 0;
  width: 1.55rem;
  height: 1.55rem;
  display: inline-grid;
  place-items: center;
  border-radius: 7px;
  font-size: 12px;
  color: var(--spec-fg, #334155);
  background: var(--spec-bg, rgba(148, 163, 184, 0.12));
  border: 1px solid var(--spec-border, rgba(148, 163, 184, 0.28));
}

.mgr-tool-call-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.mgr-tool-call-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.3rem 0.45rem;
}

.mgr-tool-star {
  font-size: 13px;
  font-weight: 650;
  color: var(--spec-fg, #0f172a);
}

.mgr-tool-verb {
  font-size: 13px;
  font-weight: 500;
  color: #334155;
}

.mgr-tool-advanced {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.03em;
  padding: 0.08rem 0.4rem;
  border-radius: 999px;
  color: var(--spec-fg);
  border: 1px solid var(--spec-border);
  background: rgba(255, 255, 255, 0.65);
}

.mgr-tool-call-sub {
  font-size: 11px;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.mgr-tool-call-chip {
  flex-shrink: 0;
  font-size: 11px;
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
  color: #64748b;
  background: rgba(241, 245, 249, 0.95);
  border: 1px solid rgba(226, 232, 240, 0.95);
}

.mgr-tool-call-chip.is-running {
  color: var(--spec-fg, #1d4ed8);
  border-color: color-mix(in srgb, var(--spec-fg, #1d4ed8) 35%, white);
  background: color-mix(in srgb, var(--spec-bg, #eff6ff) 80%, white);
  font-weight: 650;
}

.mgr-tool-call-chip.is-success {
  color: #15803d;
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(240, 253, 244, 0.9);
}

.mgr-tool-call-chip.is-failed {
  color: #b91c1c;
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(254, 242, 242, 0.95);
}

.mgr-tool-call-body {
  padding: 0 0.75rem 0.7rem 2.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  border-top: 1px solid rgba(226, 232, 240, 0.85);
}

.mgr-tool-caps {
  display: flex;
  flex-wrap: wrap;
  gap: 0.28rem;
  list-style: none;
  margin: 0.45rem 0 0;
  padding: 0;
}

.mgr-tool-caps li {
  font-size: 11px;
  color: #64748b;
  padding: 0.1rem 0.42rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(148, 163, 184, 0.28);
}

.mgr-tool-block {
  margin: 0;
}

.mgr-tool-block-label {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 0.2rem;
}

.mgr-tool-block-pre {
  margin: 0;
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.03);
  border: 1px solid rgba(226, 232, 240, 0.95);
  color: #475569;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.mgr-tool-waiting {
  margin: 0.35rem 0 0;
  font-size: 12px;
  color: #94a3b8;
  font-style: italic;
}
</style>
