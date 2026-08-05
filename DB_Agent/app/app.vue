<template>
  <ClientOnly>
    <ClawhiveLoginGate v-if="needAuth && authReady && !isLoggedIn" @success="onLoginOk" />
  </ClientOnly>
  <div
    v-if="!needAuth || (authReady && isLoggedIn)"
    class="db-shell"
    data-agent="db"
  >
    <div class="db-season-bg db-season-bg--guyu" aria-hidden="true" />
    <BrandMotif motif="rain" />
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
  title: '禄存 · DB Agent',
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/brand/logos/db.svg' }],
})
</script>

<style>
html,
body,
#__nuxt {
  margin: 0;
  min-height: 100%;
  background: transparent;
}
</style>
