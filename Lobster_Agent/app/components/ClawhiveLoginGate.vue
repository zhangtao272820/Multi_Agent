<template>
  <div class="claw-login">
    <form class="claw-login__card" @submit.prevent="submit">
      <h1>登录</h1>
      <p>使用 ClawHive 账号（控制台统一管理）。本地默认一般为 admin / admin123。</p>
      <input v-model="username" placeholder="用户名" autocomplete="username" required />
      <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" required />
      <p v-if="err" class="claw-login__err">{{ err }}</p>
      <button type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
    </form>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{ success: [] }>()
const { login } = useClawhiveLogin()
const username = ref('admin')
const password = ref('')
const busy = ref(false)
const err = ref('')

function formatLoginError(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return '登录失败'
  if (/401|unauthorized|invalid|密码|凭证|credential|Incorrect/i.test(s)) {
    return '用户名或密码错误（本地默认多为 admin / admin123，以 ClawHive 控制台为准）'
  }
  return s
}

async function submit() {
  busy.value = true
  err.value = ''
  try {
    await login(username.value, password.value)
    emit('success')
  } catch (e: any) {
    err.value = formatLoginError(String(e?.message || e))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.claw-login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0b1020;
  color: #e8eefc;
}
.claw-login__card {
  width: min(360px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 24px;
  border-radius: 14px;
  background: #121a2e;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.claw-login__card input,
.claw-login__card button {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: #0a0f1c;
  color: inherit;
}
.claw-login__card button {
  background: #3b6cf0;
  border: none;
  font-weight: 600;
  cursor: pointer;
}
.claw-login__err {
  color: #ff8f8f;
  margin: 0;
  font-size: 0.85rem;
}
</style>
