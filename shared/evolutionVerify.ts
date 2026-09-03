/**
 * 进化 promote 前黄金集/结构回放门禁（Phase 3 ④ Verify）
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolveEvolutionEnvBool } from './agentEvolutionMode'

export type EvolutionVerifyResult = {
  ok: boolean
  agent: string
  gate: string
  reason?: string
  checks: Array<{ id: string; ok: boolean; detail?: string }>
}

export function isEvolutionVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEvolutionEnvBool('EVO_VERIFY_BEFORE_PROMOTE', true, env)
}

function repoAgentDir(name: 'DB_Agent' | 'RAG_Agent' | 'Manager_Agent' | 'AI_admin_Agent' | 'code_assistent_Agent' | 'Extractor_Agent'): string {
  const cwd = process.cwd()
  if (path.basename(cwd) === name) return cwd
  const inRepo = path.join(cwd, name)
  if (existsSync(path.join(inRepo, 'package.json')) || existsSync(path.join(inRepo, 'nuxt.config.ts'))) {
    return inRepo
  }
  return path.resolve(cwd, '..', name)
}

/** DB：metrics 结构回归（smoke-metrics 同等断言） */
export async function verifyDbEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const checks: EvolutionVerifyResult['checks'] = []
  const dbRoot = repoAgentDir('DB_Agent')
  const prevCwd = process.cwd()
  try {
    process.chdir(dbRoot)
    process.env.ENABLE_METRICS_DIRECT = '1'
    const metricsMod = await import(pathToFileURL(path.join(dbRoot, 'utils', 'metrics_compiler.ts')).href)
    const domainMod = await import(pathToFileURL(path.join(dbRoot, 'utils', 'domain_patch.ts')).href)
    const { resolveMetricPatch } = metricsMod as typeof import('../DB_Agent/utils/metrics_compiler')
    const { invalidateDomainPatchCache } = domainMod as typeof import('../DB_Agent/utils/domain_patch')

    process.env.DB_AGENT_DOMAIN = 'generic'
    invalidateDomainPatchCache()
    const genericTable = resolveMetricPatch('当前数据库有多少张表', { intent: 'aggregation' })
    checks.push({
      id: 'generic_schema_table_count',
      ok: genericTable?.id === 'schema_table_count',
      detail: String(genericTable?.id || 'missing')
    })

    process.env.DB_AGENT_DOMAIN = 'p2026'
    invalidateDomainPatchCache()
    const personTotal = resolveMetricPatch('老人一共有多少人', { intent: 'aggregation' })
    checks.push({
      id: 'p2026_person_total_count',
      ok: personTotal?.id === 'person_total_count',
      detail: String(personTotal?.id || 'missing')
    })

    const footTrend = resolveMetricPatch('足压检测按月趋势', { intent: 'trend' })
    checks.push({
      id: 'p2026_foot_trend',
      ok: footTrend?.id === 'foot_pressure_monthly_trend',
      detail: String(footTrend?.id || 'missing')
    })
  } catch (e) {
    checks.push({ id: 'db_metrics_exception', ok: false, detail: String((e as Error)?.message || e) })
  } finally {
    process.chdir(prevCwd)
  }

  checks.push({
    id: 'auto_curate_default_off',
    ok:
      String(process.env.ENABLE_AUTO_CURATE_ON_QUERY ?? '0').trim() !== '1' ||
      String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1',
    detail: 'curate≠auto-promote',
  })

  const ok = checks.every((c) => c.ok)
  return { ok, agent: 'db', gate: 'smoke_metrics', reason: ok ? undefined : 'metrics_regression', checks }
}

/** Manager：golden-smoke + 路由矩阵拓扑 + 编排流水线结构门禁 */
export async function verifyManagerEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const checks: EvolutionVerifyResult['checks'] = []
  try {
    const fs = await import('node:fs/promises')
    const mgrRoot = repoAgentDir('Manager_Agent')
    const raw = await fs.readFile(path.join(mgrRoot, 'eval', 'golden-smoke.json'), 'utf8')
    const obj = JSON.parse(raw) as { cases?: unknown[] }
    const cases = Array.isArray(obj?.cases) ? obj.cases : []
    checks.push({ id: 'golden_smoke_cases', ok: cases.length >= 1, detail: `count=${cases.length}` })

    const morphPath = path.join(mgrRoot, 'eval', 'golden-enterprise-morphology.json')
    const morphRaw = await fs.readFile(morphPath, 'utf8')
    const morphObj = JSON.parse(morphRaw) as { cases?: Array<{ id?: string; morphology?: string; expectClarify?: boolean; expectCap?: string[]; expectTenantScope?: boolean }> }
    const morphCases = Array.isArray(morphObj?.cases) ? morphObj.cases : []
    checks.push({
      id: 'golden_enterprise_morphology_cases',
      ok: morphCases.length >= 8,
      detail: `count=${morphCases.length}`
    })
    const morphs = new Set(morphCases.map((c) => String(c.morphology || '')))
    for (const m of ['continuation', 'admin', 'hybrid', 'ambiguous', 'tenant_boundary']) {
      checks.push({ id: `morphology_${m}`, ok: morphs.has(m), detail: m })
    }
    const tenantCases = morphCases.filter((c) => c.expectTenantScope === true)
    checks.push({
      id: 'morphology_tenant_boundary',
      ok: tenantCases.length >= 2,
      detail: `tenant_cases=${tenantCases.length}`
    })
    for (const c of morphCases.slice(0, 12)) {
      const id = String(c.id || '')
      const ok =
        c.expectClarify === true
          ? true
          : Array.isArray(c.expectCap) && c.expectCap.length > 0
      checks.push({ id: `morph_case_${id || 'unknown'}`, ok, detail: c.morphology })
    }
    for (const c of cases.slice(0, 8)) {
      const row = c as { id?: string; user?: string; expect?: { intentHint?: string } }
      const id = String(row.id || '')
      checks.push({
        id: `case_${id || 'unknown'}`,
        ok: Boolean(String(row.user || '').trim() && row.expect?.intentHint),
        detail: row.expect?.intentHint
      })
    }
  } catch (e) {
    checks.push({ id: 'manager_golden_exception', ok: false, detail: String((e as Error)?.message || e) })
  }

  try {
    const mgrRoot = repoAgentDir('Manager_Agent')
    const st = await (await import('node:fs/promises')).stat(
      path.join(mgrRoot, 'server', 'utils', 'skills', 'skillDiscoverIndex.ts')
    ).catch(() => null)
    checks.push({ id: 'skill_discover_index', ok: Boolean(st?.isFile()), detail: 'learned skill recall SSOT' })
    checks.push({
      id: 'expert_auto_promote_default_off',
      ok: String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1',
    })
  } catch (e) {
    checks.push({ id: 'manager_skill_gate_exception', ok: false, detail: String((e as Error)?.message || e) })
  }

  if (isManagerRouteMatrixGateEnabled()) {
    try {
      const mgrRoot = repoAgentDir('Manager_Agent')
      const casesMod = await import(
        pathToFileURL(path.join(mgrRoot, 'scripts', 'smoke', 'route', 'route-matrix-cases.ts')).href
      )
      const verifyMod = await import(
        pathToFileURL(path.join(mgrRoot, 'server', 'utils', 'route', 'managerRouteMatrixVerify.ts')).href
      )
      const matrixCases = (casesMod as { ROUTE_MATRIX_CASES?: unknown[] }).ROUTE_MATRIX_CASES ?? []
      const topology = (
        verifyMod as {
          verifyRouteMatrixTopologyCases: (
            c: Array<{ id: string; userTask: string; expectCap: string[]; expectPlanAgents: string[] }>
          ) => Array<{ id: string; ok: boolean; detail?: string }>
        }
      ).verifyRouteMatrixTopologyCases(
        matrixCases as Array<{ id: string; userTask: string; expectCap: string[]; expectPlanAgents: string[] }>
      )
      for (const t of topology) {
        checks.push({ id: `matrix_${t.id}`, ok: t.ok, detail: t.detail })
      }
      const pipeline = (
        verifyMod as {
          verifyOrchestratorPipelineStructure: () => Array<{ id: string; ok: boolean; detail?: string }>
        }
      ).verifyOrchestratorPipelineStructure()
      for (const p of pipeline) {
        checks.push({ id: `pipeline_${p.id}`, ok: p.ok, detail: p.detail })
      }
    } catch (e) {
      checks.push({
        id: 'route_matrix_gate_exception',
        ok: false,
        detail: String((e as Error)?.message || e)
      })
    }
  }

  const ok = checks.every((c) => c.ok)
  return {
    ok,
    agent: 'manager',
    gate: isManagerRouteMatrixGateEnabled() ? 'golden_smoke+route_matrix' : 'golden_smoke',
    reason: ok ? undefined : 'manager_evolution_gate_failed',
    checks
  }
}

export function isManagerRouteMatrixGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.EVO_ROUTE_MATRIX_GATE
  if (raw !== undefined && String(raw).trim() !== '') {
    return String(raw).trim() !== '0'
  }
  const m = String(env.MANAGER_EVOLUTION_MODE ?? '').trim().toLowerCase()
  if (m === 'off' || m === '0' || m === 'false') return false
  if (m === 'convergence' || m === 'learning' || m === 'stable' || m === 'default') return true
  return true
}

/** RAG：HTML/PPTX 解析结构 smoke */
export async function verifyRagEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const checks: EvolutionVerifyResult['checks'] = []
  try {
    const ragRoot = repoAgentDir('RAG_Agent')
    const htmlMod = await import(pathToFileURL(path.join(ragRoot, 'server', 'utils', 'html_text.ts')).href)
    const { stripHtmlToPlainText, looksLikeHtmlDocument } = htmlMod as typeof import('../RAG_Agent/server/utils/html_text')
    const sample = '<html><body><h1>探视制度</h1><p>14:00-16:00</p></body></html>'
    const plain = stripHtmlToPlainText(sample)
    checks.push({ id: 'html_strip', ok: plain.includes('探视制度') && !plain.includes('<p>') })
    const buf = Buffer.from(sample, 'utf-8')
    checks.push({ id: 'html_sniff', ok: looksLikeHtmlDocument(buf, 'policy.html') })
    checks.push({
      id: 'auto_curate_default_off',
      ok: String(process.env.RAG_AUTO_CURATE_ON_FEEDBACK ?? '0').trim() !== '1'
        || String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1',
      detail: 'curate≠auto-promote',
    })
    checks.push({
      id: 'ab_auto_promote_default_off',
      ok: String(process.env.RAG_AB_AUTO_PROMOTE ?? '0').trim() !== '1'
        || String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1',
    })
  } catch (e) {
    checks.push({ id: 'rag_smoke_exception', ok: false, detail: String((e as Error)?.message || e) })
  }
  const ok = checks.every((c) => c.ok)
  return { ok, agent: 'rag', gate: 'retrieval_smoke', reason: ok ? undefined : 'rag_smoke_failed', checks }
}

/** Admin：办公 golden batch 结构存在性 */
export async function verifyAdminEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const checks: EvolutionVerifyResult['checks'] = []
  try {
    const fs = await import('node:fs/promises')
    const adminRoot = path.join(repoAgentDir('AI_admin_Agent'), 'backend', 'scripts')
    for (const name of ['smoke_batch0.py', 'smoke_batch1.py', 'smoke_batch2.py']) {
      const p = path.join(adminRoot, name)
      const st = await fs.stat(p).catch(() => null)
      checks.push({ id: name, ok: Boolean(st?.isFile()) })
    }
    checks.push({
      id: 'admin_auto_curate_default_off',
      ok: String(process.env.ADMIN_AUTO_CURATE ?? '0').trim() !== '1'
        || String(process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() !== '1',
    })
  } catch (e) {
    checks.push({ id: 'admin_golden_exception', ok: false, detail: String((e as Error)?.message || e) })
  }
  const ok = checks.every((c) => c.ok)
  return { ok, agent: 'admin', gate: 'office_golden', reason: ok ? undefined : 'admin_golden_missing', checks }
}

/** Code：关键模块结构存在性 */
export async function verifyCodeEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const checks: EvolutionVerifyResult['checks'] = []
  try {
    const codeRoot = repoAgentDir('code_assistent_Agent')
    const fs = await import('node:fs/promises')
    for (const rel of ['server/utils/code_prompt_evolution.ts', 'server/utils/code_agent_env.ts']) {
      const st = await fs.stat(path.join(codeRoot, rel)).catch(() => null)
      checks.push({ id: rel, ok: Boolean(st?.isFile()) })
    }
  } catch (e) {
    checks.push({ id: 'code_smoke_exception', ok: false, detail: String((e as Error)?.message || e) })
  }
  const ok = checks.every((c) => c.ok)
  return { ok, agent: 'code', gate: 'code_structure', reason: ok ? undefined : 'code_smoke_failed', checks }
}

/** Extractor：关键模块结构存在性 */
export async function verifyExtractorEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const checks: EvolutionVerifyResult['checks'] = []
  try {
    const extRoot = repoAgentDir('Extractor_Agent')
    const fs = await import('node:fs/promises')
    for (const rel of ['server/utils/prompt_evolution.ts', 'server/utils/crawl_run.ts']) {
      const st = await fs.stat(path.join(extRoot, rel)).catch(() => null)
      checks.push({ id: rel, ok: Boolean(st?.isFile()) })
    }
  } catch (e) {
    checks.push({ id: 'extractor_smoke_exception', ok: false, detail: String((e as Error)?.message || e) })
  }
  const ok = checks.every((c) => c.ok)
  return { ok, agent: 'extractor', gate: 'extractor_structure', reason: ok ? undefined : 'extractor_smoke_failed', checks }
}

/** Lobster：playbook shadow 结构门禁（实现见 evolutionVerifyLobster，避免循环/重依赖） */
export async function verifyLobsterEvolutionPromote(): Promise<EvolutionVerifyResult> {
  const { verifyLobsterEvolutionPromote: run } = await import('./evolutionVerifyLobster')
  const r = await run()
  return { ok: r.ok, agent: r.agent, gate: r.gate, reason: r.reason, checks: r.checks }
}

export async function verifyBeforePromote(
  agent: 'db' | 'manager' | 'rag' | 'admin' | 'code' | 'extractor' | 'lobster',
  env: NodeJS.ProcessEnv = process.env
): Promise<EvolutionVerifyResult & { evalGate?: { ok: boolean; gate: string; reason?: string } }> {
  if (!isEvolutionVerifyEnabled(env)) {
    return { ok: true, agent, gate: 'disabled', checks: [{ id: 'verify_disabled', ok: true }] }
  }

  let evalGate: { ok: boolean; gate: string; reason?: string } | undefined
  if (agent === 'manager' || agent === 'db' || agent === 'rag' || agent === 'admin') {
    const { evalGateForPromote, isOnlineEvalPromoteGateEnabled } = await import('./onlineEvalStore')
    if (isOnlineEvalPromoteGateEnabled(env)) {
      const eg = await evalGateForPromote(agent, env)
      evalGate = { ok: eg.ok, gate: eg.gate, reason: eg.reason }
      if (!eg.ok) {
        return {
          ok: false,
          agent,
          gate: 'online_eval',
          reason: eg.reason || 'online_eval_failed',
          checks: [{ id: 'online_eval_gate', ok: false, detail: eg.reason }],
          evalGate
        }
      }
    }
  }

  const base =
    agent === 'db'
      ? await verifyDbEvolutionPromote()
      : agent === 'manager'
        ? await verifyManagerEvolutionPromote()
        : agent === 'rag'
          ? await verifyRagEvolutionPromote()
          : agent === 'code'
            ? await verifyCodeEvolutionPromote()
            : agent === 'extractor'
              ? await verifyExtractorEvolutionPromote()
              : agent === 'lobster'
                ? await verifyLobsterEvolutionPromote()
                : await verifyAdminEvolutionPromote()

  return { ...base, evalGate }
}
