<script setup lang="ts">
import { inject } from "vue";
import { DbChatKey } from "./context";
import DbUserMenu from "./DbUserMenu.vue";

const chat = inject(DbChatKey)!;
const {
  showIntel,
  runtimeConfig,
  intelLoading,
  intel,
  intelRefreshing,
  intelCurating,
  intelResetting,
  pct,
  profileLabel,
  refreshSchemaCache,
  runCurator,
  resetLearning,
} = chat;
</script>

<template>
  <header class="header db-glass db-glass--bar db-header-bar">
    <div class="header-row">
      <div class="header-brand">
        <img class="header-logo" src="/brand/logos/db.svg" alt="" width="36" height="36" />
        <div>
          <h1 class="title">禄存 · 数据库助手</h1>
          <p class="header-tag">谷雨 · 自然语言查库</p>
        </div>
        <img class="header-avatar" src="/brand/avatars/db.svg" alt="" width="40" height="40" title="禄存虚拟形象" />
      </div>
      <div class="header-actions">
        <button type="button" class="brand-btn brand-btn--secondary panel-toggle" @click="showIntel = !showIntel">
          {{ showIntel ? "收起说明" : "使用说明" }}
        </button>
        <DbUserMenu />
      </div>
    </div>
    <div v-if="showIntel" class="intel-panel db-glass--soft">
      <p class="subtitle">
        用日常语言提问即可，支持多条件组合查询，例如「60岁以上住在北京的男性」或「张三最近一周的健康记录」。
      </p>
      <div v-if="runtimeConfig" class="runtime-bar">
        <span class="brand-chip runtime-chip">库 {{ runtimeConfig.mysql_database }}</span>
        <span class="brand-chip runtime-chip">补丁 {{ runtimeConfig.domain }}</span>
        <span class="brand-chip runtime-chip">档位 {{ profileLabel(runtimeConfig.profile) }}</span>
        <span v-if="runtimeConfig.features?.enableQueryIr" class="brand-chip runtime-chip">复杂条件</span>
        <span v-if="runtimeConfig.features?.enableSqlPlanDirect" class="brand-chip runtime-chip">单次 SQL</span>
      </div>
      <p class="intel-intro">
        助手会自动理解问题、选择相关数据并生成回答；问得越多，对相似问题会越熟练。
      </p>
      <div class="intel-tags">
        <span class="brand-chip tag">自然语言提问</span>
        <span class="brand-chip tag">多条件查询</span>
        <span class="brand-chip tag">库级补丁扩展</span>
        <span class="brand-chip tag">相似问题记忆</span>
      </div>
      <p v-if="runtimeConfig" class="intel-muted">
        当前连接 <strong>{{ runtimeConfig.mysql_database }}</strong>，域补丁
        <strong>{{ runtimeConfig.domain }}</strong>（{{ runtimeConfig.patch?.hint_count ?? 0 }} 条业务提示）。
        换库只需改服务端 .env 与 <code>data/domains/&lt;库名&gt;/</code>，无需改总管协议。
      </p>
      <div v-if="intelLoading" class="intel-muted">正在加载使用统计…</div>
      <div v-else-if="intel" class="brand-stat-grid intel-stats-grid">
        <div class="brand-stat intel-stat">
          <span class="brand-stat__value brand-stat__value--accent">{{ intel.learning?.total ?? 0 }}</span>
          <span class="brand-stat__label">已回答问题</span>
        </div>
        <div class="brand-stat intel-stat">
          <span class="brand-stat__value">{{ pct(intel.learning?.okRate) }}</span>
          <span class="brand-stat__label">回答满意率</span>
        </div>
        <div class="brand-stat intel-stat">
          <span class="brand-stat__value">{{ intel.sqlTemplates?.count ?? 0 }}</span>
          <span class="brand-stat__label">常用查询模板</span>
        </div>
        <div class="brand-stat intel-stat">
          <span class="brand-stat__value">{{ intel.evolution?.evolvedHintCount ?? 0 }}</span>
          <span class="brand-stat__label">已沉淀优化</span>
        </div>
      </div>
      <details class="intel-advanced">
        <summary>管理与维护（一般无需操作）</summary>
        <p class="intel-muted">
          若回答变不准，可整理学习记录或恢复默认。不影响数据库里的真实业务数据。
        </p>
        <div class="intel-actions">
          <button type="button" class="intel-btn" :disabled="intelRefreshing" @click="refreshSchemaCache">
            {{ intelRefreshing ? "刷新中…" : "刷新 Schema 缓存" }}
          </button>
          <button type="button" class="intel-btn" :disabled="intelCurating" @click="runCurator">
            {{ intelCurating ? "整理中…" : "整理学习记录" }}
          </button>
          <button type="button" class="intel-btn intel-btn-danger" :disabled="intelResetting" @click="resetLearning('learning')">
            清除学习记忆
          </button>
          <button type="button" class="intel-btn intel-btn-danger" :disabled="intelResetting" @click="resetLearning('prompts')">
            重置自我进化
          </button>
          <button type="button" class="intel-btn intel-btn-danger" :disabled="intelResetting" @click="resetLearning('all')">
            全部恢复默认
          </button>
        </div>
      </details>
    </div>
  </header>
</template>
