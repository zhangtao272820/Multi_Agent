/**
 * W1：online-eval trace 模式 — fixture 通过 / 注入失败 runner 拒绝 / judge fail-closed
 */
import {
  assertTraceExpect,
  capsFromIntentHint,
  defaultFixtureTraceRunner,
  defaultLexicalJudge,
  failingFixtureTraceRunner,
  parseJudgeJson,
  resolveEvalRunMode,
  scoreTraceCase,
} from '../../../agent-repo-shared/onlineEvalTrace'
import {
  evalGateForPromote,
  runEvalSuite,
  setOnlineEvalTraceRunnerForTests,
  validateCaseStructure,
} from '../../../agent-repo-shared/onlineEvalStore'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke-online-eval-trace] ${msg}`)
}

async function main() {
  console.log('smoke-online-eval-trace: start')

  assert(resolveEvalRunMode({ MGR_ONLINE_EVAL_MODE: 'trace' } as NodeJS.ProcessEnv) === 'trace', 'default mode trace')
  assert(resolveEvalRunMode({ MGR_ONLINE_EVAL_MODE: 'structure' } as NodeJS.ProcessEnv) === 'structure', 'structure mode')
  assert(capsFromIntentHint('db').includes('db'), 'caps from hint')
  assert(capsFromIntentHint('multi').includes('visualize'), 'multi caps')

  const struct = validateCaseStructure({
    case_id: 't1',
    question: '查一下张三用药记录',
    expect_json: { intentHint: 'db', mustNotClarify: true },
  })
  assert(struct.ok, 'structure ok')

  const pass = await scoreTraceCase(
    { caseId: 't1', question: '查一下张三用药记录', expect: { intentHint: 'db', mustNotClarify: true } },
    { runner: defaultFixtureTraceRunner }
  )
  assert(pass.ok, `fixture pass: ${pass.detail}`)

  const fail = await scoreTraceCase(
    { caseId: 't2', question: '查一下张三用药记录', expect: { intentHint: 'db', mustNotClarify: true } },
    { runner: failingFixtureTraceRunner }
  )
  assert(!fail.ok, 'failing runner must fail')
  assert(String(fail.detail).includes('cap_mismatch') || String(fail.detail).includes('must_not_clarify'), `detail=${fail.detail}`)

  const badJudge = parseJudgeJson('{"faithful":false,"reason":"x"}')
  assert(badJudge && badJudge.faithful === false, 'parse judge')
  assert(parseJudgeJson('not-json') === null, 'bad judge json')

  const lex = await defaultLexicalJudge({
    question: 'q',
    finalAnswer: 'fixture answer with 探视',
    evidenceSummary: '探视 制度',
  })
  assert(lex.faithful, 'lexical judge')

  const judgeFail = await scoreTraceCase(
    {
      caseId: 'j1',
      question: '制度',
      expect: { intentHint: 'rag', requireFaithful: true },
    },
    {
      runner: async () => ({
        caps: ['rag'],
        needsClarify: false,
        finalAnswer: '完全无关内容',
        evidenceSummary: '护理员配比标准',
      }),
      judge: async () => ({ faithful: false, reason: 'no_overlap' }),
    }
  )
  assert(!judgeFail.ok && String(judgeFail.detail).includes('judge_unfaithful'), 'judge fail-closed')

  const contract = assertTraceExpect(
    { caps: ['db'], needsClarify: false, planSteps: 1 },
    { intentHint: 'db', maxPlanSteps: 2, mustNotClarify: true }
  )
  assert(contract.ok, 'assertTraceExpect')

  // 无 PG：文件 suite + fixture
  setOnlineEvalTraceRunnerForTests(null)
  const prevMode = process.env.MGR_ONLINE_EVAL_MODE
  process.env.MGR_ONLINE_EVAL_MODE = 'trace'
  process.env.MGR_ONLINE_EVAL = '1'
  const summary = await runEvalSuite(
    'manager_golden_smoke',
    {
      trigger: 'smoke',
      runMode: 'trace',
      cases: [
        {
          case_id: 'route-db-anchor',
          question: '查一下张三上个月在院的用药记录',
          expect_json: { intentHint: 'db', mustNotClarify: false },
        },
        {
          case_id: 'route-rag-doc',
          question: '根据知识库说明一下我们机构的探视制度',
          expect_json: { intentHint: 'rag' },
        },
      ],
    },
    process.env
  )
  assert(summary?.ok === true, `suite fixture pass got ${JSON.stringify(summary)}`)
  assert(summary?.runMode === 'trace', 'runMode trace')

  setOnlineEvalTraceRunnerForTests(failingFixtureTraceRunner)
  const badSummary = await runEvalSuite(
    'manager_golden_smoke',
    {
      trigger: 'smoke_fail',
      runMode: 'trace',
      cases: [
        {
          case_id: 'route-db-anchor',
          question: '查一下张三上个月在院的用药记录',
          expect_json: { intentHint: 'db', mustNotClarify: true },
        },
      ],
    },
    process.env
  )
  assert(badSummary?.ok === false, 'injected failing runner fails suite')
  setOnlineEvalTraceRunnerForTests(null)

  // promote gate：失败 suite → 拒绝（无 PG 时仍跑 cases）
  setOnlineEvalTraceRunnerForTests(failingFixtureTraceRunner)
  process.env.EVO_ONLINE_EVAL_GATE = '1'
  // 清空 PG 配置强迫走文件/注入路径
  const prevUrl = process.env.AGENT_PG_URL || process.env.DATABASE_URL
  delete process.env.AGENT_PG_URL
  delete process.env.DATABASE_URL
  // evalGate 对 manager 会 seed；无 PG 时 runEvalSuite 读 golden 文件 — 用注入 runner 使失败
  // 但 golden 文件路径存在时会跑全部 cases；注入 runner 会使全部失败
  const gate = await evalGateForPromote('manager', process.env)
  assert(gate.ok === false, `promote gate must reject bad trace: ${gate.gate} ${gate.reason}`)
  setOnlineEvalTraceRunnerForTests(null)

  // 恢复后 structure 模式仍可通过
  process.env.MGR_ONLINE_EVAL_MODE = 'structure'
  const gateStruct = await evalGateForPromote('manager', {
    ...process.env,
    MGR_ONLINE_EVAL_MODE: 'structure',
    EVO_ONLINE_EVAL_GATE: '1',
  })
  assert(gateStruct.ok === true || gateStruct.gate === 'no_eval_cases_skip', `structure gate: ${gateStruct.gate}`)

  if (prevMode === undefined) delete process.env.MGR_ONLINE_EVAL_MODE
  else process.env.MGR_ONLINE_EVAL_MODE = prevMode
  if (prevUrl) process.env.DATABASE_URL = prevUrl

  console.log('smoke-online-eval-trace: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
