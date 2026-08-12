<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  title: string
  message: string
  agent: string
  screenshot?: string
  pageUrl?: string
  vncUrl?: string
  failureType?: string
  lobsterRunId?: string
  sending: boolean
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const expanded = ref(false)
const titleId = `hitl-confirm-title-${Math.random().toString(36).slice(2, 9)}`

const agentKey = computed(() => String(props.agent || '').trim().toLowerCase())
const isGui = computed(() => agentKey.value === 'gui')
const isWriteSide = computed(() => agentKey.value === 'admin' || agentKey.value === 'gui')

const agentLabel = computed(() => {
  const map: Record<string, string> = {
    admin: '管理写操作',
    gui: 'GUI 自动化',
    db: '数据库',
    rag: '知识库',
    code: '代码',
    crawler: '爬虫',
    multimodal: '多模态'
  }
  return map[agentKey.value] || (agentKey.value ? agentKey.value.toUpperCase() : '操作')
})

const failureLabel = computed(() => {
  const ft = String(props.failureType || '').trim().toLowerCase()
  if (ft === 'captcha') return '验证码'
  if (ft === 'need_login') return '需登录'
  if (ft === 'need_human') return '需人工'
  return ft || ''
})

const riskChipLabel = computed(() => {
  if (failureLabel.value) return failureLabel.value
  if (isWriteSide.value) return '高风险'
  return '需确认'
})

const displayTitle = computed(() => {
  const t = String(props.title || '').trim()
  return t || '需要你确认后继续'
})

const messageLines = computed(() =>
  String(props.message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
)

const sideEffectHint = computed(() => {
  if (isGui.value) return '确认后将在浏览器中继续自动操作'
  if (isWriteSide.value) return '确认后会产生外部副作用（写入日程 / 发信等）'
  return '确认后继续执行'
})

function onConfirm() {
  if (props.sending) return
  emit('confirm')
}

function onCancel() {
  if (props.sending) return
  emit('cancel')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  }
}

let prevBodyOverflow = ''

onMounted(() => {
  if (typeof window === 'undefined') return
  window.addEventListener('keydown', onKeydown)
  prevBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
})

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = prevBodyOverflow
})
</script>

<template>
  <Teleport to="body">
    <div
      class="hitl-confirm-backdrop"
      role="presentation"
      @click.self="onCancel"
    >
      <div
        class="hitl-confirm-panel plan-mode-card is-tier-strict"
        :class="{ 'is-gui': isGui, 'has-screenshot': Boolean(screenshot && isGui) }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        aria-label="操作确认"
      >
        <header class="hitl-confirm-head">
          <div class="hitl-confirm-kicker">
            <span class="plan-mode-badge is-risk">风险确认</span>
            <span class="plan-mode-risk-chip is-high">{{ riskChipLabel }}</span>
          </div>
          <h2 :id="titleId" class="hitl-confirm-title">{{ displayTitle }}</h2>
          <div class="hitl-confirm-sub">
            <span class="hitl-confirm-agent-chip">{{ agentLabel }}</span>
            <span class="hitl-confirm-side-effect">{{ sideEffectHint }}</span>
          </div>
        </header>

        <div class="hitl-confirm-body">
          <div v-if="messageLines.length" class="hitl-confirm-summary">
            <p v-for="(line, idx) in messageLines" :key="idx" class="hitl-confirm-line">{{ line }}</p>
          </div>
          <div v-if="pageUrl && isGui" class="hitl-confirm-meta">
            <span class="hitl-confirm-meta-label">页面</span>
            <a :href="pageUrl" target="_blank" rel="noopener noreferrer" class="hitl-confirm-page-link">{{ pageUrl }}</a>
          </div>
          <div v-if="vncUrl && isGui" class="hitl-confirm-meta">
            <span class="hitl-confirm-meta-label">实时画面</span>
            <a :href="vncUrl" target="_blank" rel="noopener noreferrer" class="hitl-confirm-page-link">打开 noVNC</a>
          </div>
          <div v-if="lobsterRunId && isGui" class="hitl-confirm-meta">
            <span class="hitl-confirm-meta-label">Run</span>
            <code class="hitl-confirm-run-id">{{ lobsterRunId }}</code>
          </div>
          <div v-if="screenshot && isGui" class="hitl-confirm-screenshot-wrap">
            <img
              :src="screenshot"
              alt="GUI 当前截图"
              class="hitl-confirm-screenshot"
              :class="{ expanded }"
              @click="expanded = !expanded"
            />
            <span class="hitl-confirm-screenshot-hint">{{ expanded ? '点击缩小' : '点击放大查看验证码/页面' }}</span>
          </div>
        </div>

        <footer class="hitl-confirm-actions">
          <button
            type="button"
            class="spring-btn alt spring-btn-sm hitl-btn hitl-btn-cancel"
            :disabled="sending"
            @click="onCancel"
          >
            取消
          </button>
          <button
            type="button"
            class="spring-btn spring-btn-sm hitl-btn hitl-btn-danger"
            :disabled="sending"
            @click="onConfirm"
          >
            {{ sending ? '提交中…' : '确认继续' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
