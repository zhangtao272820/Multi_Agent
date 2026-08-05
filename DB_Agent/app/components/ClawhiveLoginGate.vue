<template>
  <div class="claw-login">
    <div class="db-season-bg db-season-bg--yushui" aria-hidden="true" />
    <form class="claw-login__card db-glass" @submit.prevent="submit">
      <div class="claw-login__brand">
        <img class="claw-login__logo" src="/brand/logos/db.svg" alt="" width="56" height="56" />
        <div>
          <p class="claw-login__eyebrow">雨水 · 禄存</p>
          <h1>禄存 · 数据库助手</h1>
          <p class="claw-login__sub">使用 ClawHive 账号登录</p>
        </div>
      </div>
      <label class="claw-login__field">
        <span>用户名</span>
        <input v-model="username" placeholder="请输入用户名" autocomplete="username" required />
      </label>
      <label class="claw-login__field">
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          placeholder="请输入密码"
          autocomplete="current-password"
          required
        />
      </label>
      <p v-if="err" class="claw-login__err">{{ err }}</p>
      <button type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
    </form>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{ success: [] }>()
const { login } = useClawhiveLogin()
const username = ref('')
const password = ref('')
const busy = ref(false)
const err = ref('')

function formatLoginError(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return '登录失败'
  if (/401|unauthorized|invalid|密码|凭证|credential|Incorrect/i.test(s)) {
    return '用户名或密码错误'
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
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px 20px;
  color: #e8f4f2;
  box-sizing: border-box;
}

.claw-login__card {
  position: relative;
  z-index: 1;
  width: min(480px, 94vw);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 36px 34px;
}

.claw-login__brand {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 6px;
}

.claw-login__logo {
  border-radius: 14px;
  border: 1px solid rgba(46, 196, 182, 0.4);
  box-shadow: 0 0 28px rgba(46, 196, 182, 0.3);
  flex-shrink: 0;
}

.claw-login__eyebrow {
  margin: 0 0 6px;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #b0d8ce;
  font-weight: 600;
}

.claw-login__card h1 {
  margin: 0;
  font-size: 1.55rem;
  font-weight: 750;
  font-family: var(--brand-font-display, inherit);
  letter-spacing: 0.02em;
  color: #f4fffc;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.claw-login__sub {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.45;
  color: #c8ece6;
}

.claw-login__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #d4f0e8;
}

.claw-login__field input {
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid rgba(180, 236, 220, 0.35);
  background: rgba(2, 12, 14, 0.45);
  color: #f4fffc;
  font: inherit;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.claw-login__field input::placeholder {
  color: rgba(176, 216, 206, 0.55);
}

.claw-login__field input:focus {
  border-color: rgba(46, 196, 182, 0.65);
  background: rgba(4, 18, 20, 0.55);
  box-shadow: 0 0 0 3px rgba(46, 196, 182, 0.18);
}

/* 抑制浏览器自动填充把密码框刷成白底 */
.claw-login__field input:-webkit-autofill,
.claw-login__field input:-webkit-autofill:hover,
.claw-login__field input:-webkit-autofill:focus {
  -webkit-text-fill-color: #e8f4f2;
  caret-color: #e8f4f2;
  transition: background-color 99999s ease-out;
  box-shadow: 0 0 0 1000px rgba(12, 28, 30, 0.55) inset;
}

.claw-login__card button {
  margin-top: 6px;
  padding: 13px 16px;
  border-radius: 12px;
  border: none;
  background: #2ec4b6;
  color: #06201c;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
}

.claw-login__card button:hover:not(:disabled) {
  background: #3ad4c4;
}

.claw-login__card button:disabled {
  opacity: 0.65;
  cursor: wait;
}

.claw-login__err {
  color: #ffb0b0;
  margin: 0;
  font-size: 0.9rem;
}
</style>
