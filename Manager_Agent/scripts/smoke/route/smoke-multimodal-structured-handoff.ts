/**
 * Wave M1：multimodal structured → softHandoff / Field Guide / 下游 query 改写（不调 LLM）。
 */
import {
  applyMultimodalHandoffToPendingSteps,
  enrichQueryWithMultimodalHandoff,
  formatMultimodalStructuredDigest,
  multimodalFactsForFieldGuide,
  normalizeMultimodalStructured
} from '../../../agent-repo-shared/multimodalStructuredHandoff'
import { buildSoftHandoffFromStep, formatDependencySoftHandoffs } from '../../../server/graph/core/routing/softHandoff'
import { buildSpecialistHandoffFromStep } from '../../../server/utils/agents/specialistHandoff'
import { buildFieldGuideDigest } from '../../../server/graph/core/plan/fieldGuide'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke-multimodal-structured-handoff] ${msg}`)
}

console.log('smoke-multimodal-structured-handoff: start')

const fixture = {
  media_type: 'image',
  action: 'understand',
  entities: [
    { name: '张三', kind: 'person' },
    { name: '体检报告', kind: 'doc' }
  ],
  metrics: [
    { name: '收缩压', value: '138', unit: 'mmHg' },
    { name: '舒张压', value: '86', unit: 'mmHg' }
  ],
  ocr_text_digest: '姓名张三 收缩压138 舒张压86',
  confidence: 0.91,
  raw: { description: '体检报告截图' }
}

{
  const mm = normalizeMultimodalStructured(fixture)
  assert(mm, 'normalize ok')
  assert(mm!.entities.some((e) => e.name === '张三'), 'entity 张三')
  assert(mm!.metrics.some((m) => m.name === '收缩压' && m.value === '138'), 'metric BP')
  assert(mm!.ocr_text_digest.includes('张三'), 'ocr digest')
  const dig = formatMultimodalStructuredDigest(mm)
  assert(dig.includes('张三') && dig.includes('收缩压'), 'digest has entity+metric')
}

{
  const q = enrichQueryWithMultimodalHandoff('对照知识库护理规范原文', normalizeMultimodalStructured(fixture))
  assert(q.includes('对照知识库护理规范原文'), 'keeps base query')
  assert(q.includes('【识图交接】'), 'handoff block')
  assert(q.includes('张三') || q.includes('收缩压'), 'entity or metric in query')
  const again = enrichQueryWithMultimodalHandoff(q, normalizeMultimodalStructured(fixture))
  assert(again === q || again.split('【识图交接】').length <= 2, 'no duplicate handoff spam')
}

{
  const steps = [
    { id: 's_mm', agent: 'multimodal', query: '识图提取体检指标' },
    { id: 's_rag', agent: 'rag', query: '对照知识库护理规范原文', dependsOn: ['s_mm'] },
    { id: 's_db', agent: 'db', query: '查库血压记录', dependsOn: ['s_mm'] },
    { id: 's_other', agent: 'crawler', query: '公网', dependsOn: [] as string[] }
  ]
  const next = applyMultimodalHandoffToPendingSteps(
    steps,
    's_mm',
    normalizeMultimodalStructured(fixture),
    ['s_mm']
  )
  assert(String(next[1]?.query || '').includes('【识图交接】'), 'rag query enriched')
  assert(String(next[2]?.query || '').includes('收缩压') || String(next[2]?.query || '').includes('张三'), 'db query enriched')
  assert(String(next[3]?.query || '') === '公网', 'unrelated step untouched')
}

{
  const ar = {
    ok: true,
    agent: 'multimodal',
    answer: '这是一份体检报告',
    structured: fixture
  }
  const handoff = buildSpecialistHandoffFromStep({
    agent: 'multimodal',
    stepId: 's_mm',
    ok: true,
    output: '这是一份体检报告',
    agentResult: ar as any
  })
  assert(handoff.summary.includes('收缩压') || handoff.summary.includes('张三'), 'specialist summary has structured')

  const soft = buildSoftHandoffFromStep({
    agent: 'multimodal',
    stepId: 's_mm',
    ok: true,
    output: '这是一份体检报告',
    agentResult: ar as any
  })
  assert(soft.multimodalStructured?.metrics?.length, 'soft handoff carries structured')
  const depBlock = formatDependencySoftHandoffs([
    {
      id: 's_mm',
      agent: 'multimodal',
      summary: soft.summary,
      confidence: soft.confidence,
      multimodalStructured: soft.multimodalStructured
    }
  ])
  assert(depBlock.includes('HANDOFF:multimodal'), 'dep soft handoff block')
}

{
  const mm = normalizeMultimodalStructured(fixture)
  const facts = multimodalFactsForFieldGuide(mm)
  assert(facts.length >= 1, 'field guide facts')
  const dig = buildFieldGuideDigest({
    userGoal: '识图并对照规范',
    multimodalStructured: mm,
    softHandoffDigest: 'mm ok'
  })
  assert(dig.includes('已决'), 'field guide 已决')
  assert(dig.includes('识图') || dig.includes('张三') || dig.includes('收缩压'), 'field guide has mm facts')
}

console.log('smoke-multimodal-structured-handoff: ok')
