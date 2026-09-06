<script setup lang="ts">
import type { CollaborationPosture, PendingAttachment, WorkbenchMode } from '~/composables/managerChatTypes'
import { COLLABORATION_POSTURE_OPTIONS } from '~/composables/managerChatTypes'
import { computed, ref } from 'vue'

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
}>()

const emit = defineEmits<{
  setCollaborationPosture: [mode: CollaborationPosture]
  inputKeydown: [e: KeyboardEvent]
  sendOrCancel: []
  clearAttachment: []
  fileSelected: [e: Event]
  attachmentFile: [file: File]
}>()

const fileInputEl = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
let dragDepth = 0

const postureHint = computed(() => {
  if (props.planAwaitingConfirm || props.collaborationPosture === 'plan') return 'Plan · 确认后执行'
  if (props.collaborationPosture === 'ask') return '只读探查，不会执行写操作'
  if (props.collaborationPosture === 'debug') return '按步证据定点重验'
  return ''
})

function openFilePicker() {
  fileInputEl.value?.click()
}

function resetFileInput() {
  if (fileInputEl.value) fileInputEl.value.value = ''
}

function selectPosture(mode: CollaborationPosture) {
  emit('setCollaborationPosture', mode)
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
    :class="{ 'is-drag-over': dragOver }"
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
          isRunActive ? 'Esc 或点击取消停止' : 'Enter 发送 · Shift+Tab 切换姿态'
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
        placeholder="输入问题，或粘贴/拖拽/上传图片后提问（Enter 发送）"
        rows="3"
        @keydown="onTextareaKeydown"
        @paste="onPaste"
      />

      <div class="composer-toolbar">
        <div class="composer-toolbar-left">
          <div class="composer-posture-seg" role="group" aria-label="协作姿态">
            <button
              v-for="p in COLLABORATION_POSTURE_OPTIONS"
              :key="p.id"
              type="button"
              class="composer-posture-seg-btn"
              :class="{ 'is-active': collaborationPosture === p.id }"
              :title="p.title"
              :aria-pressed="collaborationPosture === p.id"
              @click="selectPosture(p.id)"
            >
              {{ p.label }}
            </button>
          </div>

          <button
            type="button"
            class="spring-btn alt spring-attach-btn"
            :disabled="!connected || uploadingAttachment"
            title="上传图片/音视频（也可粘贴或拖拽）"
            @click="openFilePicker"
          >
            附件
          </button>
        </div>

        <button
          class="spring-btn spring-btn-send-cancel"
          :class="{ 'is-cancel': isRunActive }"
          :disabled="sendCancelDisabled"
          @click="emit('sendOrCancel')"
        >
          {{ isRunActive ? '取消' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>
