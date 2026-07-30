// 本地直接 npm run dev 默认 3000；Docker entrypoint / 显式 APP_PORT 时使用 13108 等
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function agentSharedDir() {
  const docker = fileURLToPath(new URL('./agent-repo-shared', import.meta.url))
  const local = fileURLToPath(new URL('../shared', import.meta.url))
  if (existsSync(join(docker, 'qwenModelKwargs.ts'))) return docker
  return local
}

const mcpServers = (() => {
  const raw =
    process.env.LOBSTER_MCP_SERVERS ??
    process.env.MCP_SERVERS ??
    process.env.MCP_SERVERS_JSON ??
    ''
  if (!raw.trim()) return undefined
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : undefined
  } catch {
    return undefined
  }
})()

const _rawDevPort = process.env.APP_PORT || process.env.PORT
const hasFixedDevPort = _rawDevPort !== undefined && String(_rawDevPort).trim() !== ''
const devPortParsed = hasFixedDevPort ? Number.parseInt(String(_rawDevPort), 10) : Number.NaN
const devPort = Number.isFinite(devPortParsed) && devPortParsed > 0 ? devPortParsed : 3000

export default defineNuxtConfig({
  alias: {
    '#agent-shared': agentSharedDir()
  },
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  // 本地默认 localhost（终端会显示 http://localhost:端口）；Docker entrypoint 用 --host 0.0.0.0 覆盖
  devServer: {
    host: process.env.NUXT_DEV_HOST || 'localhost',
    port: devPort,
    // 本地 3000 被占用时会自动换端口；固定端口仅在 Docker/显式 APP_PORT 时启用
    strictPort: hasFixedDevPort
  },
  vite: {
    server: {
      strictPort: hasFixedDevPort,
      // Docker：HMR WebSocket 必须绑在映射端口；本地换端口时不要写死 3000，否则 ws 连不上
      ...(hasFixedDevPort
        ? {
            hmr: {
              protocol: 'ws',
              port: devPort,
              clientPort: devPort
            }
          }
        : {}),
      watch:
        process.env.CHOKIDAR_USEPOLLING === '1'
          ? { usePolling: true, interval: 300 }
          : undefined
    }
  },
  nitro: {
    alias: {
      '#agent-shared': agentSharedDir()
    },
    experimental: {
      websocket: true
    },
    externals: {
      external: [
        '@langchain/core',
        '@langchain/core/prompts',
        '@langchain/core/output_parsers',
        '@langchain/core/runnables',
        '@langchain/langgraph',
        '@langchain/openai',
        'zod',
        'playwright',
        '@modelcontextprotocol/sdk',
        '@browserbasehq/stagehand'
      ]
    }
  },
  runtimeConfig: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    lobster: {
      plannerModel: process.env.LOBSTER_PLANNER_MODEL || process.env.OPENAI_MODEL,
      decisionModel: process.env.LOBSTER_DECISION_MODEL || process.env.OPENAI_MODEL,
      visionModel: process.env.LOBSTER_VISION_MODEL,
      guiModel: process.env.LOBSTER_GUI_MODEL || process.env.LOBSTER_VISION_MODEL,
      stagehandModel: process.env.LOBSTER_STAGEHAND_MODEL || process.env.LOBSTER_DECISION_MODEL || process.env.OPENAI_MODEL,
      useVision: (() => {
        const v = String(process.env.LOBSTER_USE_VISION ?? 'false').trim().toLowerCase()
        return v === '1' || v === 'true' || v === 'yes'
      })(),
      promptChars: (() => {
        const v = Number(process.env.LOBSTER_PROMPT_CHARS ?? 2600)
        return Number.isFinite(v) && v > 200 ? Math.floor(v) : 2600
      })(),
      plannerMaxTokens: (() => {
        const v = Number(process.env.LOBSTER_PLANNER_MAX_TOKENS ?? 600)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 600
      })(),
      decisionMaxTokens: (() => {
        const v = Number(process.env.LOBSTER_DECISION_MAX_TOKENS ?? 420)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 420
      })(),
      extractMaxTokens: (() => {
        const v = Number(process.env.LOBSTER_EXTRACT_MAX_TOKENS ?? 700)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 700
      })(),
      visionMaxTokens: (() => {
        const v = Number(process.env.LOBSTER_VISION_MAX_TOKENS ?? 420)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 420
      })(),
      visionSummaryMaxChars: (() => {
        const v = Number(process.env.LOBSTER_VISION_SUMMARY_MAX_CHARS ?? 1400)
        return Number.isFinite(v) && v > 200 ? Math.floor(v) : 1400
      })(),
      maxDecisionCalls: (() => {
        const v = Number(process.env.LOBSTER_MAX_DECISION_CALLS ?? 18)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 18
      })(),
      maxVisionCalls: (() => {
        const v = Number(process.env.LOBSTER_MAX_VISION_CALLS ?? 8)
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 8
      })(),
      maxOcrCalls: (() => {
        const v = Number(process.env.LOBSTER_MAX_OCR_CALLS ?? 4)
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 4
      })(),
      observationCandidateLimit: (() => {
        const v = Number(process.env.LOBSTER_OBS_CAND_LIMIT ?? 24)
        return Number.isFinite(v) && v > 0 ? Math.min(48, Math.floor(v)) : 24
      })(),
      observationTextChars: (() => {
        const v = Number(process.env.LOBSTER_OBS_TEXT_CHARS ?? 1800)
        return Number.isFinite(v) && v > 200 ? Math.floor(v) : 1800
      })(),
      storageDir: process.env.LOBSTER_STORAGE_DIR ?? '.data/lobster',
      loginWaitMs: (() => {
        const v = Number(process.env.LOBSTER_LOGIN_WAIT_MS ?? 120000)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 120000
      })(),
      loginPollMs: (() => {
        const v = Number(process.env.LOBSTER_LOGIN_POLL_MS ?? 2000)
        return Number.isFinite(v) && v > 200 ? Math.floor(v) : 2000
      })(),
      headless: (() => {
        const v = String(process.env.LOBSTER_HEADLESS ?? 'true').trim().toLowerCase()
        return v === '1' || v === 'true' || v === 'yes'
      })(),
      maxSteps: (() => {
        const v = Number(process.env.LOBSTER_MAX_STEPS ?? 20)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20
      })(),
      maxRecoverCount: (() => {
        const v = Number(process.env.LOBSTER_MAX_RECOVER_COUNT ?? 6)
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 6
      })(),
      maxForcedIntentsTotal: (() => {
        const v = Number(process.env.LOBSTER_MAX_FORCED_TOTAL ?? 10)
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 10
      })(),
      maxForcedIntentsPerFailure: (() => {
        const v = Number(process.env.LOBSTER_MAX_FORCED_PER_FAILURE ?? 2)
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2
      })(),
      adminToken: process.env.LOBSTER_ADMIN_TOKEN,
      allowRiskyRecoveryClicks: (() => {
        const v = String(process.env.LOBSTER_ALLOW_RISKY_RECOVERY_CLICKS ?? 'false').trim().toLowerCase()
        return v === '1' || v === 'true' || v === 'yes'
      })(),
      executionMode: process.env.LOBSTER_EXECUTION_MODE ?? 'auto',
      mcpEnabled: String(process.env.LOBSTER_MCP_ENABLED ?? '1').trim() !== '0',
      stagehandEnabled: String(process.env.LOBSTER_STAGEHAND_ENABLED ?? '1').trim() !== '0',
      engineSelector: String(process.env.LOBSTER_ENGINE_SELECTOR ?? '1').trim() !== '0',
      mcpUrl: process.env.LOBSTER_MCP_URL ?? '',
      mcpMaxSteps: (() => {
        const v = Number(process.env.LOBSTER_MCP_MAX_STEPS ?? 24)
        return Number.isFinite(v) && v >= 4 ? Math.min(48, Math.floor(v)) : 24
      })(),
      sessionDir: process.env.LOBSTER_SESSION_DIR ?? ''
    },
    mcpServers,
    public: {
      wsPath: process.env.WS_PATH ?? '/_ws'
    }
  }
})
