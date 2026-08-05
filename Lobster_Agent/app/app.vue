<template>
  <ClientOnly>
    <ClawhiveLoginGate v-if="needAuth && authReady && !isLoggedIn" @success="onLoginOk" />
  </ClientOnly>
  <div
    v-if="!needAuth || (authReady && isLoggedIn)"
    class="brand-shell lobster-shell"
    data-agent="lobster"
  >
    <BrandMotif motif="snow" />
    <NuxtPage />
  </div>
</template>

<script setup lang="ts">
import BrandMotif from '@brand/vue/BrandMotif.vue'

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
}

.lobster-shell {
  min-height: 100vh;
}

.lobster-shell > :not(.brand-motif) {
  position: relative;
  z-index: 1;
}
</style>
