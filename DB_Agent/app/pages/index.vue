<template>
  <main class="page db-page">
    <DbChatHeader />
    <div class="db-workspace">
      <DbChatHistoryAside />
      <DbChatMain />
    </div>
  </main>
</template>

<script setup lang="ts">
import { provide } from "vue";
import { DbChatKey } from "~/components/db-chat/context";
import { useDbChatPage } from "~/composables/useDbChatPage";

useHead({
  title: "禄存 · DB Agent",
  bodyAttrs: {
    class: "db-body",
  },
});

const chat = useDbChatPage();
provide(DbChatKey, chat);
</script>

<style src="~/assets/css/db-chat.css"></style>
<style>
.db-body {
  background: transparent;
  overflow: hidden;
}
.db-page {
  position: relative;
}

@media (max-width: 720px) {
  .db-page.page {
    padding: 10px 10px 12px;
  }
  .header-avatar {
    display: none;
  }
  .title {
    font-size: 17px;
  }
}
</style>
