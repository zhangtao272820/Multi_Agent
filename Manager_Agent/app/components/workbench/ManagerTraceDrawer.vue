<script setup lang="ts">
/** U1：Trace / 排障抽屉 — 复制 trace_id、阶段时间线、排障三问 */

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
              看 NLU / plan 与用户任务是否一致；开发视图中的路由卡片。
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
.mgr-trace-stats {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
  color: #94a3b8;
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
