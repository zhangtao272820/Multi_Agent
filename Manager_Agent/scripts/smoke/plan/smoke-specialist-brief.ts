/**
 * Specialist Brief / Field Guide / Race 闸门契约（不调 LLM）。
 */
import {
  buildSpecialistBrief,
  clampSpecialistBriefBudget,
  fieldGuideMaxChars,
  isManagerRaceEnabled,
  parseSpecialistBrief,
  shouldAttachSpecialistBrief,
  specialistBriefMaxToolRounds
} from '../../../agent-repo-shared/specialistBrief'
import { buildFieldGuideDigest } from '../../../server/graph/core/plan/fieldGuide'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-specialist-brief] ${msg}`)
}

console.log('smoke-specialist-brief: start')

{
  const b = buildSpecialistBrief({
    goal: '查库并写信',
    acceptance: ['有行或明确空结果', '写信须 HITL'],
    budget: { max_tool_rounds: 99 }
  })
  assert(b, 'brief built')
  assert(b!.budget.max_tool_rounds <= 4, 'tool rounds hard cap')
  assert(b!.acceptance.length >= 1, 'acceptance')
}

{
  const b = clampSpecialistBriefBudget({ max_tool_rounds: 0 })
  assert(b.max_tool_rounds === specialistBriefMaxToolRounds(), 'invalid rounds → default')
}

{
  assert(shouldAttachSpecialistBrief({ managerOrchestrated: false, stepCount: 5 }) === false, 'no orch')
  assert(shouldAttachSpecialistBrief({ managerOrchestrated: true, executionTopology: 'solo', stepCount: 1 }) === false, 'solo single')
  assert(shouldAttachSpecialistBrief({ managerOrchestrated: true, executionTopology: 'hub', stepCount: 1 }) === true, 'hub')
  assert(shouldAttachSpecialistBrief({ managerOrchestrated: true, stepCount: 2 }) === true, 'multi steps')
}

{
  assert(isManagerRaceEnabled({ MANAGER_RACE_ENABLED: '0' } as NodeJS.ProcessEnv) === false, 'race default off')
  assert(isManagerRaceEnabled({ MANAGER_RACE_ENABLED: '1' } as NodeJS.ProcessEnv) === true, 'race opt-in')
}

{
  const dig = buildFieldGuideDigest({
    userGoal: '对比两院数据并邮件老板',
    taskBoard: [
      { id: '1', agent: 'db', query: '查院A', status: 'success' },
      { id: '2', agent: 'admin', query: '发信', status: 'pending' }
    ],
    failedNotes: ['rag empty_evidence'],
    maxChars: 400
  })
  assert(dig.includes('FieldGuide'), 'guide header')
  assert(dig.includes('失败保留'), 'keep failures')
  assert(dig.length <= 400, 'char budget')
  assert(fieldGuideMaxChars({ MANAGER_FIELD_GUIDE_MAX_CHARS: '800' } as NodeJS.ProcessEnv) === 800, 'env chars')
}

{
  const digMm = buildFieldGuideDigest({
    userGoal: '识图对照规范',
    multimodalStructured: {
      entities: [{ name: '张三', kind: 'person' }],
      metrics: [{ name: '收缩压', value: '138', unit: 'mmHg' }],
      ocr_text_digest: '收缩压138'
    },
    maxChars: 500
  })
  assert(digMm.includes('已决'), 'mm field guide facts header')
  assert(digMm.includes('张三') || digMm.includes('收缩压'), 'mm field guide content')
}

{
  const parsed = parseSpecialistBrief({
    version: '1',
    goal: 'x',
    acceptance: ['y'],
    budget: { max_tool_rounds: 2 }
  })
  assert(parsed?.goal === 'x', 'parse')
  assert(parseSpecialistBrief({ version: '9', goal: 'x' }) === null, 'bad version')
}

console.log('smoke-specialist-brief: ok')
