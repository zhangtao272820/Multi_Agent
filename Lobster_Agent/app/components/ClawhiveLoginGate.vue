<template>
  <div class="claw-login" data-agent="lobster">
    <form class="claw-login__card lob-glass" @submit.prevent="submit">
      <div class="claw-login__brand">
        <img class="claw-login__logo" src="/brand/logos/lobster.svg" alt="" width="56" height="56" />
        <div>
          <p class="claw-login__eyebrow">七杀 · GUI</p>
          <h1>七杀 · 龙虾 Agent</h1>
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
      <button type="submit" class="claw-login__submit" :disabled="busy">
        {{ busy ? '登录中…' : '登录' }}
      </button>
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
