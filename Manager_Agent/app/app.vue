<template>
  <div class="brand-shell manager-shell" data-agent="manager">
    <NuxtPage />
  </div>
</template>

<script setup lang="ts">
useHead({
  title: '天机 · Manager Agent',
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/brand/logos/manager.svg' }],
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

.manager-shell {
  min-height: 100vh;
  background: transparent;
  color: inherit;
  --brand-motif-opacity: 0.5;
}

.manager-shell.brand-shell::before {
  opacity: 0;
}

.manager-shell > :not(.mgr-season-bg):not(.brand-motif):not(.spring-root) {
  position: relative;
  z-index: 1;
}
</style>
