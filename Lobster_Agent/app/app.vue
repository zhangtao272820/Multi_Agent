<template>
  <ClientOnly>
    <ClawhiveLoginGate v-if="needAuth && authReady && !isLoggedIn" @success="onLoginOk" />
  </ClientOnly>
  <div
    v-if="!needAuth || (authReady && isLoggedIn)"
    class="brand-shell lobster-shell"
    data-agent="lobster"
  >
    <NuxtPage />
  </div>
</template>

<script setup lang="ts">
const runtimeConfig = useRuntimeConfig()
const needAuth = computed(() => String(runtimeConfig.public?.agentBrowserAuth ?? '1') !== '0')
const { isLoggedIn, ready: authReady, loadFromStorage } = useClawhiveLogin()
function onLoginOk() {
  loadFromStorage()
}
onMounted(() => loadFromStorage())

useHead({
  title: '七杀 · Lobster Agent',
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/brand/logos/lobster.svg' }],
})
</script>

<style>
html,
body,
#__nuxt {
  margin: 0;
  min-height: 100%;
  max-width: 100%;
  overflow-x: hidden;
  background: transparent;
}
.brand-shell.lobster-shell {
  min-height: 100vh;
  max-width: 100vw;
  overflow-x: hidden;
  box-sizing: border-box;
}
</style>
