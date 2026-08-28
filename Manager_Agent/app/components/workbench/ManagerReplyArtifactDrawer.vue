<script setup lang="ts">
import type { TurnGroup } from '~/composables/managerChatTypes'
import { artifactTabLabel } from '~/composables/managerPresentationUi'
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  turn: TurnGroup | null
  activeTab: 'chart' | 'table' | 'report'
  buildTurnAgentResults: (t: TurnGroup) => unknown
  userFacingChartOption: (t?: TurnGroup) => unknown | null
  userFacingChartTitle: (t?: TurnGroup) => string
  userFacingTableHtml: (t?: TurnGroup) => string
  extractEchartsOption: (text: string, agentResults?: unknown) => unknown
  extractTableData: (text: string) => unknown
  renderTableDataHtml: (text: string) => string
  resolveReportBody: (text: string, t: TurnGroup) => string
  renderReportMarkdown: (text: string) => string
  initChartEl: (el: HTMLElement, option: unknown) => void
  chartContainerClass: (option: unknown) => string | Record<string, boolean>
  chartContainerStyle: (option: unknown) => Record<string, string>
  downloadEchartsPng: (filename: string, option: unknown) => void | Promise<void>
  downloadMarkdown: (filename: string, body: string) => void
  /** 本地已应用的报告草稿（turnId → md） */
  reportDraft?: string
}>()

const emit = defineEmits<{
  close: []
  'update:activeTab': [tab: 'chart' | 'table' | 'report']
  'apply-report': [payload: { turnId: number; markdown: string }]
  'export-bundle': [turnId: number]
}>()

const exportBusy = ref(false)

const reportMode = ref<'preview' | 'edit'>('preview')
const reportDraftLocal = ref('')
const reportDirty = ref(false)
const applyAck = ref(false)
let applyAckTimer: ReturnType<typeof setTimeout> | null = null

const slots = computed(() =>
  (props.turn?.userFacing?.artifacts || []).filter((a) => a.surface === 'artifact_panel')
)

const tabs = computed(() => {
  const kinds = new Set(slots.value.map((s) => s.kind))
  const order: Array<'chart' | 'table' | 'report'> = ['chart', 'table', 'report']
  const fromSlots = order.filter((k) => kinds.has(k))
  if (fromSlots.length) return fromSlots
  // plan 已到、artifacts 未齐时仍允许打开报告编辑空壳
  if (props.turn?.userFacing?.appendix || props.turn?.presentationPlan?.replyTier === 'report') {
    return ['report'] as Array<'chart' | 'table' | 'report'>
  }
  return []
})

const resultText = computed(() => String(props.turn?.results?.[0]?.text || ''))

const chartOption = computed(() => {
  if (!props.turn) return null
  return (
    props.userFacingChartOption(props.turn) ||
    props.extractEchartsOption(resultText.value, props.buildTurnAgentResults(props.turn))
  )
})

const tableHtml = computed(() => {
  if (!props.turn) return ''
  const fromPayload = props.userFacingTableHtml(props.turn)
  if (fromPayload) return fromPayload
  if (props.extractTableData(resultText.value)) return props.renderTableDataHtml(resultText.value)
  return ''
})

function sourceReportMarkdown(): string {
  if (!props.turn) return ''
  if (props.reportDraft?.trim()) return props.reportDraft.trim()
  const appendix = String(props.turn.userFacing?.appendix || '').trim()
  if (appendix.length >= 40) return appendix
  return props.resolveReportBody(resultText.value, props.turn)
}

const reportHtml = computed(() => {
  const raw = reportMode.value === 'edit' ? reportDraftLocal.value : sourceReportMarkdown()
  return raw ? props.renderReportMarkdown(raw) : ''
})

const panelTitle = computed(() => {
  const t = props.turn
  if (!t) return '分析面板'
  return (
    t.userFacing?.headline ||
    t.userFacing?.summary?.split('\n')[0]?.slice(0, 48) ||
    '分析面板'
  )
})

function syncDraftFromSource() {
  reportDraftLocal.value = sourceReportMarkdown()
  reportDirty.value = false
  reportMode.value = 'preview'
}

watch(
  () => [props.open, props.turn?.id, props.reportDraft, props.turn?.userFacing?.appendix] as const,
  ([open]) => {
    if (!open) return
    syncDraftFromSource()
  },
  { immediate: true }
)

function onChartMount(el: unknown) {
  if (!el || !chartOption.value) return
  nextTick(() => {
    props.initChartEl(el as HTMLElement, chartOption.value)
  })
}

watch(
  () => [props.open, props.activeTab, chartOption.value] as const,
  ([open, tab]) => {
    if (!open || tab !== 'chart') return
    nextTick(() => {
      document.querySelectorAll('.mgr-artifact-drawer .echarts-container').forEach((node) => {
        const inst = (node as HTMLElement & { __chart_inst__?: { resize?: () => void } }).__chart_inst__
        try {
          inst?.resize?.()
        } catch {
          /* ignore */
        }
      })
    })
  }
)

function setTab(tab: 'chart' | 'table' | 'report') {
  if (tab !== 'report' && reportMode.value === 'edit' && reportDirty.value) {
    /* 切走前不丢草稿：保留 local */
  }
  emit('update:activeTab', tab)
}

function startEdit() {
  reportDraftLocal.value = sourceReportMarkdown()
  reportMode.value = 'edit'
  reportDirty.value = false
}

function cancelEdit() {
  syncDraftFromSource()
}

function onDraftInput() {
  reportDirty.value = reportDraftLocal.value !== sourceReportMarkdown()
}

function applyEdit() {
  if (!props.turn) return
  const md = String(reportDraftLocal.value || '').trim()
  if (!md) return
  emit('apply-report', { turnId: props.turn.id, markdown: md })
  reportDirty.value = false
  reportMode.value = 'preview'
  applyAck.value = true
  if (applyAckTimer) clearTimeout(applyAckTimer)
  applyAckTimer = setTimeout(() => {
    applyAck.value = false
  }, 1400)
}

function downloadChart() {
  if (!props.turn || !chartOption.value) return
  void props.downloadEchartsPng(`artifact_chart_turn_${props.turn.id}.png`, chartOption.value)
}

function downloadReport() {
  if (!props.turn) return
  const raw = reportMode.value === 'edit' ? reportDraftLocal.value : sourceReportMarkdown()
  if (!raw?.trim()) return
  props.downloadMarkdown(`report_turn_${props.turn.id}.md`, raw)
}

async function copyReport() {
  const raw = reportMode.value === 'edit' ? reportDraftLocal.value : sourceReportMarkdown()
  if (!raw?.trim()) return
  try {
    await navigator.clipboard.writeText(raw)
  } catch {
    /* ignore */
  }
}

async function exportAll() {
  if (!props.turn || exportBusy.value) return
  exportBusy.value = true
  try {
    emit('export-bundle', props.turn.id)
  } finally {
    setTimeout(() => {
      exportBusy.value = false
    }, 600)
  }
}

const canExportBundle = computed(() => {
  if (!props.turn) return false
  if (sourceReportMarkdown().trim()) return true
  if (tableHtml.value) return true
  if (chartOption.value) return true
  return false
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && turn"
      class="mgr-artifact-backdrop"
      role="presentation"
      @click="emit('close')"
    />
    <aside
      v-if="open && turn"
      class="mgr-artifact-drawer"
      :class="{ 'is-wide': reportMode === 'edit' && activeTab === 'report' }"
      role="dialog"
      aria-label="回复分析面板"
    >
      <header class="mgr-artifact-head">
        <div class="mgr-artifact-head-text">
          <span class="mgr-artifact-eyebrow">Artifact · Canvas</span>
          <h2 class="mgr-artifact-title">{{ panelTitle }}</h2>
        </div>
        <div class="mgr-artifact-head-actions">
          <button
            v-if="canExportBundle"
            type="button"
            class="reply-tool-btn"
            :disabled="exportBusy"
            @click="exportAll"
          >
            {{ exportBusy ? '导出中…' : '导出 ZIP' }}
          </button>
          <button type="button" class="mgr-artifact-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
        </div>
      </header>

      <nav v-if="tabs.length > 1" class="mgr-artifact-tabs" aria-label="面板标签">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          class="mgr-artifact-tab"
          :class="{ 'is-active': activeTab === tab }"
          @click="setTab(tab)"
        >
          {{ artifactTabLabel(tab) }}
        </button>
      </nav>

      <div class="mgr-artifact-body">
        <section v-if="activeTab === 'chart' && chartOption" class="mgr-artifact-pane">
          <div class="mgr-artifact-pane-toolbar">
            <span class="mgr-artifact-pane-title">{{
              userFacingChartTitle(turn) || '数据图表'
            }}</span>
            <button type="button" class="reply-tool-btn" @click="downloadChart">下载 .png</button>
          </div>
          <div class="chart-card mgr-artifact-chart-card">
            <div class="chart-wrap">
              <div
                :ref="(el) => onChartMount(el)"
                class="echarts-container"
                :class="chartContainerClass(chartOption)"
                :style="chartContainerStyle(chartOption)"
                :data-option="JSON.stringify(chartOption)"
              />
            </div>
          </div>
        </section>

        <section v-else-if="activeTab === 'table' && tableHtml" class="mgr-artifact-pane">
          <div class="mgr-artifact-pane-toolbar">
            <span class="mgr-artifact-pane-title">数据明细</span>
          </div>
          <div class="data-table-wrap md-body reply-rich mgr-artifact-table" v-html="tableHtml" />
        </section>

        <section
          v-else-if="activeTab === 'report' && (reportHtml || reportMode === 'edit')"
          class="mgr-artifact-pane"
          :class="{ 'is-split-edit': reportMode === 'edit' }"
        >
          <div class="mgr-artifact-pane-toolbar">
            <span class="mgr-artifact-pane-title">
              分析报告
              <span v-if="reportDirty" class="mgr-artifact-dirty">未应用</span>
              <span v-else-if="applyAck" class="mgr-artifact-ack">已应用</span>
              <span v-else-if="turn?.userFacing?.reportEdited" class="mgr-artifact-edited"
                >已编辑</span
              >
            </span>
            <div class="mgr-artifact-toolbar-actions">
              <template v-if="reportMode === 'preview'">
                <button type="button" class="reply-tool-btn" @click="startEdit">编辑</button>
                <button type="button" class="reply-tool-btn" @click="copyReport">复制</button>
                <button type="button" class="reply-tool-btn" @click="downloadReport">下载 .md</button>
              </template>
              <template v-else>
                <button type="button" class="reply-tool-btn" @click="cancelEdit">取消</button>
                <button
                  type="button"
                  class="reply-tool-btn reply-tool-btn-primary"
                  :disabled="!reportDraftLocal.trim()"
                  @click="applyEdit"
                >
                  应用
                </button>
                <button type="button" class="reply-tool-btn" @click="downloadReport">下载 .md</button>
              </template>
            </div>
          </div>

          <div v-if="reportMode === 'edit'" class="mgr-artifact-split">
            <div class="mgr-artifact-split-pane">
              <div class="mgr-artifact-split-label">Markdown</div>
              <textarea
                v-model="reportDraftLocal"
                class="mgr-artifact-editor"
                spellcheck="false"
                aria-label="编辑报告 Markdown"
                @input="onDraftInput"
              />
            </div>
            <div class="mgr-artifact-split-pane">
              <div class="mgr-artifact-split-label">预览</div>
              <div
                v-if="reportHtml"
                class="md-body reply-rich mgr-artifact-report mgr-artifact-live-preview"
                v-html="reportHtml"
              />
              <p v-else class="mgr-artifact-empty-inline">开始输入以预览…</p>
            </div>
          </div>
          <div
            v-else
            class="md-body reply-rich mgr-artifact-report"
            v-html="reportHtml"
          />
        </section>

        <p v-else class="mgr-artifact-empty">该标签下暂无可展示内容。</p>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
.mgr-artifact-backdrop {
  position: fixed;
  inset: 0;
  z-index: 12040;
  background: rgba(2, 6, 23, 0.42);
  backdrop-filter: blur(2px);
}
.mgr-artifact-drawer {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 12050;
  width: min(560px, 94vw);
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 0.96));
  border-left: 1px solid rgba(148, 163, 184, 0.22);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
  transition: width 0.18s ease;
}
.mgr-artifact-drawer.is-wide {
  width: min(920px, 96vw);
}
.mgr-artifact-edited {
  font-size: 11px;
  font-weight: 600;
  color: #a5b4fc;
}
.mgr-artifact-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.mgr-artifact-split-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.mgr-artifact-split-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 6px;
}
.mgr-artifact-live-preview {
  flex: 1;
  overflow: auto;
  min-height: 360px;
}
.mgr-artifact-empty-inline {
  color: #64748b;
  font-size: 13px;
  margin: 0;
}
@media (max-width: 900px) {
  .mgr-artifact-drawer.is-wide {
    width: min(96vw, 720px);
  }
  .mgr-artifact-split {
    grid-template-columns: 1fr;
  }
}
.mgr-artifact-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}
.mgr-artifact-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.mgr-artifact-eyebrow {
  display: block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #818cf8;
}
.mgr-artifact-title {
  margin: 4px 0 0;
  font-size: 15px;
  line-height: 1.4;
  font-weight: 650;
  color: #e2e8f0;
}
.mgr-artifact-close {
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}
.mgr-artifact-tabs {
  display: flex;
  gap: 6px;
  padding: 0 16px 12px;
}
.mgr-artifact-tab {
  border: 1px solid rgba(100, 116, 139, 0.35);
  background: rgba(15, 23, 42, 0.55);
  color: #cbd5e1;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.mgr-artifact-tab.is-active {
  border-color: rgba(129, 140, 248, 0.55);
  background: rgba(79, 70, 229, 0.28);
  color: #eef2ff;
}
.mgr-artifact-body {
  flex: 1;
  overflow: auto;
  padding: 0 16px 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.mgr-artifact-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.mgr-artifact-pane-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.mgr-artifact-pane-title {
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mgr-artifact-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mgr-artifact-dirty {
  font-size: 11px;
  font-weight: 600;
  color: #fbbf24;
}
.mgr-artifact-ack {
  font-size: 11px;
  font-weight: 600;
  color: #34d399;
}
.mgr-artifact-chart-card {
  min-height: 280px;
}
.mgr-artifact-table,
.mgr-artifact-report {
  border-radius: 12px;
  border: 1px solid rgba(100, 116, 139, 0.2);
  padding: 12px 14px;
  background: rgba(2, 6, 23, 0.35);
}
.mgr-artifact-editor {
  flex: 1;
  min-height: 360px;
  width: 100%;
  resize: vertical;
  border-radius: 12px;
  border: 1px solid rgba(129, 140, 248, 0.35);
  background: rgba(2, 6, 23, 0.65);
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.55;
  padding: 12px 14px;
  outline: none;
}
.mgr-artifact-editor:focus {
  border-color: rgba(165, 180, 252, 0.65);
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.2);
}
.mgr-artifact-empty {
  color: #94a3b8;
  font-size: 13px;
  padding: 24px 8px;
}
:deep(.reply-tool-btn-primary) {
  border-color: rgba(129, 140, 248, 0.55);
  background: rgba(79, 70, 229, 0.35);
  color: #eef2ff;
}
</style>
