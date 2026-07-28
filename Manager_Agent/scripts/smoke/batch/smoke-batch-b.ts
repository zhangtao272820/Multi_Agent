/**
 * 批次 B 回归：P1-11 / P1-12 / P2-7 / P2-8 / P2-9 / P2-10
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractManagerWsToken,
  isManagerWsAuthEnabled,
  validateManagerWsAuth
} from '../../../server/graph/core/runtime/wsAuth'
import { resolveCheckpointBackend, resetCheckpointRedisForTests } from '../../../server/graph/core/runtime/checkpointRedis'
import {
  deleteHumanConfirmCheckpoint,
  loadHumanConfirmCheckpoint,
  saveHumanConfirmCheckpoint
} from '../../../server/graph/core/runtime/checkpointStore'
import { shouldSkipCriticLlm } from '../../../server/graph/core/output/criticPolicy'
import { crawlerHttpAsyncEnabled } from '../../../server/utils/agents/pollAgentJob'
import {
  buildOtelTracesFromMetrics,
  buildW3cTraceparent,
  isManagerOtelExportEnabled,
  isManagerOtelTraceparentEnabled
} from '../../../server/graph/core/runtime/otelExport'
import {
  buildOtlpExportBody,
  hexToOtlpBytes,
  isManagerOtlpPushEnabled,
  pushOtlpTraces,
  resetOtlpPushDedupeForTests
} from '../../../server/graph/core/runtime/otelOtlpPush'
import { buildAgentTraceHeaders } from '../../../server/utils/agents/agentTrace'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// P1-11 WS 鉴权默认关（须同时清 AUTH_MODE，避免本机 .env 污染）
delete process.env.MANAGER_WS_AUTH
delete process.env.MANAGER_AUTH_MODE
assert(!isManagerWsAuthEnabled(), 'ws auth default off')
process.env.MANAGER_WS_AUTH = '1'
process.env.MANAGER_WS_TOKEN = 'test-ws-token'
assert(isManagerWsAuthEnabled(), 'ws auth on when env=1')
assert(
  validateManagerWsAuth({
    messageToken: 'test-ws-token'
  }).ok,
  'ws token valid'
)
assert(
  !validateManagerWsAuth({ messageToken: 'bad' }).ok,
  'ws token invalid rejected'
)
assert(
  extractManagerWsToken({ url: 'ws://localhost/api/manager-ws?token=test-ws-token' }) === 'test-ws-token',
  'ws token from query'
)
delete process.env.MANAGER_WS_AUTH
delete process.env.MANAGER_AUTH_MODE
delete process.env.MANAGER_WS_TOKEN

// P1-12 probe executable（Manager 侧逻辑）
function resolveDbProbe(dbData: Record<string, unknown>) {
  const dbConnBad = Boolean(dbData?.db && String(dbData.db).includes('_db'))
  const schemaMatched =
    dbData?.schemaMatched !== undefined
      ? Boolean(dbData.schemaMatched)
      : Boolean(dbData?.matched) || (Array.isArray(dbData?.tables) && dbData.tables.length > 0)
  const pingOk = dbData?.pingOk === undefined ? true : Boolean(dbData.pingOk)
  const executable =
    dbData?.executable !== undefined ? Boolean(dbData.executable) : schemaMatched && pingOk && !dbConnBad
  return { schemaMatched, pingOk, executable, matched: executable }
}
assert(
  resolveDbProbe({ matched: true, tables: ['orders'], pingOk: true, executable: true }).matched,
  'executable probe matched'
)
assert(
  !resolveDbProbe({ schemaMatched: true, tables: ['orders'], pingOk: false, executable: false }).matched,
  'ping fail not matched'
)
assert(
  resolveDbProbe({ matched: true, tables: ['orders'] }).matched,
  'legacy probe without pingOk still matched'
)

// P2-7 checkpoint file backend
resetCheckpointRedisForTests()
delete process.env.MANAGER_CHECKPOINT_BACKEND
delete process.env.REDIS_URL
assert(resolveCheckpointBackend() === 'file', 'checkpoint file default')
const ckDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-ck-'))
const prevCwd = process.cwd()
process.chdir(ckDir)
await saveHumanConfirmCheckpoint('sess-b', { foo: 1 })
assert((await loadHumanConfirmCheckpoint('sess-b'))?.foo === 1, 'checkpoint roundtrip file')
await deleteHumanConfirmCheckpoint('sess-b')
process.chdir(prevCwd)
await fs.rm(ckDir, { recursive: true, force: true })

// P2-8 crawler async 默认开
delete process.env.MANAGER_CRAWLER_HTTP_ASYNC
assert(crawlerHttpAsyncEnabled(), 'crawler async default on')
process.env.MANAGER_CRAWLER_HTTP_ASYNC = '0'
assert(!crawlerHttpAsyncEnabled(), 'crawler async off')
delete process.env.MANAGER_CRAWLER_HTTP_ASYNC

// P2-9 critic skip 防误跳过
assert(
  !shouldSkipCriticLlm({
    routeConfidence: 0.95,
    intent: 'multi',
    planStepCount: 1,
    planAgents: ['code'],
    timeLeftMs: 60_000
  }).skip,
  'high conf code plan not skip critic'
)
assert(
  shouldSkipCriticLlm({
    routeConfidence: 0.95,
    intent: 'rag',
    planStepCount: 1,
    planAgents: ['rag'],
    timeLeftMs: 60_000,
    meta: { needsWebSearch: false }
  }).skip,
  'simple rag high conf may skip'
)
assert(
  !shouldSkipCriticLlm({
    routeConfidence: 0.95,
    intent: 'multi',
    planStepCount: 1,
    planAgents: ['crawler'],
    timeLeftMs: 60_000,
    meta: { needsWebSearch: true }
  }).skip,
  'web search blocked skip'
)

// P2-10 / E1：OTel export 默认关；W3C traceparent 出站默认开（设 0 可关）
delete process.env.MANAGER_OTEL_EXPORT
delete process.env.MANAGER_OTEL_TRACEPARENT
assert(!isManagerOtelExportEnabled(), 'otel export default off')
assert(isManagerOtelTraceparentEnabled(), 'traceparent default on (E1)')
process.env.MANAGER_OTEL_TRACEPARENT = '0'
assert(!isManagerOtelTraceparentEnabled(), 'traceparent off when env=0')
process.env.MANAGER_OTEL_TRACEPARENT = '1'
assert(buildAgentTraceHeaders('run-abc').traceparent?.startsWith('00-'), 'traceparent header when enabled')
const traces = buildOtelTracesFromMetrics([
  { runId: 'run1', phase: 'probe', ms: 12, ts: new Date().toISOString() },
  { runId: 'run1', phase: 'db', ms: 400, ts: new Date().toISOString(), tokens: 10 }
])
assert(traces.length === 1 && traces[0]!.spans.length === 2, 'otel trace builder')
assert(buildW3cTraceparent('run1').split('-').length === 4, 'w3c traceparent format')
delete process.env.MANAGER_OTEL_TRACEPARENT

// P1b-1 OTLP/HTTP body shape + mock push
resetOtlpPushDedupeForTests()
delete process.env.MANAGER_OTLP_PUSH
delete process.env.MANAGER_OTLP_ENDPOINT
delete process.env.MANAGER_OTLP_ENDPOINTS
delete process.env.MANAGER_LANGFUSE_OTLP_ENDPOINT
assert(!isManagerOtlpPushEnabled(), 'otlp push off without endpoint')
process.env.MANAGER_OTLP_PUSH = '1'
process.env.MANAGER_OTLP_ENDPOINT = 'http://tempo.test/v1/traces'
assert(isManagerOtlpPushEnabled(), 'otlp push on with endpoint')
const otlpBody = buildOtlpExportBody(traces)
const scopeSpans = (otlpBody.resourceSpans as any)?.[0]?.scopeSpans
assert(Array.isArray(scopeSpans) && scopeSpans[0]?.spans?.length === 2, 'otlp body spans')
assert(typeof scopeSpans[0].spans[0].traceId === 'string', 'otlp traceId base64')
assert(hexToOtlpBytes('abcd').length > 0, 'hexToOtlpBytes')
let fetched = 0
const pushResult = await pushOtlpTraces(traces, {
  fetchImpl: (async (_url: any, init?: any) => {
    fetched += 1
    const parsed = JSON.parse(String(init?.body || '{}'))
    assert(parsed.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length === 2, 'mock fetch body')
    return { ok: true, status: 200 } as Response
  }) as typeof fetch
})
assert(pushResult.ok && pushResult.spanCount === 2 && fetched === 1, 'otlp push mock ok')
// Fan-out: Tempo + Langfuse
fetched = 0
process.env.MANAGER_LANGFUSE_OTLP_ENDPOINT = 'http://langfuse.test/api/public/otel/v1/traces'
process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
process.env.LANGFUSE_SECRET_KEY = 'sk-test'
const fanout = await pushOtlpTraces(traces, {
  fetchImpl: (async (url: any, init?: any) => {
    fetched += 1
    const u = String(url || '')
    if (u.includes('langfuse')) {
      const auth = String((init?.headers as any)?.Authorization || '')
      assert(auth.startsWith('Basic '), 'langfuse basic auth')
    }
    return { ok: true, status: 200 } as Response
  }) as typeof fetch
})
assert(fanout.ok && fetched === 2 && (fanout.endpoints?.length || 0) === 2, 'otlp fan-out tempo+langfuse')
process.env.MANAGER_OTLP_PUSH = '0'
assert(!isManagerOtlpPushEnabled(), 'otlp push off when PUSH=0')
delete process.env.MANAGER_OTLP_PUSH
delete process.env.MANAGER_OTLP_ENDPOINT
delete process.env.MANAGER_LANGFUSE_OTLP_ENDPOINT
delete process.env.LANGFUSE_PUBLIC_KEY
delete process.env.LANGFUSE_SECRET_KEY

console.log('smoke-batch-b: ok')
