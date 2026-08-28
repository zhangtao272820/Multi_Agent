<script setup lang="ts">
/** U1：Trace / 排障抽屉 — 复制 trace_id、阶段时间线、排障三问、Wave6 深链 */

export type TracePhaseItem = { phase: string; ms: number; agent?: string; tokens?: number }

const props = defineProps<{
  open: boolean
  traceId: string
  runId?: string
  wallClockMs?: number
  phaseTimeline?: TracePhaseItem[]
  tokenTotal?: number
  formatObsMs: (ms: number) => string
  formatTokenCount: (n: number) => string
  obsDisplayLabel: (item: TracePhaseItem) => string
}>()

const emit = defineEmits<{
  close: []
}>()

const copyAck = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null
const deepLinks = ref<{ langfuseUrl: string | null; tempoUrl: string | null } | null>(null)
const morphology = ref<{
  kind: string
  intent?: string
  taskIntent?: string
  taskForm?: string
  allowedAgents: string[]
  plan: Array<{ agent: string; dependsOn?: string[]; blast_radius?: string }>
  outcome?: string
  sourceCommitment?: string
  turnScopeMode?: string
  blast_radius?: string
  flags?: { needsClarify?: boolean; needsHumanConfirm?: boolean }
  memoryGovernance?: {
    experienceReplayCount?: number
    pathConflictDropped?: number
    pendingPrefsConflict?: string
    memoryCaptureKind?: string
    memoryCaptureStatus?: string
  }
} | null>(null)

async function copyTrace() {
  const id = String(props.traceId || '').trim()
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    copyAck.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copyAck.value = false
    }, 1600)
  } catch {
    /* ignore */
  }
}

async function loadDeepLinks() {
  const id = String(props.runId || props.traceId || '').trim()
  if (!id) {
    deepLinks.value = null
    morphology.value = null
    return
  }
  try {
    const res = await $fetch<{ langfuseUrl?: string | null; tempoUrl?: string | null }>(
      '/api/metrics/trace-links',
      { query: { runId: id } }
    )
    deepLinks.value = {
      langfuseUrl: res.langfuseUrl || null,
      tempoUrl: res.tempoUrl || null
    }
  } catch {
    deepLinks.value = null
  }
  try {
    const morph = await $fetch<{
      records?: Array<{
        kind: string
        intent?: string
        taskIntent?: string
        taskForm?: string
        allowedAgents?: string[]
        plan?: Array<{ agent: string; dependsOn?: string[]; blast_radius?: string }>
        outcome?: string
        sourceCommitment?: string
        turnScopeMode?: string
        blast_radius?: string
        flags?: { needsClarify?: boolean; needsHumanConfirm?: boolean }
        memoryGovernance?: {
          experienceReplayCount?: number
          pathConflictDropped?: number
          pendingPrefsConflict?: string
          memoryCaptureKind?: string
          memoryCaptureStatus?: string
        }
      }>
    }>('/api/metrics/agent-morphology', { query: { runId: id } })
    const rows = Array.isArray(morph.records) ? morph.records : []
    const pick = rows.find((r) => r.kind === 'final') || rows[0] || null
    morphology.value = pick
      ? {
          kind: pick.kind,
          intent: pick.intent,
          taskIntent: pick.taskIntent,
          taskForm: pick.taskForm,
          allowedAgents: Array.isArray(pick.allowedAgents) ? pick.allowedAgents : [],
          plan: Array.isArray(pick.plan) ? pick.plan : [],
          outcome: pick.outcome,
          sourceCommitment: pick.sourceCommitment,
          turnScopeMode: pick.turnScopeMode,
          blast_radius: pick.blast_radius,
          flags: pick.flags,
          memoryGovernance: pick.memoryGovernance
        }
      : null
  } catch {
    morphology.value = null
  }
}

watch(
  () => [props.open, props.traceId, props.runId] as const,
  ([open]) => {
    if (open) void loadDeepLinks()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mgr-trace-drawer-root" role="dialog" aria-modal="true" aria-label="排障 Trace">
      <button type="button" class="mgr-trace-drawer-backdrop" aria-label="关闭" @click="emit('close')" />
      <aside class="mgr-trace-drawer-panel">
        <header class="mgr-trace-drawer-head">
          <div>
            <h2 class="mgr-trace-drawer-title">排障 Trace</h2>
            <p class="mgr-trace-drawer-sub">对齐升级文档「排障三问」· N3 可观测</p>
          </div>
          <button type="button" class="mgr-trace-drawer-close" @click="emit('close')">关闭</button>
        </header>

        <section class="mgr-trace-drawer-section">
          <div class="mgr-trace-drawer-label">trace_id</div>
          <div class="mgr-trace-id-row">
            <code class="mgr-trace-id-full" :title="traceId">{{ traceId || '—' }}</code>
            <button type="button" class="mgr-trace-copy-btn" :disabled="!traceId" @click="copyTrace">
              {{ copyAck ? '已复制' : '复制' }}
            </button>
          </div>
          <p v-if="runId && runId !== traceId" class="mgr-trace-meta">run_id · {{ runId }}</p>
          <div v-if="wallClockMs || tokenTotal" class="mgr-trace-stats">
            <span v-if="wallClockMs">总耗时 {{ formatObsMs(wallClockMs) }}</span>
            <span v-if="tokenTotal">Token {{ formatTokenCount(tokenTotal) }}</span>
          </div>
          <div v-if="deepLinks?.langfuseUrl || deepLinks?.tempoUrl" class="mgr-trace-deeplinks">
            <a
              v-if="deepLinks.langfuseUrl"
              class="mgr-trace-deeplink"
              :href="deepLinks.langfuseUrl"
              target="_blank"
              rel="noopener noreferrer"
            >打开 Langfuse</a>
            <a
              v-if="deepLinks.tempoUrl"
              class="mgr-trace-deeplink"
              :href="deepLinks.tempoUrl"
              target="_blank"
              rel="noopener noreferrer"
            >打开 Tempo</a>
          </div>
        </section>

        <section v-if="morphology" class="mgr-trace-drawer-section">
          <div class="mgr-trace-drawer-label">本轮 Agent 形态</div>
          <p class="mgr-trace-meta">
            {{ morphology.kind }}
            <template v-if="morphology.outcome"> · {{ morphology.outcome }}</template>
            <template v-if="morphology.intent"> · intent {{ morphology.intent }}</template>
          </p>
          <p v-if="morphology.taskIntent || morphology.taskForm" class="mgr-trace-meta">
            <template v-if="morphology.taskIntent">taskIntent {{ morphology.taskIntent }}</template>
            <template v-if="morphology.taskForm"> · taskForm {{ morphology.taskForm }}</template>
          </p>
          <p v-if="morphology.allowedAgents.length" class="mgr-trace-meta">
            专家 {{ morphology.allowedAgents.join(' → ') }}
          </p>
          <p v-if="morphology.plan.length > 1" class="mgr-trace-meta">
            DAG
            {{
              morphology.plan
                .map((s) => {
                  const dep = s.dependsOn?.length ? `←${s.dependsOn.join(',')}` : ''
                  const br = s.blast_radius ? `:${s.blast_radius}` : ''
                  return `${s.agent}${br}${dep}`
                })
                .join(' · ')
            }}
          </p>
          <p v-if="morphology.blast_radius" class="mgr-trace-meta">
            爆炸半径 {{ morphology.blast_radius.toUpperCase() }}
          </p>
          <p v-if="morphology.sourceCommitment || morphology.turnScopeMode" class="mgr-trace-meta">
            <template v-if="morphology.sourceCommitment">source {{ morphology.sourceCommitment }}</template>
            <template v-if="morphology.turnScopeMode"> · scope {{ morphology.turnScopeMode }}</template>
          </p>
          <div
            v-if="
              morphology.memoryGovernance &&
              (morphology.memoryGovernance.pathConflictDropped ||
                morphology.memoryGovernance.pendingPrefsConflict ||
                morphology.memoryGovernance.memoryCaptureKind ||
                morphology.memoryGovernance.experienceReplayCount)
            "
            class="mgr-trace-memory-tags"
          >
            <span
              v-if="morphology.memoryGovernance.experienceReplayCount"
              class="mgr-trace-tag mgr-trace-tag-info"
            >
              经验回放 ×{{ morphology.memoryGovernance.experienceReplayCount }}
            </span>
            <span
              v-if="morphology.memoryGovernance.pathConflictDropped"
              class="mgr-trace-tag mgr-trace-tag-warn"
              :title="`同场景矛盾 path 已仲裁丢弃 ${morphology.memoryGovernance.pathConflictDropped} 条`"
            >
              path 冲突 −{{ morphology.memoryGovernance.pathConflictDropped }}
            </span>
            <span
              v-if="morphology.memoryGovernance.pendingPrefsConflict"
              class="mgr-trace-tag mgr-trace-tag-warn"
              :title="morphology.memoryGovernance.pendingPrefsConflict"
            >
              偏好冲突待确认
            </span>
            <span
              v-if="morphology.memoryGovernance.memoryCaptureKind"
              class="mgr-trace-tag mgr-trace-tag-info"
              :title="morphology.memoryGovernance.memoryCaptureStatus || ''"
            >
              记忆提案 · {{ morphology.memoryGovernance.memoryCaptureKind }}
            </span>
          </div>
        </section>

        <section v-if="phaseTimeline?.length" class="mgr-trace-drawer-section">
          <div class="mgr-trace-drawer-label">阶段时间线</div>
          <ul class="mgr-trace-phase-list">
            <li v-for="(item, i) in phaseTimeline" :key="`${item.phase}-${i}`" class="mgr-trace-phase-item">
              <span class="mgr-trace-phase-name">{{ obsDisplayLabel(item) }}</span>
              <span class="mgr-trace-phase-ms">{{ formatObsMs(item.ms) }}</span>
            </li>
          </ul>
        </section>

        <section class="mgr-trace-drawer-section mgr-trace-triage">
          <div class="mgr-trace-drawer-label">排障三问</div>
          <ol class="mgr-trace-triage-list">
            <li>
              <strong>路由错？</strong>
              看 meta.routeAuthorityChain（sourceCommitment / turnScopeMode / 单源透传）与路由卡片。
            </li>
            <li>
              <strong>记忆注入？</strong>
              看形态卡标签（经验回放 / path 冲突 / 偏好冲突）与 meta.memoryRecallExplain；pendingPrefs 需显式确认才写入 prefs；memoryCaptureProposal 为 Wave 8 记忆提案。
            </li>
            <li>
              <strong>执行错？</strong>
              看失败专家卡片的错误码（超时 / 熔断 / 5xx / 业务）；对照本时间线 phase。
            </li>
            <li>
              <strong>合成幻觉？</strong>
              看是否无证据拒答、来源面板是否空；勿把拒答当成成功回答。
            </li>
          </ol>
        </section>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.mgr-trace-drawer-root {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  justify-content: flex-end;
}
.mgr-trace-drawer-backdrop {
  position: absolute;
  inset: 0;
  border: 0;
  background: rgba(2, 6, 23, 0.55);
  cursor: pointer;
}
.mgr-trace-drawer-panel {
  position: relative;
  width: min(380px, 92vw);
  height: 100%;
  background: linear-gradient(165deg, #0f172a 0%, #111827 100%);
  border-left: 1px solid rgba(129, 140, 248, 0.22);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
  padding: 18px 16px 24px;
  overflow: auto;
  color: #e2e8f0;
}
.mgr-trace-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.mgr-trace-drawer-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.mgr-trace-drawer-sub {
  margin: 4px 0 0;
  font-size: 11px;
  color: #94a3b8;
}
.mgr-trace-drawer-close {
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(30, 41, 59, 0.8);
  color: #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mgr-trace-drawer-section {
  margin-bottom: 18px;
}
.mgr-trace-drawer-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #a5b4fc;
  margin-bottom: 8px;
}
.mgr-trace-id-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.mgr-trace-id-full {
  flex: 1;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-all;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid rgba(99, 102, 241, 0.25);
  color: #c7d2fe;
}
.mgr-trace-copy-btn {
  border: 1px solid rgba(129, 140, 248, 0.35);
  background: rgba(79, 70, 229, 0.25);
  color: #e0e7ff;
  border-radius: 8px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.mgr-trace-copy-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mgr-trace-meta {
  margin: 6px 0 0;
  font-size: 11px;
  color: #64748b;
}
.mgr-trace-memory-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.mgr-trace-tag {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-trace-tag-info {
  color: #c7d2fe;
  background: rgba(79, 70, 229, 0.22);
  border-color: rgba(129, 140, 248, 0.35);
}
.mgr-trace-tag-warn {
  color: #fde68a;
  background: rgba(180, 83, 9, 0.28);
  border-color: rgba(251, 191, 36, 0.4);
}
.mgr-trace-stats {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
  color: #94a3b8;
}
.mgr-trace-deeplinks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.mgr-trace-deeplink {
  font-size: 12px;
  color: #a5b4fc;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.mgr-trace-phase-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mgr-trace-phase-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(30, 41, 59, 0.55);
}
.mgr-trace-phase-name {
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgr-trace-phase-ms {
  color: #94a3b8;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.mgr-trace-triage-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.55;
  color: #cbd5e1;
}
.mgr-trace-triage-list li + li {
  margin-top: 8px;
}
.mgr-trace-triage-list strong {
  color: #a5b4fc;
}
</style>
