<template>
  <div class="mgr-login-gate">
    <form class="mgr-login-card" @submit.prevent="onSubmit">
      <h1 class="mgr-login-title">天机 · 登录</h1>
      <p class="mgr-login-desc">使用 ClawHive 账号（用户由控制台统一管理）。本地默认一般为 admin / admin123。</p>
      <label class="mgr-login-label">
        用户名
        <input v-model="username" autocomplete="username" required />
      </label>
      <label class="mgr-login-label">
        密码
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="error" class="mgr-login-error">{{ error }}</p>
      <button type="submit" class="mgr-login-btn" :disabled="busy">
        {{ busy ? '登录中…' : '登录' }}
      </button>
      <p class="mgr-login-hint">默认管理员见 ClawHive 控制台；画像 userId = 用户名</p>
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
    return '用户名或密码错误（本地默认多为 admin / admin123，以 ClawHive 控制台为准）'
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
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(1200px 600px at 50% -10%, #1a2744, #0b1020 55%);
  color: #e8eefc;
  padding: 24px;
}
.mgr-login-card {
  width: min(380px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px 24px;
  border-radius: 16px;
  background: rgba(16, 24, 40, 0.92);
  border: 1px solid rgba(120, 150, 220, 0.25);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
}
.mgr-login-title {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 650;
}
.mgr-login-desc,
.mgr-login-hint {
  margin: 0;
  opacity: 0.72;
  font-size: 0.85rem;
  line-height: 1.4;
}
.mgr-login-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}
.mgr-login-label input {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(140, 160, 210, 0.35);
  background: rgba(8, 12, 22, 0.8);
  color: inherit;
}
.mgr-login-btn {
  margin-top: 4px;
  padding: 10px 14px;
  border-radius: 10px;
  border: none;
  background: linear-gradient(135deg, #4f7cff, #3a5fd4);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.mgr-login-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.mgr-login-error {
  margin: 0;
  color: #ff8f8f;
  font-size: 0.85rem;
}
</style>
