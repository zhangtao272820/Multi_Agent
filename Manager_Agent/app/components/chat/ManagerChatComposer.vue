<script setup lang="ts">
import type { CollaborationPosture, PendingAttachment, WorkbenchMode } from '~/composables/managerChatTypes'
import { COLLABORATION_POSTURE_OPTIONS, collaborationPostureLabel } from '~/composables/managerChatTypes'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const input = defineModel<string>({ required: true })

const props = defineProps<{
  workbenchMode?: WorkbenchMode
  collaborationPosture: CollaborationPosture
  connected: boolean
  isRunActive: boolean
  sendCancelDisabled: boolean
  uploadingAttachment: boolean
  pendingAttachment: PendingAttachment | null
  /** Plan 待确认时显示姿态条 */
  planAwaitingConfirm?: boolean
  /** Harness 底栏：本轮耗时 / Token（有则显示） */
  runWallClockMs?: number | null
  runTotalTokens?: number | null
  formatObsMs?: (ms: number) => string
  formatTokenCount?: (n: number) => string
}>()

const metricsLine = computed(() => {
  const parts: string[] = []
  const fmtMs = props.formatObsMs
  const fmtTok = props.formatTokenCount
  if (props.runWallClockMs != null && props.runWallClockMs > 0 && fmtMs) {
    parts.push(`耗时 ${fmtMs(props.runWallClockMs)}`)
  }
  if (props.runTotalTokens != null && props.runTotalTokens > 0 && fmtTok) {
    parts.push(`Token ${fmtTok(props.runTotalTokens)}`)
  }
  return parts.join(' · ')
})

const emit = defineEmits<{
  setCollaborationPosture: [mode: CollaborationPosture]
  inputKeydown: [e: KeyboardEvent]
  sendOrCancel: []
  clearAttachment: []
  fileSelected: [e: Event]
  attachmentFile: [file: File]
}>()

const fileInputEl = ref<HTMLInputElement | null>(null)
const postureWrapEl = ref<HTMLElement | null>(null)
const postureMenuOpen = ref(false)
const dragOver = ref(false)
let dragDepth = 0

const postureHint = computed(() => {
  if (props.planAwaitingConfirm || props.collaborationPosture === 'plan') return 'Plan · 确认后执行'
  if (props.collaborationPosture === 'ask') return '只读探查，不会执行写操作'
  if (props.collaborationPosture === 'debug') return '按步证据定点重验'
  return ''
})

const postureLabel = computed(() => collaborationPostureLabel(props.collaborationPosture))

const POSTURE_GLYPH: Record<CollaborationPosture, string> = {
  ask: '问',
  plan: '策',
  agent: '行',
  debug: '验'
}

function postureGlyph(id: CollaborationPosture | string): string {
  return POSTURE_GLYPH[id as CollaborationPosture] || '行'
}

function openFilePicker() {
  fileInputEl.value?.click()
}

function resetFileInput() {
  if (fileInputEl.value) fileInputEl.value.value = ''
}

function closePostureMenu() {
  postureMenuOpen.value = false
}

function togglePostureMenu() {
  postureMenuOpen.value = !postureMenuOpen.value
}

function selectPosture(mode: CollaborationPosture) {
  emit('setCollaborationPosture', mode)
  closePostureMenu()
}

/** Cursor 式：Shift+Tab 轮转 Ask → Plan → Agent → Debug */
function cyclePosture(backward = false) {
  const ids = COLLABORATION_POSTURE_OPTIONS.map((p) => p.id)
  const idx = Math.max(0, ids.indexOf(props.collaborationPosture))
  const next = backward
    ? ids[(idx - 1 + ids.length) % ids.length]
    : ids[(idx + 1) % ids.length]
  selectPosture(next)
}

function onTextareaKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault()
    cyclePosture(false)
    return
  }
  emit('inputKeydown', e)
}

function onDocPointerDown(e: PointerEvent) {
  if (!postureMenuOpen.value) return
  const root = postureWrapEl.value
  if (root && e.target instanceof Node && root.contains(e.target)) return
  closePostureMenu()
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && postureMenuOpen.value) {
    e.preventDefault()
    closePostureMenu()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeydown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown, true)
})

function pickImageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null
  const files = dt.files
  if (files?.length) {
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i)
      if (f && f.type.startsWith('image/')) return f
    }
    const first = files.item(0)
    if (first) return first
  }
  const items = dt.items
  if (items?.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) return f
      }
    }
  }
  return null
}

function onPaste(e: ClipboardEvent) {
  if (!props.connected || props.uploadingAttachment) return
  const file = pickImageFromDataTransfer(e.clipboardData)
  if (!file) return
  e.preventDefault()
  emit('attachmentFile', file)
}

function onDragEnter(e: DragEvent) {
  if (!filesHavePayload(e.dataTransfer)) return
  e.preventDefault()
  dragDepth += 1
  dragOver.value = true
}

function onDragOver(e: DragEvent) {
  if (!filesHavePayload(e.dataTransfer)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dragOver.value = true
}

function onDragLeave(e: DragEvent) {
  if (!filesHavePayload(e.dataTransfer) && dragDepth <= 0) return
  e.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragOver.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragDepth = 0
  dragOver.value = false
  if (!props.connected || props.uploadingAttachment) return
  const file = pickImageFromDataTransfer(e.dataTransfer)
  if (!file) return
  emit('attachmentFile', file)
}

function filesHavePayload(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  if (dt.types?.includes('Files')) return true
  return Boolean(dt.files?.length)
}

defineExpose({ resetFileInput })
</script>

<template>
  <div
    class="spring-input cosmic-input-dock cosmic-comms-console"
    :class="{ 'is-drag-over': dragOver, 'has-posture-menu': postureMenuOpen }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      v-if="postureHint"
      class="composer-posture-chip"
      :class="{
        'is-plan': collaborationPosture === 'plan' || planAwaitingConfirm,
        'is-ask': collaborationPosture === 'ask',
        'is-debug': collaborationPosture === 'debug'
      }"
      role="status"
    >
      {{ postureHint }}
    </div>

    <div class="spring-input-col">
      <div class="cosmic-input-head">
        <span class="cosmic-input-hint">{{
          isRunActive ? 'Esc 或点击取消停止' : 'Enter 发送 · Shift+Tab / 下拉切换姿态'
        }}</span>
      </div>

      <div v-if="pendingAttachment" class="attach-pending">
        <img
          v-if="pendingAttachment.previewUrl && pendingAttachment.mediaType === 'image'"
          :src="pendingAttachment.previewUrl"
          alt=""
          class="attach-pending-thumb"
        />
        <span class="attach-pending-name">{{ pendingAttachment.filename }}</span>
        <span v-if="uploadingAttachment" class="attach-pending-status">上传中…</span>
        <button type="button" class="attach-pending-clear" :disabled="uploadingAttachment" @click="emit('clearAttachment')">
          移除
        </button>
      </div>

      <div v-if="dragOver" class="attach-drop-hint" aria-live="polite">松开以添加图片</div>

      <input
        ref="fileInputEl"
        type="file"
        class="spring-file-input"
        accept="image/*,video/*,audio/*,.pdf"
        @change="emit('fileSelected', $event)"
      />

      <textarea
        v-model="input"
        :disabled="!connected"
        class="spring-input-field spring-input-area"
        :placeholder="
          workbenchMode === 'professional'
            ? '向总管发送消息…'
            : '输入问题，或粘贴/拖拽/上传图片后提问（Enter 发送）'
        "
        rows="3"
        @keydown="onTextareaKeydown"
        @paste="onPaste"
      />

      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <button
            type="button"
            class="composer-icon-btn"
            :disabled="!connected || uploadingAttachment"
            title="上传附件（也可粘贴或拖拽）"
            @click="openFilePicker"
          >
            +
          </button>
          <div ref="postureWrapEl" class="composer-posture-wrap">
            <button
              type="button"
              class="composer-posture-trigger"
              :class="[`is-${collaborationPosture}`, { 'is-open': postureMenuOpen }]"
              :aria-expanded="postureMenuOpen"
              aria-haspopup="listbox"
              aria-label="协作姿态"
              :title="COLLABORATION_POSTURE_OPTIONS.find((p) => p.id === collaborationPosture)?.title"
              @click="togglePostureMenu"
            >
              <span class="composer-posture-glyph" aria-hidden="true">{{ postureGlyph(collaborationPosture) }}</span>
              <span class="composer-posture-trigger-label">{{ postureLabel }}</span>
              <span class="composer-posture-chevron" aria-hidden="true">▾</span>
            </button>
            <div
              v-if="postureMenuOpen"
              class="composer-posture-menu"
              role="listbox"
              aria-label="选择协作姿态"
            >
              <button
                v-for="p in COLLABORATION_POSTURE_OPTIONS"
                :key="p.id"
                type="button"
                class="composer-posture-option"
                role="option"
                :data-posture="p.id"
                :class="{ 'is-active': collaborationPosture === p.id }"
                :aria-selected="collaborationPosture === p.id"
                @click="selectPosture(p.id)"
              >
                <span class="composer-posture-option-glyph" aria-hidden="true">{{ postureGlyph(p.id) }}</span>
                <span class="composer-posture-option-label">{{ p.label }}</span>
                <span class="composer-posture-option-desc">{{ p.title }}</span>
                <span v-if="collaborationPosture === p.id" class="composer-posture-option-check" aria-hidden="true">✓</span>
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="brand-send-fab spring-btn-send-cancel"
          :class="{ 'is-cancel': isRunActive }"
          :disabled="sendCancelDisabled"
          :title="isRunActive ? '取消' : '发送'"
          :aria-label="isRunActive ? '取消' : '发送'"
          @click="emit('sendOrCancel')"
        >
          <svg
            v-if="!isRunActive"
            class="brand-send-fab__icon"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 19V5M12 5l-6 6M12 5l6 6"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <svg v-else class="brand-send-fab__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </div>

      <div v-if="metricsLine || workbenchMode === 'professional'" class="composer-metrics-row" aria-label="本轮指标">
        <span v-if="metricsLine" class="composer-metrics-text">{{ metricsLine }}</span>
        <span v-else class="composer-metrics-text is-muted">就绪</span>
        <span class="composer-metrics-hint">Enter 发送 · Shift+Tab / 下拉切换姿态</span>
      </div>
    </div>
  </div>
</template>
