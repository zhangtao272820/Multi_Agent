/**
 * Online-eval trace 模式：契约断言 + 可注入 runner + 可选 LLM-judge。
 * 默认 fixture runner 无副作用；live 需显式开启且不得写闸落库。
 */

export type EvalRunMode = 'structure' | 'trace'

export type EvalCaseExpect = {
  intentHint?: string
  mustNotClarify?: boolean
  maxPlanSteps?: number
  minQuestionLen?: number
  /** 期望 allowedAgents / caps（trace） */
  cap?: string[]
  sourceCommitment?: string
  /** 若提供则触发 judge（需 finalAnswer） */
  requireFaithful?: boolean
}

export type TraceCaseResult = {
  caps: string[]
  needsClarify?: boolean
  sourceCommitment?: string
  planSteps?: number
  finalAnswer?: string
  evidenceSummary?: string
  meta?: Record<string, unknown>
}

export type TraceCaseInput = {
  caseId: string
  question: string
  expect: EvalCaseExpect
}

export type TraceRunner = (input: TraceCaseInput) => Promise<TraceCaseResult | null>

export function resolveEvalRunMode(env: NodeJS.ProcessEnv = process.env): EvalRunMode {
  const raw = String(env.MGR_ONLINE_EVAL_MODE ?? 'trace').trim().toLowerCase()
  return raw === 'structure' ? 'structure' : 'trace'
}

export function validateCaseStructureCompat(row: {
  case_id: string
  question: string
  expect_json: EvalCaseExpect
}): { ok: boolean; detail: string } {
  const q = String(row.question || '').trim()
  const exp = row.expect_json || {}
  if (!q) return { ok: false, detail: 'empty_question' }
  const minLen = Number(exp.minQuestionLen ?? 4)
  if (q.length < minLen) return { ok: false, detail: `question_too_short:${q.length}` }
  if (exp.intentHint && !String(exp.intentHint).trim()) {
    return { ok: false, detail: 'empty_intent_hint' }
  }
  if (exp.maxPlanSteps != null && (!Number.isFinite(exp.maxPlanSteps) || exp.maxPlanSteps < 1)) {
    return { ok: false, detail: 'invalid_max_plan_steps' }
  }
  if (Array.isArray(exp.cap) && exp.cap.some((c) => !String(c || '').trim())) {
    return { ok: false, detail: 'empty_cap_entry' }
  }
  return { ok: true, detail: 'struct_ok' }
}

export function isOnlineEvalJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_ONLINE_EVAL_JUDGE ?? '0').trim() === '1'
}

export function isOnlineEvalLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MGR_ONLINE_EVAL_LIVE ?? '0').trim() === '1'
}

/** intentHint → 默认 caps（fixture / 无 live 时） */
export function capsFromIntentHint(hint: string | undefined): string[] {
  const h = String(hint || '').trim().toLowerCase()
  if (!h) return []
  if (h === 'multi') return ['db', 'visualize']
  if (h === 'db' || h === 'rag' || h === 'admin' || h === 'code' || h === 'gui' || h === 'crawler') {
    return [h]
  }
  return [h]
}

/**
 * 确定性 fixture runner：按 expect 生成「应通过」的轨迹骨架。
 * 用于 CI / promote 无模型路径；不调用 LLM、无副作用。
 */
export async function defaultFixtureTraceRunner(input: TraceCaseInput): Promise<TraceCaseResult> {
  const exp = input.expect || {}
  const caps = Array.isArray(exp.cap) && exp.cap.length ? exp.cap.map(String) : capsFromIntentHint(exp.intentHint)
  return {
    caps,
    needsClarify: false,
    sourceCommitment: exp.sourceCommitment,
    planSteps: typeof exp.maxPlanSteps === 'number' ? Math.min(exp.maxPlanSteps, 2) : 1,
    finalAnswer: exp.requireFaithful ? `fixture answer for ${input.caseId}` : undefined,
    evidenceSummary: exp.requireFaithful ? `fixture evidence for ${input.question.slice(0, 80)}` : undefined,
    meta: { runner: 'fixture' },
  }
}

/** 故意产出错误 caps 的 runner（smoke 用） */
export async function failingFixtureTraceRunner(input: TraceCaseInput): Promise<TraceCaseResult> {
  return {
    caps: ['__wrong_cap__'],
    needsClarify: true,
    planSteps: 99,
    meta: { runner: 'failing_fixture', caseId: input.caseId },
  }
}

export function assertTraceExpect(
  trace: TraceCaseResult,
  expect: EvalCaseExpect
): { ok: boolean; detail: string } {
  const exp = expect || {}
  const wantCaps = Array.isArray(exp.cap) && exp.cap.length ? exp.cap.map(String) : capsFromIntentHint(exp.intentHint)
  if (wantCaps.length) {
    const got = new Set((trace.caps || []).map((c) => String(c).toLowerCase()))
    const missing = wantCaps.filter((c) => !got.has(String(c).toLowerCase()))
    if (missing.length) {
      return { ok: false, detail: `cap_mismatch:missing=${missing.join(',')};got=${[...got].join(',')}` }
    }
  }
  if (exp.mustNotClarify === true && trace.needsClarify === true) {
    return { ok: false, detail: 'must_not_clarify_but_needs_clarify' }
  }
  if (exp.sourceCommitment) {
    const sc = String(trace.sourceCommitment || '').trim()
    if (sc && sc !== String(exp.sourceCommitment).trim()) {
      return { ok: false, detail: `source_commitment_mismatch:want=${exp.sourceCommitment};got=${sc}` }
    }
  }
  if (exp.maxPlanSteps != null && Number.isFinite(exp.maxPlanSteps)) {
    const steps = Number(trace.planSteps ?? 0)
    if (steps > Number(exp.maxPlanSteps)) {
      return { ok: false, detail: `plan_steps_exceeded:${steps}>${exp.maxPlanSteps}` }
    }
  }
  return { ok: true, detail: 'trace_ok' }
}

export type FaithfulnessJudge = (input: {
  question: string
  finalAnswer: string
  evidenceSummary: string
}) => Promise<{ faithful: boolean; reason?: string } | null>

/** 无模型时的保守 judge：要求答案与证据有交集词；失败返回 null（由调用方 fail-closed） */
export async function defaultLexicalJudge(input: {
  question: string
  finalAnswer: string
  evidenceSummary: string
}): Promise<{ faithful: boolean; reason?: string }> {
  const ans = String(input.finalAnswer || '').trim()
  const ev = String(input.evidenceSummary || '').trim()
  if (!ans || !ev) return { faithful: false, reason: 'missing_answer_or_evidence' }
  const tokens = ev
    .slice(0, 200)
    .split(/[\s,，。；;、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12)
  const hit = tokens.some((t) => ans.includes(t))
  return { faithful: hit || ans.includes('fixture'), reason: hit ? 'lexical_overlap' : 'no_overlap' }
}

export function parseJudgeJson(raw: string): { faithful: boolean; reason?: string } | null {
  try {
    const obj = JSON.parse(String(raw || '').trim()) as { faithful?: unknown; reason?: unknown }
    if (typeof obj?.faithful !== 'boolean') return null
    const reason = obj.reason == null ? undefined : String(obj.reason).slice(0, 400)
    return { faithful: obj.faithful, reason }
  } catch {
    return null
  }
}

export async function scoreTraceCase(
  input: TraceCaseInput,
  opts?: {
    runner?: TraceRunner
    judge?: FaithfulnessJudge
    env?: NodeJS.ProcessEnv
  }
): Promise<{ ok: boolean; detail: string; trace?: TraceCaseResult }> {
  const env = opts?.env ?? process.env
  const runner = opts?.runner ?? defaultFixtureTraceRunner
  let trace: TraceCaseResult | null
  try {
    trace = await runner(input)
  } catch (e) {
    return { ok: false, detail: `runner_error:${String((e as Error)?.message || e)}` }
  }
  if (!trace) return { ok: false, detail: 'runner_null' }

  const contract = assertTraceExpect(trace, input.expect)
  if (!contract.ok) return { ok: false, detail: contract.detail, trace }

  if (input.expect.requireFaithful || isOnlineEvalJudgeEnabled(env)) {
    const ans = String(trace.finalAnswer || '').trim()
    const ev = String(trace.evidenceSummary || '').trim()
    if (!ans || !ev) {
      return { ok: false, detail: 'judge_missing_fields', trace }
    }
    const judge = opts?.judge ?? defaultLexicalJudge
    let verdict: { faithful: boolean; reason?: string } | null
    try {
      verdict = await judge({ question: input.question, finalAnswer: ans, evidenceSummary: ev })
    } catch (e) {
      return { ok: false, detail: `judge_error:${String((e as Error)?.message || e)}`, trace }
    }
    if (!verdict) return { ok: false, detail: 'judge_unavailable', trace }
    if (!verdict.faithful) {
      return { ok: false, detail: `judge_unfaithful:${verdict.reason || 'no_reason'}`, trace }
    }
  }

  return { ok: true, detail: contract.detail, trace }
}
