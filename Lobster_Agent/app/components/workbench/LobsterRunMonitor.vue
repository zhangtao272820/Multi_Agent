<template>
  <section class="grid simple">
    <div class="card span2 shot-card">
      <div class="card-h">
        <span>实时画面</span>
        <a
          v-if="vncUrl"
          class="btn ghost sm"
          :href="vncUrl"
          target="_blank"
          rel="noopener noreferrer"
        >noVNC 全屏</a>
      </div>
      <div class="shot compact">
        <img v-if="screenshotDataUrl" :src="screenshotDataUrl" alt="screenshot" />
        <div v-else class="ph">{{ busy ? '执行中，等待截图…' : '开始任务后显示浏览器截图' }}</div>
      </div>
      <div v-if="progressLines.length" class="progress">
        <div class="progress-h">进度</div>
        <ul>
          <li v-for="(line, i) in progressLines" :key="i">{{ line }}</li>
        </ul>
      </div>
    </div>

    <div class="card span2">
      <div class="card-h">
        <div>结果</div>
        <div class="right">
          <button class="btn ghost sm" :disabled="!hasResult" @click="$emit('download-json')">导出 JSON</button>
        </div>
      </div>
      <div v-if="!hasResult && !busy" class="result-empty">
        <div class="empty-ico" aria-hidden="true" />
        <div class="empty-title">等待任务完成</div>
        <div class="empty-sub">执行结束后这里展示可读摘要；完整 JSON 可导出</div>
      </div>
      <div v-else-if="busy && !hasResult" class="result-empty">
        <div class="empty-title">{{ statusText || '运行中…' }}</div>
        <div class="empty-sub">{{ narrative || '正在规划与执行页面操作' }}</div>
      </div>
      <div v-else class="result-card">
        <div v-if="summaryTitle" class="result-title">{{ summaryTitle }}</div>
        <div v-if="summaryUrl" class="result-url">
          <a :href="summaryUrl" target="_blank" rel="noopener noreferrer">{{ summaryUrl }}</a>
        </div>
        <pre class="result-body">{{ summaryBody }}</pre>
        <details v-if="prettyJson" class="raw-json">
          <summary>原始 JSON</summary>
          <pre class="pre">{{ prettyJson }}</pre>
        </details>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  busy: boolean
  statusText: string
  screenshotDataUrl: string
  vncUrl: string
  result: unknown
  prettyJson: string
  thinkingText?: string
  phase?: string
  lastAction?: string
}>()

defineEmits<{ 'download-json': [] }>()

const hasResult = computed(() => props.result != null)

const narrative = computed(() => {
  const parts = [
    props.phase ? `阶段 ${props.phase}` : '',
    props.lastAction || '',
    props.thinkingText ? String(props.thinkingText).slice(0, 80) : '',
  ].filter(Boolean)
  return parts.join(' · ')
})

const progressLines = computed(() => {
  const lines: string[] = []
  if (props.phase) lines.push(`状态：${props.phase}`)
  if (props.lastAction) lines.push(`最近动作：${props.lastAction}`)
  if (props.thinkingText) lines.push(String(props.thinkingText).slice(0, 120))
  return lines.slice(0, 4)
})

function pickAnswer(raw: unknown): { title: string; url: string; body: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!r) return { title: '', url: '', body: props.prettyJson || '' }
  const answer = String(r.answer || r.text || '').trim()
  const finalUrl = String(r.finalUrl || r.url || '').trim()
  const pageTitle = String(r.pageTitle || '').trim()
  const filled = Array.isArray(r.filled) ? r.filled : []
  const data0 =
    Array.isArray(r.data) && r.data[0] && typeof r.data[0] === 'object'
      ? (r.data[0] as Record<string, unknown>)
      : null
  const items = Array.isArray(data0?.items)
    ? data0!.items
    : Array.isArray(r.items)
      ? r.items
      : []

  let body = answer
  if (!body && filled.length) {
    body = filled
      .map((f: any) => `${f?.key}=${f?.value}`)
      .filter(Boolean)
      .join('\n')
  }
  if (!body && items.length) {
    body = items
      .slice(0, 8)
      .map((it: any) => {
        const t = String(it?.title || it?.text || '').trim()
        const u = String(it?.url || '').trim()
        return u ? `${t || '条目'} — ${u}` : t
      })
      .filter(Boolean)
      .join('\n')
  }
  if (!body) body = props.prettyJson || JSON.stringify(r, null, 2).slice(0, 2000)

  return {
    title: pageTitle || (items[0] as any)?.title || '',
    url: finalUrl || String((items[0] as any)?.url || ''),
    body,
  }
}

const summary = computed(() => pickAnswer(props.result))
const summaryTitle = computed(() => summary.value.title)
const summaryUrl = computed(() => summary.value.url)
const summaryBody = computed(() => summary.value.body)
</script>

<style scoped>
.shot-card .shot.compact {
  min-height: 220px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--brand-bg, #f4f1f2) 70%, #fff);
  border-radius: 12px;
  overflow: hidden;
}
.shot-card img {
  max-width: 100%;
  display: block;
}
.ph {
  color: var(--brand-muted, #7a6a6e);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
.progress {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--brand-accent, #9f3445) 6%, #fff);
  font-size: 12px;
}
.progress-h {
  font-weight: 650;
  margin-bottom: 4px;
  color: var(--brand-accent, #9f3445);
}
.progress ul {
  margin: 0;
  padding-left: 18px;
}
.result-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.result-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--brand-text, #2a1f22);
}
.result-url a {
  font-size: 12px;
  color: var(--brand-accent, #9f3445);
  word-break: break-all;
}
.result-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
  font-family: var(--brand-font-sans, inherit);
}
.raw-json {
  margin-top: 8px;
  font-size: 12px;
}
.raw-json summary {
  cursor: pointer;
  color: var(--brand-muted, #7a6a6e);
}
</style>
