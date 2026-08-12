<template>
  <ClientOnly>
    <ClawhiveLoginGate v-if="needAuth && authReady && !isLoggedIn" @success="onLoginOk" />
  </ClientOnly>
  <div
    v-if="!needAuth || (authReady && isLoggedIn)"
    class="brand-shell lobster-shell"
    data-agent="lobster"
  >
    <div class="lob-season-bg lob-season-bg--dongzhi" aria-hidden="true" />
    <BrandMotif motif="snow" :count="72" />
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
  background: transparent;
}
</style>
