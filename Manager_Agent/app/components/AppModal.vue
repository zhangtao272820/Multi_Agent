<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="app-modal-backdrop"
      role="presentation"
      @click.self="onBackdropClick"
    >
      <div class="app-modal-panel" role="dialog" :aria-labelledby="titleId" aria-modal="true">
        <header class="app-modal-header">
          <h3 :id="titleId" class="app-modal-title">{{ title }}</h3>
        </header>
        <div class="app-modal-body">
          <p v-if="message" class="app-modal-message">{{ message }}</p>
          <input
            v-if="mode === 'prompt'"
            v-model="localInput"
            type="text"
            class="app-modal-input"
            :placeholder="inputPlaceholder"
            :maxlength="inputMaxLength"
            @keydown.enter.prevent="onConfirm"
          />
        </div>
        <footer class="app-modal-footer">
          <button
            v-if="mode === 'confirm' || mode === 'prompt'"
            type="button"
            class="spring-btn alt spring-btn-sm app-modal-btn"
            @click="onCancel"
          >
            {{ cancelText }}
          </button>
          <button type="button" class="spring-btn spring-btn-sm app-modal-btn" @click="onConfirm">
            {{ confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    mode?: 'alert' | 'confirm' | 'prompt'
    title?: string
    message?: string
    confirmText?: string
    cancelText?: string
    inputValue?: string
    inputPlaceholder?: string
    inputMaxLength?: number
  }>(),
  {
    mode: 'alert',
    title: '提示',
    message: '',
    confirmText: '确定',
    cancelText: '取消',
    inputValue: '',
    inputPlaceholder: '',
    inputMaxLength: 80
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [inputValue?: string]
  cancel: []
}>()

const localInput = ref('')

watch(
  () => props.modelValue,
  (open) => {
    if (open && props.mode === 'prompt') localInput.value = String(props.inputValue || '')
  },
  { immediate: true }
)

const titleId = computed(() => `app-modal-title-${Math.random().toString(36).slice(2, 9)}`)

function onConfirm() {
  emit('confirm', props.mode === 'prompt' ? localInput.value : undefined)
  emit('update:modelValue', false)
}

function onCancel() {
  emit('cancel')
  emit('update:modelValue', false)
}

function onBackdropClick() {
  if (props.mode === 'alert') onConfirm()
  else onCancel()
}

function onKeydown(e: KeyboardEvent) {
  if (!props.modelValue) return
  if (e.key === 'Escape') {
    e.preventDefault()
    if (props.mode === 'alert') onConfirm()
    else onCancel()
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (typeof window === 'undefined') return
    if (open) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.app-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(30, 50, 75, 0.48);
  backdrop-filter: blur(8px);
}

.app-modal-panel {
  width: min(440px, 100%);
  border-radius: 14px;
  border: 1px solid rgba(122, 168, 212, 0.55);
  background: linear-gradient(165deg, rgba(255, 255, 255, 0.98) 0%, rgba(238, 245, 252, 0.96) 100%);
  box-shadow: 0 24px 56px rgba(18, 45, 78, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  overflow: hidden;
  color: #0e1f30;
}

.app-modal-header {
  padding: 16px 18px 8px;
}

.app-modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0e1f30;
}

.app-modal-body {
  padding: 8px 18px 16px;
}

.app-modal-message {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.55;
  color: #3a536c;
  white-space: pre-wrap;
}

.app-modal-input {
  width: 100%;
  box-sizing: border-box;
  border-radius: 10px;
  border: 1px solid rgba(122, 168, 212, 0.55);
  background: rgba(255, 255, 255, 0.96);
  color: #0e1f30;
  font-size: 14px;
  padding: 10px 12px;
  outline: none;
}

.app-modal-input:focus {
  border-color: rgba(47, 127, 209, 0.65);
  box-shadow: 0 0 0 2px rgba(47, 127, 209, 0.16);
}

.app-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid rgba(122, 168, 212, 0.35);
}

.app-modal-btn {
  min-width: 72px;
}
</style>
