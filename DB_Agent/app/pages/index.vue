<template>
  <main class="page">
    <canvas ref="oceanCanvas" class="ocean-canvas" aria-hidden="true"></canvas>
    <div class="space-rim" aria-hidden="true"></div>
    <DbChatHeader />
    <div class="db-workspace">
      <DbChatHistoryAside />
      <DbChatMain />
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, provide } from "vue";
import { DbChatKey } from "~/components/db-chat/context";
import { useDbChatPage } from "~/composables/useDbChatPage";
import { useOceanCanvasRef } from "~/composables/useOceanCanvas";

useHead({
  title: "禄存 · DB Agent",
  bodyAttrs: {
    class: "space-bg",
  },
  style: [
    {
      innerHTML: `
        .space-bg { background: #05060b; overflow: hidden; }
      `,
    },
  ],
});

const chat = useDbChatPage();
provide(DbChatKey, chat);

const { oceanCanvas, mountOceanCanvas } = useOceanCanvasRef();
onMounted(() => {
  void mountOceanCanvas();
});
</script>

<style src="~/assets/css/db-chat.css"></style>
