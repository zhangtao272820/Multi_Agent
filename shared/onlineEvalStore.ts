/**
 * P3：在线 Eval — PG 回归集 + 进化 promote 门禁
 * W5：structure | trace 双模式；promote 默认 trace（fixture，无副作用）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { agentPgQuery, isAgentPgConfigured } from './agentPgClient'
import {
  type EvalCaseExpect,
  type EvalRunMode,
  type TraceRunner,
  defaultFixtureTraceRunner,
  resolveEvalRunMode,
  scoreTraceCase,
  validateCaseStructureCompat,
} from './onlineEvalTrace'

export type { EvalCaseExpect, EvalRunMode } from './onlineEvalTrace'

export type EvalRunSummary = {
  runId: number
  suiteId: string
  passed: number
  failed: number
  ok: boolean
  runMode: EvalRunMode
  results: Array<{ caseId: string; ok: boolean; detail?: string }>
}

export function isOnlineEvalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_ONLINE_EVAL ?? '1').trim() !== '0'
}

export function isOnlineEvalPromoteGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.EVO_ONLINE_EVAL_GATE ?? '1').trim() !== '0'
}

export function onlineEvalCacheTtlSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EVO_ONLINE_EVAL_CACHE_TTL_SEC ?? 3600)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3600
}

function managerGoldenPath(): string {
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, 'eval', 'golden-smoke.json'),
    path.join(cwd, 'Manager_Agent', 'eval', 'golden-smoke.json'),
    path.resolve(cwd, '..', 'Manager_Agent', 'eval', 'golden-smoke.json')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return candidates[0]!
}

/** @deprecated use validateCaseStructure from onlineEvalTrace — kept for smoke imports */
export function validateCaseStructure(row: {
  case_id: string
  question: string
  expect_json: EvalCaseExpect
}): { ok: boolean; detail: string } {
  return validateCaseStructureCompat(row)
}

export async function seedManagerEvalSuiteFromGolden(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ seeded: boolean; cases: number }> {
  if (!isAgentPgConfigured(env)) return { seeded: false, cases: 0 }
  const suiteId = 'manager_golden_smoke'
  const fp = managerGoldenPath()
  let raw = ''
  try {
    raw = await fs.readFile(fp, 'utf8')
  } catch {
    return { seeded: false, cases: 0 }
  }
  const obj = JSON.parse(raw) as { cases?: Array<{ id?: string; user?: string; expect?: EvalCaseExpect }> }
  const cases = Array.isArray(obj.cases) ? obj.cases : []
  if (!cases.length) return { seeded: false, cases: 0 }

  await agentPgQuery(
    `INSERT INTO mgr_eval_suites (id, agent, title, enabled, source, updated_at)
     VALUES ($1, 'manager', $2, TRUE, 'golden-smoke.json', NOW())
     ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
    [suiteId, String(obj && 'description' in obj ? (obj as { description?: string }).description : '') || 'Manager golden smoke'],
    env
  )

  let n = 0
  for (const c of cases) {
    const caseId = String(c.id || '').trim()
    const question = String(c.user || '').trim()
    if (!caseId || !question) continue
    await agentPgQuery(
      `INSERT INTO mgr_eval_cases (suite_id, case_id, question, expect_json, enabled)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (suite_id, case_id) DO UPDATE SET
         question = EXCLUDED.question,
         expect_json = EXCLUDED.expect_json,
         enabled = TRUE`,
      [suiteId, caseId, question, JSON.stringify(c.expect || {})],
      env
    )
    n += 1
  }
  return { seeded: true, cases: n }
}

let _injectedTraceRunner: TraceRunner | null = null

/** 测试注入；生产勿用 */
export function setOnlineEvalTraceRunnerForTests(runner: TraceRunner | null) {
  _injectedTraceRunner = runner
}

export async function runEvalSuite(
  suiteId: string,
  opts?: { trigger?: string; runMode?: EvalRunMode; runner?: TraceRunner; cases?: Array<{ case_id: string; question: string; expect_json: EvalCaseExpect }> },
  env: NodeJS.ProcessEnv = process.env
): Promise<EvalRunSummary | null> {
  if (!isOnlineEvalEnabled(env)) return null
  const sid = String(suiteId || '').slice(0, 64)
  if (!sid) return null

  const runMode: EvalRunMode = opts?.runMode || resolveEvalRunMode(env)
  let cases = opts?.cases
  const usePg = isAgentPgConfigured(env) && !opts?.cases

  if (!cases) {
    if (!isAgentPgConfigured(env)) {
      // 无 PG：从 golden 文件读（smoke / CI）
      const fp = managerGoldenPath()
      try {
        const raw = await fs.readFile(fp, 'utf8')
        const obj = JSON.parse(raw) as { cases?: Array<{ id?: string; user?: string; expect?: EvalCaseExpect }> }
        cases = (obj.cases || [])
          .map((c) => ({
            case_id: String(c.id || '').trim(),
            question: String(c.user || '').trim(),
            expect_json: (c.expect || {}) as EvalCaseExpect,
          }))
          .filter((c) => c.case_id && c.question)
      } catch {
        return null
      }
    } else {
      const casesRes = await agentPgQuery<{
        case_id: string
        question: string
        expect_json: EvalCaseExpect
      }>(
        `SELECT case_id, question, expect_json FROM mgr_eval_cases
         WHERE suite_id = $1 AND enabled = TRUE ORDER BY id ASC`,
        [sid],
        env
      )
      cases = casesRes?.rows ?? []
    }
  }

  if (!cases?.length) return null

  let runId = 0
  if (usePg) {
    const runRes = await agentPgQuery<{ id: string }>(
      `INSERT INTO mgr_eval_runs (suite_id, trigger_source, status, passed, failed)
       VALUES ($1, $2, 'running', 0, 0) RETURNING id`,
      [sid, String(opts?.trigger || 'manual').slice(0, 32)],
      env
    )
    runId = Number(runRes?.rows?.[0]?.id) || 0
  } else {
    runId = Date.now() % 1_000_000_000
  }

  const results: EvalRunSummary['results'] = []
  let passed = 0
  let failed = 0
  const runner = opts?.runner || _injectedTraceRunner || defaultFixtureTraceRunner

  for (const row of cases) {
    const t0 = Date.now()
    const expectJson = (row.expect_json && typeof row.expect_json === 'object' ? row.expect_json : {}) as EvalCaseExpect
    let ok = false
    let detail = ''

    if (runMode === 'structure') {
      const v = validateCaseStructure({
        case_id: row.case_id,
        question: row.question,
        expect_json: expectJson,
      })
      ok = v.ok
      detail = v.detail
    } else {
      const struct = validateCaseStructure({
        case_id: row.case_id,
        question: row.question,
        expect_json: expectJson,
      })
      if (!struct.ok) {
        ok = false
        detail = struct.detail
      } else {
        const scored = await scoreTraceCase(
          { caseId: row.case_id, question: row.question, expect: expectJson },
          { runner, env }
        )
        ok = scored.ok
        detail = scored.detail
      }
    }

    const ms = Date.now() - t0
    if (ok) passed += 1
    else failed += 1
    results.push({ caseId: row.case_id, ok, detail })
    if (usePg && runId) {
      await agentPgQuery(
        `INSERT INTO mgr_eval_results (run_id, case_id, ok, detail, ms) VALUES ($1, $2, $3, $4, $5)`,
        [runId, row.case_id, ok, `${runMode}:${detail}`, ms],
        env
      )
    }
  }

  const ok = failed === 0
  if (usePg && runId) {
    await agentPgQuery(
      `UPDATE mgr_eval_runs SET status = $2, passed = $3, failed = $4, finished_at = NOW() WHERE id = $1`,
      [runId, ok ? 'passed' : 'failed', passed, failed],
      env
    )
  }

  return { runId, suiteId: sid, passed, failed, ok, runMode, results }
}

export async function getLatestEvalRun(
  suiteId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; passed: number; failed: number; runId: number; ageSec?: number } | null> {
  if (!isAgentPgConfigured(env)) return null
  const res = await agentPgQuery<{ id: string; status: string; passed: string; failed: string; started_at: string }>(
    `SELECT id, status, passed::text, failed::text, started_at::text FROM mgr_eval_runs
     WHERE suite_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [suiteId],
    env
  )
  const row = res?.rows?.[0]
  if (!row) return null
  const started = Date.parse(String(row.started_at || ''))
  const ageSec = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : undefined
  return {
    runId: Number(row.id),
    ok: row.status === 'passed',
    passed: Number(row.passed) || 0,
    failed: Number(row.failed) || 0,
    ageSec,
  }
}

/** 进化 promote 门禁：最近 eval 必须通过（无 PG 时跑文件 suite） */
export async function evalGateForPromote(
  agent: 'manager' | 'db' | 'rag' | 'admin',
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; gate: string; reason?: string; summary?: EvalRunSummary | null }> {
  if (!isOnlineEvalPromoteGateEnabled(env)) {
    return { ok: true, gate: 'eval_gate_disabled' }
  }

  const suiteByAgent: Record<string, string> = {
    manager: 'manager_golden_smoke',
    db: 'db_metrics_smoke',
    rag: 'rag_parse_smoke',
    admin: 'admin_batch_smoke'
  }
  const suiteId = suiteByAgent[agent]
  if (!suiteId) return { ok: true, gate: 'no_suite_for_agent' }

  // 非 manager：无专用 suite 时不阻塞（保持旧行为）
  if (agent !== 'manager') {
    if (!isAgentPgConfigured(env)) return { ok: true, gate: 'pg_not_configured_skip' }
    const latest = await getLatestEvalRun(suiteId, env)
    if (!latest) return { ok: true, gate: 'no_eval_cases_skip' }
    if (!latest.ok) return { ok: false, gate: 'online_eval_failed', reason: `failed=${latest.failed}` }
    return { ok: true, gate: 'online_eval_cached_pass' }
  }

  if (isAgentPgConfigured(env)) {
    await seedManagerEvalSuiteFromGolden(env).catch(() => undefined)
  }

  const ttl = onlineEvalCacheTtlSec(env)
  let latest = await getLatestEvalRun(suiteId, env)
  const cacheFresh = latest?.ok && (ttl === 0 || (latest.ageSec != null && latest.ageSec <= ttl))
  if (cacheFresh) {
    return { ok: true, gate: 'online_eval_cached_pass' }
  }

  const runMode = resolveEvalRunMode(env)
  const summary = await runEvalSuite(suiteId, { trigger: 'promote_gate', runMode }, env)
  if (!summary) {
    return { ok: true, gate: 'no_eval_cases_skip' }
  }
  if (!summary.ok) {
    return { ok: false, gate: 'online_eval_failed', reason: `mode=${summary.runMode};failed=${summary.failed}`, summary }
  }
  return { ok: true, gate: 'online_eval_passed', summary }
}
