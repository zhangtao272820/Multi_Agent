import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function agentSharedDir() {
  const docker = fileURLToPath(new URL('./agent-repo-shared', import.meta.url))
  const local = fileURLToPath(new URL('../shared', import.meta.url))
  if (existsSync(join(docker, 'agentPgClient.ts'))) return docker
  return local
}

export default defineNuxtConfig({
  alias: {
    '#agent-shared': agentSharedDir()
  },
  compatibilityDate: '2024-11-01',
  devtools: { enabled: process.env.NODE_ENV !== 'production' },
  devServer: {
    port: Number(((globalThis as any).process?.env?.PORT ?? (globalThis as any).process?.env?.RAG_PORT ?? 13102))
  },
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/rag-cursor-chat.css'],
  runtimeConfig: {
    public: {
      clawhiveAuthUrl:
        process.env.NUXT_PUBLIC_CLAWHIVE_AUTH_URL ||
        process.env.CLAWHIVE_PUBLIC_URL ||
        'http://127.0.0.1:18000',
      agentBrowserAuth: process.env.NUXT_PUBLIC_AGENT_BROWSER_AUTH || process.env.AGENT_BROWSER_AUTH || '1'
    }
  },
  nitro: {
    alias: {
      '#agent-shared': agentSharedDir()
    }
  },
  vite: {
    optimizeDeps: {
      include: ['markdown-it', 'echarts', 'three'],
    },
  },
})
