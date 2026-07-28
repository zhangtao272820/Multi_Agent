import type { CapabilityId, CapabilityProfile } from './capabilities'
import { CAPABILITY_REGISTRY } from './capabilities'
import { agentWsUrlToHttpOrigin, resolveAgentUrl } from '../../../utils/platform/agentEndpoints'

const DATA_AGENTS = ['db', 'rag', 'crawler'] as const

export type AgentRegistryEntry = CapabilityProfile & {
  /** HTTP 基址（probe/health）；WS 类 Agent 可填 HTTP 网关或留空 */
  httpBase?: string
  wsUrl?: string
  healthPath?: string
  probePath?: string
  /** MCP export 端点（/api/mcp） */
  mcpUrl?: string
}

export type AgentRegistrySnapshot = {
  updatedAt: string
  entries: AgentRegistryEntry[]
}

function trimUrl(v: unknown) {
  return String(v ?? '').trim().replace(/\/+$/, '')
}

function mcpUrlForAgent(id: string, httpBase: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const base = trimUrl(httpBase)
  if (!base) return undefined
  if (id === 'gui' && String(env.LOBSTER_MCP_EXPORT ?? '1').trim() !== '0') return `${base}/api/mcp`
  if (id === 'code' && String(env.CODE_MCP_SERVER ?? '0').trim() === '1') return `${base}/api/mcp`
  if (id === 'rag' && String(env.RAG_MCP_SERVER ?? '0').trim() === '1') return `${base}/api/mcp`
  if (id === 'crawler' && String(env.EXTRACTOR_MCP_SERVER ?? '1').trim() !== '0') return `${base}/api/mcp`
  return undefined
}

/** 从环境变量解析各子 Agent 端点，与 CAPABILITY_REGISTRY 合并为统一注册表 */
export function buildAgentRegistry(env: NodeJS.ProcessEnv = process.env): AgentRegistrySnapshot {
  const http = {
    db: trimUrl(resolveAgentUrl(env.DB_AGENT_HTTP_URL, env)),
    rag: trimUrl(resolveAgentUrl(env.RAG_AGENT_HTTP_URL, env)),
    multimodal: trimUrl(resolveAgentUrl(env.MULTIMODAL_AGENT_HTTP_URL, env)),
    music: trimUrl(resolveAgentUrl(env.MUSIC_AGENT_HTTP_URL, env)),
    video: trimUrl(resolveAgentUrl(env.VIDEO_AGENT_HTTP_URL, env)),
    crawler:
      trimUrl(resolveAgentUrl(env.CRAWLER_AGENT_HTTP_URL, env)) ||
      trimUrl(agentWsUrlToHttpOrigin(resolveAgentUrl(env.CRAWLER_AGENT_WS_URL, env)))
  }
  const ws = {
    db: trimUrl(resolveAgentUrl(env.DB_AGENT_WS_URL, env)),
    code: trimUrl(resolveAgentUrl(env.CODE_AGENT_WS_URL, env)),
    crawler: trimUrl(resolveAgentUrl(env.CRAWLER_AGENT_WS_URL, env)),
    gui: trimUrl(resolveAgentUrl(env.LOBSTER_AGENT_WS_URL, env)),
    admin: trimUrl(resolveAgentUrl(env.AI_ADMIN_AGENT_WS_URL, env)),
    music: trimUrl(resolveAgentUrl(env.MUSIC_AGENT_WS_URL, env)),
    video: trimUrl(resolveAgentUrl(env.VIDEO_AGENT_WS_URL, env))
  }

  const endpointById: Partial<Record<CapabilityId, { httpBase?: string; wsUrl?: string; healthPath?: string; probePath?: string }>> = {
    db: { httpBase: http.db || undefined, wsUrl: ws.db || undefined, healthPath: '/api/health', probePath: '/api/probe' },
    rag: { httpBase: http.rag || undefined, healthPath: '/api/health', probePath: '/api/probe' },
    code: { wsUrl: ws.code || undefined },
    crawler: { wsUrl: ws.crawler || undefined, httpBase: http.crawler || undefined, healthPath: '/api/health' },
    gui: { wsUrl: ws.gui || undefined, httpBase: ws.gui ? agentWsUrlToHttpOrigin(ws.gui) : undefined, healthPath: '/api/health' },
    admin: { wsUrl: ws.admin || undefined, healthPath: '/api/health' },
    multimodal: { httpBase: http.multimodal || undefined, healthPath: '/api/health', probePath: '/api/probe' },
    music: { httpBase: http.music || undefined, wsUrl: ws.music || undefined, healthPath: '/api/health' },
    video: { httpBase: http.video || undefined, wsUrl: ws.video || undefined, healthPath: '/api/health' },
    clean: {},
    visualize: {},
    report: {}
  }

  const entries: AgentRegistryEntry[] = CAPABILITY_REGISTRY.map((c) => {
    const ep = endpointById[c.id] || {}
    const httpBase = ep.httpBase
    return {
      ...c,
      ...ep,
      ...(mcpUrlForAgent(c.id, httpBase, env) ? { mcpUrl: mcpUrlForAgent(c.id, httpBase, env) } : {}),
    }
  })

  return { updatedAt: new Date().toISOString(), entries }
}

export function registryContextText(snapshot?: AgentRegistrySnapshot) {
  const entries = snapshot?.entries ?? buildAgentRegistry().entries
  return [
    '### Agent 注册表（调度者权威能力清单）',
    ...entries.map(
      (c) =>
        `- ${c.id}｜${c.label}｜mode=${c.mode}｜risk=${c.risk}${c.httpBase ? `｜http=${c.httpBase}` : ''}${c.mcpUrl ? `｜mcp=${c.mcpUrl}` : ''}${c.wsUrl ? '｜ws' : ''}`
    )
  ].join('\n')
}

export type ToolHealthAgentRow = {
  agent: CapabilityId
  status: 'healthy' | 'degraded' | 'down' | 'unknown'
  avgMs: number
  p95Ms: number
  samples: number
  stepSkipCount?: number
  endpoint?: string
  liveProbe?: 'ok' | 'fail' | 'skip'
  /** ws | http | ws+http | internal */
  transport?: string
}

export function filterAgentsByToolHealth<T extends string>(
  agents: T[],
  toolHealth?: { agents?: Array<{ agent: string; status: string }> } | null,
  taskText?: string
): T[] {
  if (!agents.length || !toolHealth?.agents?.length) return agents
  const down = new Set(
    toolHealth.agents.filter((a) => a.status === 'down').map((a) => String(a.agent).trim())
  )
  if (!down.size) return agents
  let filtered = agents.filter((a) => !down.has(String(a)))
  if (!filtered.length) return agents

  const synth = new Set(['report', 'visualize', 'clean', 'code'])
  const hasSynth = filtered.some((a) => synth.has(String(a)))
  const hasDataInPlan = filtered.some((a) => DATA_AGENTS.includes(a as (typeof DATA_AGENTS)[number]))

  if (hasSynth && !hasDataInPlan) {
    for (const d of DATA_AGENTS) {
      if (agents.includes(d as T) && !down.has(d)) {
        filtered = [d as T, ...filtered.filter((a) => a !== d)]
        break
      }
    }
  }
  return filtered
}

/** extended Docker profile 才默认可用的能力（结构性 registry + toolHealth，不用问句关键词） */
export const EXTENDED_PROFILE_AGENTS: CapabilityId[] = ['music', 'video', 'gui']

const EXTENDED_AGENT_LABELS: Partial<Record<CapabilityId, string>> = {
  music: '音乐生成（Music_Agent）',
  video: '视频生成（Video_Agent）',
  gui: 'GUI 浏览器自动化（Lobster_Agent）'
}

const CORE_FALLBACK_AGENTS = new Set(['db', 'rag', 'code', 'crawler', 'admin', 'clean', 'visualize', 'report', 'multimodal'])

export type ExtendedAgentAvailability = {
  blocked: CapabilityId[]
  clarifyQuestions: string[]
  degradeHint?: string
}

/** P0-4：extended 能力离线/未配置时，路由层给出明确提示（非 regex） */
export function reconcileExtendedAgentAvailability(
  intent: string,
  allowedAgents: string[],
  toolHealth?: { agents?: Array<{ agent: string; status: string }> } | null
): ExtendedAgentAvailability {
  const needed = allowedAgents.filter((a) => EXTENDED_PROFILE_AGENTS.includes(a as CapabilityId)) as CapabilityId[]
  if (!needed.length) return { blocked: [], clarifyQuestions: [] }

  const down = new Set(
    (toolHealth?.agents || [])
      .filter((a) => a.status === 'down')
      .map((a) => String(a.agent).trim())
  )
  const blocked = needed.filter((a) => down.has(a))
  if (!blocked.length) return { blocked: [], clarifyQuestions: [] }

  const names = blocked.map((a) => EXTENDED_AGENT_LABELS[a] || a).join('、')
  const hasCoreFallback = allowedAgents.some((a) => CORE_FALLBACK_AGENTS.has(a) && !down.has(a))
  const extendedOnlyIntent = new Set(['music', 'video', 'gui']).has(String(intent || '').trim())

  if (hasCoreFallback && !extendedOnlyIntent) {
    return {
      blocked,
      clarifyQuestions: [],
      degradeHint: `extended 能力暂不可用（${names}），将跳过相关步骤并继续其余编排。`
    }
  }

  return {
    blocked,
    clarifyQuestions: [
      `当前部署未启用或未启动以下能力：${names}。`,
      '标准 Docker 编排含 DB/RAG/Code/Extractor/Admin/Multimodal/Manager；music、video、Lobster/gui 需启用 extended profile 或单独启动对应容器。',
      '请确认是否改用标准能力（如联网搜索、静态抓取、多模态理解），或联系运维启用 extended 部署后再试。'
    ]
  }
}

export function unhealthyAgentsForPrompt(toolHealth?: { agents?: Array<{ agent: string; status: string }> } | null): string {
  const rows = toolHealth?.agents || []
  const down = rows.filter((a) => a.status === 'down')
  const degraded = rows.filter((a) => a.status === 'degraded')
  const parts: string[] = []
  if (down.length) parts.push(`执行可能受阻（仍可按任务需要选用）：${down.map((a) => a.agent).join('、')}`)
  if (degraded.length) parts.push(`慎用（降级）：${degraded.map((a) => `${a.agent}=${a.status}`).join('；')}`)
  return parts.join('；')
}
