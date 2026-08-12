/**
 * S3 联调预检：鉴权契约 + 配置脚枪 + 可选 live ready 探测。
 *
 * 用法：
 *   npm run smoke:preflight           # 配置必过；服务未起只 WARN
 *   npm run smoke:preflight -- --live # 核心服务未起则 exit 1
 *
 * 不读密钥明文到日志，只报 ok / missing / mismatch。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getManagerWsAuthConfigStatus } from '../../../server/graph/core/runtime/wsAuth'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const managerRoot = path.join(__dirname, '../../..')

function loadEnvFile(absPath: string) {
  if (!fs.existsSync(absPath)) return
  for (const line of fs.readFileSync(absPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!process.env[k]) process.env[k] = v
  }
}

loadEnvFile(path.join(managerRoot, '.env'))

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

type ProbeResult = { name: string; url: string; ok: boolean; detail: string }

async function probeReady(name: string, baseUrl: string): Promise<ProbeResult> {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return { name, url: '', ok: false, detail: 'url_empty' }

  const tryJson = async (path: string): Promise<ProbeResult | null> => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) return { name, url: base, ok: false, detail: `http_${res.status}` }
      const ct = String(res.headers.get('content-type') || '')
      if (ct.includes('text/html')) return null
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return null
      if (!('ok' in body) && !('ready' in body) && !('service' in body)) return null
      const ready = Boolean(body.ready ?? body.ok)
      return {
        name,
        url: base,
        ok: ready,
        detail: ready ? String(body.detail || body.service || path.replace(/^\//, '')) : String(body.detail || 'not_ready')
      }
    } catch {
      return null
    }
  }

  return (
    (await tryJson('/api/ready')) ||
    (await tryJson('/api/health')) ||
    (await tryJson('/health')) || { name, url: base, ok: false, detail: 'unreachable' }
  )
}

const live = process.argv.includes('--live')
const warnings: string[] = []

// ── 1) 鉴权配置契约（离线必过）──
const auth = getManagerWsAuthConfigStatus()
assert(auth.ok, `auth config broken: ${auth.detail}（AUTH_MODE=token 须配 MANAGER_WS_TOKEN）`)
console.log(`[preflight] auth: ${auth.detail}`)

const opsTok = Boolean(String(process.env.MANAGER_OPS_TOKEN || '').trim())
if (!opsTok) {
  warnings.push('MANAGER_OPS_TOKEN 未设 → POST /api/manager/ops 一律 403（联调运维面可忽略）')
} else {
  console.log('[preflight] ops token: set')
}

// ── 2) 配置脚枪：localhost 子 Agent + docker searxng 主机名 ──
const agentHttp = String(process.env.DB_AGENT_HTTP_URL || process.env.RAG_AGENT_HTTP_URL || '')
const searx = String(process.env.SEARXNG_BASE_URL || '').trim()
const runtime = String(process.env.MANAGER_RUNTIME || '').trim().toLowerCase()
const agentsLookLocal = /localhost|127\.0\.0\.1/.test(agentHttp)
const searxDockerOnly = /^https?:\/\/searxng(?::\d+)?(?:\/|$)/i.test(searx)

if (agentsLookLocal && searxDockerOnly) {
  warnings.push(
    `SEARXNG_BASE_URL=${searx} 仅在 compose 网内可解析；本机测请改 http://localhost:8088（或把 SearXNG 映射到宿主机）`
  )
}
if (agentsLookLocal && runtime === 'docker') {
  warnings.push(
    '子 Agent URL 已是 localhost，但 MANAGER_RUNTIME=docker；裸机联调建议 MANAGER_RUNTIME=local'
  )
}

for (const w of warnings) console.warn(`[preflight] WARN: ${w}`)

// Wave6：离线 registry / MCP inventory 形态（不要求服务已起）
{
  const { buildAgentRegistry } = await import('../../../server/graph/core/agent/agentRegistry')
  const reg = buildAgentRegistry(process.env)
  assert(reg.entries.some((e) => e.id === 'db'), 'registry has db')
  assert(reg.entries.some((e) => e.id === 'rag'), 'registry has rag')
  const mcpFaces = reg.entries.filter((e) => e.mcpUrl).map((e) => e.id)
  console.log(`[preflight] registry entries=${reg.entries.length} mcp_faces=${mcpFaces.join(',') || '(none configured)'}`)
}

// ── 3) Live ready（可选）──
const targets: Array<[string, string]> = [
  ['manager', process.env.MANAGER_HTTP_URL || 'http://localhost:13106'],
  ['db', process.env.DB_AGENT_HTTP_URL || 'http://localhost:13101'],
  ['rag', process.env.RAG_AGENT_HTTP_URL || 'http://localhost:13102'],
  ['code', process.env.CODE_AGENT_HTTP_URL || 'http://localhost:13103'],
  ['admin', process.env.AI_ADMIN_AGENT_HTTP_URL || 'http://localhost:13105'],
  ['extractor', process.env.CRAWLER_AGENT_HTTP_URL || 'http://localhost:13104'],
  ['lobster', process.env.LOBSTER_AGENT_HTTP_URL || 'http://localhost:13108']
]

const probes = await Promise.all(targets.map(([n, u]) => probeReady(n, u)))
const core = ['manager', 'db', 'rag'] as const
let coreDown = 0
for (const p of probes) {
  const mark = p.ok ? 'OK' : 'DOWN'
  console.log(`[preflight] ${mark} ${p.name} ${p.url || '(no url)'} · ${p.detail}`)
  if ((core as readonly string[]).includes(p.name) && !p.ok) coreDown += 1
}

if (live && coreDown > 0) {
  console.error(`[preflight] --live：核心服务未就绪 (${coreDown}/${core.length})，先起 Manager/DB/RAG 再测`)
  process.exit(1)
}

if (!live && coreDown > 0) {
  console.warn(
    `[preflight] 核心服务未起 ${coreDown}/${core.length}（正常：先 docker compose / npm run dev）。测前加 --live 强制拦截。`
  )
}

console.log('smoke-preflight: OK')
console.log(
  [
    '测前建议：',
    '1) 打开 http://localhost:13106 （AUTH_MODE=token 时 UI 须带 NUXT_PUBLIC_MANAGER_WS_TOKEN）',
    '2) 专业模式问：查知识库某制度要点（rag）',
    '3) 问：上季度销售并画柱状图（db→code→visualize）',
    '4) 日程/待办写操作应出现 HITL 确认'
  ].join('\n   ')
)
