<template>
  <div class="mgr-login-gate">
    <form class="mgr-login-card mgr-glass" @submit.prevent="onSubmit">
      <div class="mgr-login-brand">
        <img class="mgr-login-logo" src="/brand/logos/manager.svg" alt="" width="56" height="56" />
        <div>
          <p class="mgr-login-eyebrow">天机 · Manager</p>
          <h1 class="mgr-login-title">登录</h1>
          <p class="mgr-login-desc">使用天机账号登录（无需先打开控制端）</p>
        </div>
      </div>
      <label class="mgr-login-label">
        <span>用户名</span>
        <input v-model="username" placeholder="请输入用户名" autocomplete="username" required />
      </label>
      <label class="mgr-login-label">
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          placeholder="请输入密码"
          autocomplete="current-password"
          required
        />
      </label>
      <p v-if="error" class="mgr-login-error">{{ error }}</p>
      <button type="submit" class="mgr-login-btn" :disabled="busy">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{ success: [] }>()
const { login } = useClawhiveLogin()
const username = ref('admin')
const password = ref('')
const busy = ref(false)
const error = ref('')

function formatLoginError(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return '登录失败'
  if (/401|unauthorized|invalid|密码|凭证|credential|Incorrect/i.test(s)) {
    return '用户名或密码错误'
  }
  return s
}

async function onSubmit() {
  busy.value = true
  error.value = ''
  try {
    await login(username.value, password.value)
    emit('success')
  } catch (e: any) {
    error.value = formatLoginError(String(e?.message || e || '登录失败'))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.mgr-login-gate {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px 20px;
  color: #1a2f44;
  box-sizing: border-box;
}

.mgr-login-gate > .brand-motif {
  z-index: 1;
  opacity: 0.68;
}

.mgr-login-card {
  position: relative;
  z-index: 2;
  width: min(480px, 94vw);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 36px 34px;
  background: linear-gradient(165deg, rgba(255, 255, 255, 0.9), rgba(242, 248, 255, 0.82));
  color: #1a2f44;
  border: 1px solid rgba(90, 140, 190, 0.48);
  border-radius: 16px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.95) inset,
    0 16px 40px rgba(40, 70, 110, 0.14);
  backdrop-filter: blur(22px) saturate(1.15);
  -webkit-backdrop-filter: blur(22px) saturate(1.15);
}

.mgr-login-card::before {
  content: "";
  position: absolute;
  top: 10px;
  right: 14px;
  width: 12px;
  height: 12px;
  pointer-events: none;
  opacity: 0.55;
  background:
    linear-gradient(135deg, transparent 45%, rgba(180, 215, 245, 0.95) 48%, transparent 52%),
    linear-gradient(45deg, transparent 45%, rgba(255, 255, 255, 0.95) 48%, transparent 52%);
}

.mgr-login-brand {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 6px;
}

.mgr-login-logo {
  border-radius: 14px;
  border: 1px solid rgba(100, 160, 220, 0.45);
  box-shadow: 0 0 24px rgba(47, 127, 209, 0.2);
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.7);
}

.mgr-login-eyebrow {
  margin: 0 0 6px;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #5a738c;
  font-weight: 600;
}

.mgr-login-title {
  margin: 0;
  font-size: 1.55rem;
  font-weight: 750;
  font-family: var(--brand-font-display, inherit);
  letter-spacing: 0.02em;
  color: #102838;
  text-shadow: none;
}

.mgr-login-desc {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.45;
  color: #3a536c;
}

.mgr-login-label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #2a4060;
}

.mgr-login-label input {
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid rgba(120, 165, 210, 0.4);
  background: rgba(255, 255, 255, 0.65);
  color: #1a2f44;
  font: inherit;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.mgr-login-label input::placeholder {
  color: rgba(90, 115, 140, 0.55);
}

.mgr-login-label input:focus {
  border-color: rgba(47, 127, 209, 0.65);
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 3px rgba(47, 127, 209, 0.16);
}

.mgr-login-label input:-webkit-autofill,
.mgr-login-label input:-webkit-autofill:hover,
.mgr-login-label input:-webkit-autofill:focus {
  -webkit-text-fill-color: #1a2f44;
  caret-color: #1a2f44;
  transition: background-color 99999s ease-out;
  box-shadow: 0 0 0 1000px rgba(245, 250, 255, 0.9) inset;
}

.mgr-login-btn {
  margin-top: 6px;
  padding: 13px 16px;
  border-radius: 12px;
  border: none;
  background: #2f7fd1;
  color: #f4f8ff;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
}

.mgr-login-btn:hover:not(:disabled) {
  background: #3a8de0;
}

.mgr-login-btn:disabled {
  opacity: 0.65;
  cursor: wait;
}

.mgr-login-error {
  margin: 0;
  color: #c04040;
  font-size: 0.9rem;
}
</style>
