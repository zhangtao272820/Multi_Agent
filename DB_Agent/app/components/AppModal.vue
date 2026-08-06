<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="db-modal-backdrop"
      role="presentation"
      @click.self="onBackdropClick"
    >
      <div
        class="db-modal-dialog"
        role="dialog"
        :aria-labelledby="titleId"
        aria-modal="true"
      >
        <header class="db-modal-header">
          <h3 :id="titleId" class="db-modal-title">{{ title }}</h3>
        </header>
        <div class="db-modal-body">
          <p v-if="message" class="db-modal-message">{{ message }}</p>
          <input
            v-if="mode === 'prompt'"
            v-model="localInput"
            type="text"
            class="db-modal-input"
            :placeholder="inputPlaceholder"
            :maxlength="inputMaxLength"
            @keydown.enter.prevent="onConfirm"
          />
        </div>
        <footer class="db-modal-footer">
          <button
            v-if="mode === 'confirm' || mode === 'prompt'"
            type="button"
            class="db-modal-btn db-modal-btn-muted"
            @click="onCancel"
          >
            {{ cancelText }}
          </button>
          <button type="button" class="db-modal-btn db-modal-btn-primary" @click="onConfirm">
            {{ confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  mode: { type: String, default: "alert" },
  title: { type: String, default: "提示" },
  message: { type: String, default: "" },
  confirmText: { type: String, default: "确定" },
  cancelText: { type: String, default: "取消" },
  inputValue: { type: String, default: "" },
  inputPlaceholder: { type: String, default: "" },
  inputMaxLength: { type: Number, default: 80 },
});

const emit = defineEmits(["update:modelValue", "confirm", "cancel"]);

const localInput = ref("");
const titleId = computed(() => `db-modal-title-${Math.random().toString(36).slice(2, 8)}`);

watch(
  () => props.modelValue,
  (open) => {
    if (open && props.mode === "prompt") localInput.value = props.inputValue || "";
  }
);

function close() {
  emit("update:modelValue", false);
}

function onConfirm() {
  emit("confirm", props.mode === "prompt" ? localInput.value : undefined);
  close();
}

function onCancel() {
  emit("cancel");
  close();
}

function onBackdropClick() {
  if (props.mode === "alert") onConfirm();
  else onCancel();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.modelValue) {
    if (props.mode === "alert") onConfirm();
    else onCancel();
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (typeof window === "undefined") return;
    if (open) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  }
);

onBeforeUnmount(() => {
  if (typeof window !== "undefined") window.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.db-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(2, 6, 23, 0.62);
  backdrop-filter: blur(4px);
}

.db-modal-dialog {
  position: relative;
  width: 100%;
  max-width: 22rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(179, 199, 255, 0.16);
  background: rgba(8, 10, 24, 0.96);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
}

.db-modal-header {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid rgba(179, 199, 255, 0.12);
}

.db-modal-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: #e7eaf3;
}

.db-modal-body {
  padding: 0.85rem 1rem;
}

.db-modal-message {
  margin: 0;
  font-size: 0.875rem;
  color: #aab2d5;
  white-space: pre-wrap;
}

.db-modal-input {
  margin-top: 0.5rem;
  width: 100%;
  border-radius: 0.5rem;
  border: 1px solid rgba(179, 199, 255, 0.16);
  background: rgba(6, 8, 18, 0.55);
  padding: 0.5rem 0.65rem;
  font-size: 0.875rem;
  color: #e7eaf3;
  outline: none;
}

.db-modal-input:focus {
  box-shadow: 0 0 0 2px rgba(120, 160, 255, 0.35);
}

.db-modal-footer {
  padding: 0.75rem 1rem;
  border-top: 1px solid rgba(179, 199, 255, 0.12);
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.db-modal-btn {
  border-radius: 0.5rem;
  padding: 0.35rem 0.75rem;
  font-size: 0.75rem;
  cursor: pointer;
}

.db-modal-btn-muted {
  border: 1px solid rgba(179, 199, 255, 0.16);
  background: rgba(120, 160, 255, 0.08);
  color: #c9d4ff;
}

.db-modal-btn-primary {
  border: 1px solid rgba(120, 160, 255, 0.35);
  background: rgba(120, 160, 255, 0.22);
  color: #e7eaf3;
  font-weight: 600;
}
</style>
