// https://nuxt.com/docs/api/configuration/nuxt-config
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function agentSharedDir() {
  const docker = fileURLToPath(new URL('./agent-repo-shared', import.meta.url))
  const local = fileURLToPath(new URL('../shared', import.meta.url))
  if (existsSync(join(docker, 'agentPgClient.ts'))) return docker
  return local
}

const mcpServers = (() => {
  const raw = process.env.MCP_SERVERS ?? process.env.MCP_SERVERS_JSON ?? "";
  if (!raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
})();

export default defineNuxtConfig({
  css: ['~/assets/css/db-cursor-chat.css'],
  alias: {
    '#agent-shared': agentSharedDir()
  },
  compatibilityDate: '2025-07-15',
  devtools: { enabled: process.env.NODE_ENV !== 'production' },
  devServer: {
    port: Number(process.env.PORT ?? process.env.DB_PORT ?? 13101)
  },
  nitro: {
    alias: {
      '#agent-shared': agentSharedDir()
    },
    experimental: {
      websocket: true
    }
  },
  runtimeConfig: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openaiModel: process.env.OPENAI_MODEL ?? 'qwen3.5-flash',
    openaiOrchestrationModel: process.env.OPENAI_ORCHESTRATION_MODEL,
    openaiNluModel: process.env.OPENAI_NLU_MODEL,
    openaiAgentModel: process.env.OPENAI_AGENT_MODEL,
    openaiComplexModel: process.env.OPENAI_COMPLEX_MODEL,
    openaiEmbeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-v1',
    mysql: {
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? 'root',
      password: String(process.env.MYSQL_PASSWORD ?? process.env.NUXT_MYSQL_PASSWORD ?? '123456'),
      database: process.env.MYSQL_DATABASE ?? 'p2026'
    },
    mcpServers,
    public: {
      clawhiveAuthUrl:
        process.env.NUXT_PUBLIC_CLAWHIVE_AUTH_URL ||
        process.env.CLAWHIVE_PUBLIC_URL ||
        'http://127.0.0.1:18000',
      agentBrowserAuth: process.env.NUXT_PUBLIC_AGENT_BROWSER_AUTH || process.env.AGENT_BROWSER_AUTH || '1'
    }
  }
})
