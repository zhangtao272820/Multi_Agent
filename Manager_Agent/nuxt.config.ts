import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isManagerWsAuthRequired } from './server/utils/platform/managerEnvModes'

function agentSharedDir() {
  const docker = fileURLToPath(new URL('./agent-repo-shared', import.meta.url))
  const local = fileURLToPath(new URL('../shared', import.meta.url))
  if (
    existsSync(join(docker, 'brand')) ||
    existsSync(join(docker, 'clawhiveJwt.ts')) ||
    existsSync(join(docker, 'agentPgClient.ts'))
  ) {
    return docker
  }
  return local
}

function agentBrandDir() {
  return join(agentSharedDir(), 'brand')
}

const brandDir = agentBrandDir()

export default defineNuxtConfig({
  alias: {
    '#agent-shared': agentSharedDir(),
    '@brand': brandDir
  },
  // 组件按文件名注册（ManagerWorkbenchHeader），避免 workbench/ 前缀导致模板标签无法解析、高度塌缩为 0
  components: [{ path: '~/components', pathPrefix: false }],
  css: [
    join(brandDir, 'index.css'),
    '~/assets/css/cosmic-chat-layout.css',
    '~/assets/css/claude-chat-theme.css',
    '~/assets/css/manager-fullscreen-layout.css',
    '~/assets/css/amap-reply-cards.css',
    '~/assets/css/manager-cursor-chat.css',
    '~/assets/css/workbench-modes.css',
    '~/assets/css/workbench-visual-enhance.css',
    '~/assets/css/manager-chat-rail.css',
    '~/assets/css/manager-index-scoped.css',
    '~/assets/css/manager-index-cosmic.css',
    /* 节气换肤：在布局/cosmic 之后，HITL 之前 */
    '~/assets/css/manager-season.css',
    /* 近实底霜白壳：3-class Token + 表面强制覆盖，压过深色半透 */
    '~/assets/css/manager-winter-shell.css',
    /* HITL SSOT：计划卡与风险模态结构 */
    '~/assets/css/manager-hitl-panels.css',
    /* 雪景高对比深字：最后加载，压过深色主题浅青残留 */
    '~/assets/css/manager-winter-balance.css',
    /* 主题层：废节气身份，高对比 Harness 风编排台 */
    '~/assets/css/manager-theme.css',
  ],
  compatibilityDate: '2025-07-15',
  devtools: { enabled: process.env.NODE_ENV !== 'production' },
  vite: {
    resolve: {
      alias: {
        '@brand': brandDir
      }
    },
    server: {
      fs: { allow: [brandDir, agentSharedDir()] }
    }
  },
  nitro: {
    alias: {
      '#agent-shared': agentSharedDir(),
      '@brand': brandDir
    },
    publicAssets: [
      {
        baseURL: 'brand',
        dir: brandDir,
        maxAge: 60 * 60 * 24 * 7
      }
    ],
    experimental: {
      websocket: true
    },
    // 媒体文件统一走 server/routes/api/{files,video}/[...path].get.ts（读取 MUSIC/VIDEO_AGENT_HTTP_URL），
    // 勿在此配置 devProxy/routeRules，否则与 Nitro 路由冲突导致 /api/files 404。
  },
  runtimeConfig: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openaiModel: process.env.OPENAI_MODEL ?? 'qwen3.5-flash',
    langsmithTracing: process.env.LANGSMITH_TRACING ?? 'false',
    langsmithProject: process.env.LANGSMITH_PROJECT ?? 'manager-agent-prod',
    public: {
      managerWsToken:
        process.env.NUXT_PUBLIC_MANAGER_WS_TOKEN ||
        (isManagerWsAuthRequired(process.env)
          ? String(process.env.MANAGER_WS_TOKEN || process.env.CLAWHIVE_INTERNAL_TOKEN || '').trim()
          : ''),
      clawhiveAuthUrl:
        process.env.NUXT_PUBLIC_CLAWHIVE_AUTH_URL ||
        process.env.CLAWHIVE_PUBLIC_URL ||
        (process.env.MANAGER_RUNTIME === 'docker' ? 'http://127.0.0.1:18000' : 'http://127.0.0.1:18000'),
      managerUserAuth:
        String(process.env.NUXT_PUBLIC_MANAGER_USER_AUTH || process.env.MANAGER_USER_AUTH || process.env.AGENT_BROWSER_AUTH || '1').trim() !==
        '0'
    },
    agents: {
      dbAgentWsUrl: process.env.DB_AGENT_WS_URL ?? 'ws://localhost:13101/api/chat.ws',
      dbAgentHttpUrl: process.env.DB_AGENT_HTTP_URL ?? 'http://localhost:13101',
      ragAgentHttpUrl: process.env.RAG_AGENT_HTTP_URL ?? 'http://localhost:13102',
      codeAgentWsUrl: process.env.CODE_AGENT_WS_URL ?? 'ws://localhost:13103/_ws',
      crawlerAgentWsUrl: process.env.CRAWLER_AGENT_WS_URL ?? 'ws://localhost:13104/_ws',
      lobsterAgentWsUrl: process.env.LOBSTER_AGENT_WS_URL ?? 'ws://localhost:13108/_ws',
      aiAdminAgentWsUrl: process.env.AI_ADMIN_AGENT_WS_URL ?? 'ws://localhost:13105/api/chat/ws',
      multimodalAgentHttpUrl: process.env.MULTIMODAL_AGENT_HTTP_URL ?? 'http://localhost:13107',
      musicAgentHttpUrl: process.env.MUSIC_AGENT_HTTP_URL ?? 'http://127.0.0.1:13110',
      videoAgentHttpUrl: process.env.VIDEO_AGENT_HTTP_URL ?? 'http://127.0.0.1:13111',
      musicAgentWsUrl: process.env.MUSIC_AGENT_WS_URL ?? 'ws://localhost:13110/ws',
      videoAgentWsUrl: process.env.VIDEO_AGENT_WS_URL ?? 'ws://localhost:13111/ws/video',
      timeoutMs: (() => {
        const v = Number(process.env.AGENT_TIMEOUT_MS ?? 60000)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 60000
      })()
    }
  }
})
