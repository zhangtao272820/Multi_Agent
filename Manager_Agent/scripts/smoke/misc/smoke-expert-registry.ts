/**
 * Wave6 K5：专家注册表 + MCP 面 inventory（非统一网关）+ Trace 深链形态
 */
import { buildAgentRegistry, registryContextText } from '../../../server/graph/core/agent/agentRegistry'
import { buildTraceDeepLinks } from '../../../server/graph/core/runtime/traceDeepLinks'
import { findPromptHygieneViolations } from '../../../agent-repo-shared/promptHygiene'
import { assembleOrchestratorSystemPrompt } from '../../../server/graph/llm/orchestratorPromptProfiles'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-expert-registry] ${msg}`)
}

const prev = { ...process.env }
process.env.DB_AGENT_HTTP_URL = 'http://db.test:13101'
process.env.RAG_AGENT_HTTP_URL = 'http://rag.test:13102'
process.env.LOBSTER_AGENT_WS_URL = 'ws://lobster.test:13108/ws'
process.env.LOBSTER_MCP_EXPORT = '1'
process.env.EXTRACTOR_MCP_SERVER = '1'
process.env.CRAWLER_AGENT_HTTP_URL = 'http://extractor.test:13104'
process.env.LANGFUSE_PUBLIC_URL = 'http://langfuse.test:3000'
process.env.TEMPO_UI_URL = 'http://grafana.test:3000/explore'
process.env.MANAGER_OTEL_EXPORT = '1'

const reg = buildAgentRegistry(process.env)
assert(reg.entries.length >= 8, `entries=${reg.entries.length}`)
const byId = Object.fromEntries(reg.entries.map((e) => [e.id, e]))
assert(byId.db?.httpBase?.includes('db.test'), 'db http')
assert(byId.rag?.httpBase?.includes('rag.test'), 'rag http')
assert(byId.gui?.mcpUrl?.endsWith('/api/mcp'), 'gui mcp surface')
assert(byId.crawler?.mcpUrl?.endsWith('/api/mcp'), 'extractor/crawler mcp surface')

const ctx = registryContextText(reg)
assert(ctx.includes('Agent 注册表'), 'registry context')
assert(ctx.includes('mcp='), 'mcp in context')

const links = buildTraceDeepLinks('run-abc-123', process.env)
assert(links.langfuseUrl?.includes('/trace/run-abc-123'), `langfuse=${links.langfuseUrl}`)
assert(links.tempoUrl?.includes('traceId=run-abc-123'), `tempo=${links.tempoUrl}`)
assert(links.otelEnabled, 'otel enabled')

// K4：生产 System Prompt 卫生（无领域专名）
const sys = assembleOrchestratorSystemPrompt({})
const hygieneHits = findPromptHygieneViolations(sys)
assert(hygieneHits.length === 0, `orchestrator hygiene hits=${hygieneHits.join(',')}`)

// 恢复 env
for (const k of Object.keys(process.env)) {
  if (!(k in prev)) delete process.env[k]
}
Object.assign(process.env, prev)

console.log('smoke-expert-registry: OK')
