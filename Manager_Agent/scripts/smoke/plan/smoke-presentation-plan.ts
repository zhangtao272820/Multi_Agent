/**
 * Presentation Plan 契约 smoke（不调 LLM）。
 */
import {
  applyPresentationToSlots,
  assembleStructuralPresentationFallback,
  buildAvailableArtifacts,
  formatPresentationPlanForSynth,
  isPresentationPlanActive,
  planHasModule,
  PresentationPlanSchema,
  resolveEffectiveReplyTier,
  shouldIncludeReportAppendix,
  shouldShowDbDataBlock,
  shouldShowHeadline,
  shouldShowSources
} from '../../../agent-repo-shared/presentationPlan'
import {
  buildReplyArtifactSlots,
  resolveModuleSurface,
  shouldRenderModuleInArtifactPanel,
  shouldRenderModuleInline
} from '../../../agent-repo-shared/presentationSurfaces'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const litePlan = PresentationPlanSchema.parse({
  replyTier: 'lite',
  modules: [{ type: 'prose' }],
  suggestions: [],
  proseStyle: 'confirm',
  confidence: 0.88,
  rationale: 'chitchat',
  source: 'llm'
})
assert(isPresentationPlanActive(litePlan), 'lite plan active')
assert(!planHasModule(litePlan, 'chart'), 'lite has no chart')
assert(!shouldShowDbDataBlock(litePlan), 'lite skips db table block')
assert(!shouldShowHeadline(litePlan, 'lite'), 'lite skips headline')

const singleArtifacts = buildAvailableArtifacts({
  results: { db: '林婉清共 1 条记录', rag: '' },
  evidence: [{ kind: 'db', agentResult: { structured: { rows: [{ name: '林婉清' }] } } }]
})
assert(singleArtifacts.some((a) => a.kind === 'db_result'), 'detect db artifact')

const singlePlan = PresentationPlanSchema.parse({
  replyTier: 'standard',
  modules: [{ type: 'prose' }, { type: 'sources' }],
  suggestions: ['需要明细表吗？'],
  proseStyle: 'conversational',
  confidence: 0.8,
  rationale: 'single rag count',
  source: 'llm'
})
const filtered = applyPresentationToSlots(
  {
    metrics: [{ label: 'x', value: '1' }],
    chart: { title: 't', option: {} },
    table: { headers: ['a'], rows: [['']] } // 无有效值 → 可剥
  },
  singlePlan
)
assert(!filtered.chart && !filtered.table && !filtered.metrics, 'single plan strips empty widgets')

const keepValued = applyPresentationToSlots(
  {
    table: { headers: ['姓名'], rows: [['王建国']] }
  },
  singlePlan
)
assert(keepValued.table?.rows?.[0]?.[0] === '王建国', 'valued db table survives plan without table module')

const complexFallback = assembleStructuralPresentationFallback({
  thickness: 'complex',
  artifacts: [
    { kind: 'visualize_chart', label: 'chart', hasRenderableChart: true },
    { kind: 'report_draft', label: 'report' }
  ]
})
assert(complexFallback.replyTier === 'report', 'complex fallback report')
assert(planHasModule(complexFallback, 'chart'), 'fallback keeps chart when artifact exists')
assert(planHasModule(complexFallback, 'suggestions'), 'complex fallback suggests')

assert(
  resolveEffectiveReplyTier(singlePlan, 'report') === 'standard',
  'plan tier overrides structural'
)
assert(
  resolveEffectiveReplyTier({ ...singlePlan, confidence: 0.2 }, 'report') === 'report',
  'low confidence uses structural tier'
)

assert(
  shouldIncludeReportAppendix(
    PresentationPlanSchema.parse({
      replyTier: 'report',
      modules: [{ type: 'prose' }, { type: 'report_appendix' }],
      suggestions: [],
      proseStyle: 'analytical',
      confidence: 0.9,
      rationale: 'x'
    }),
    'report'
  ),
  'appendix when module selected'
)
assert(!shouldShowSources(litePlan), 'lite hides sources when plan active')

const synthHint = formatPresentationPlanForSynth(singlePlan)
assert(synthHint.includes('展示计划'), 'synth hint block')
assert(synthHint.includes('不展示图表'), 'single plan forbids chart prose')

const reportPlan = PresentationPlanSchema.parse({
  replyTier: 'report',
  modules: [
    { type: 'prose' },
    { type: 'headline' },
    { type: 'chart' },
    { type: 'table' },
    { type: 'report_appendix' }
  ],
  suggestions: ['继续深挖？'],
  proseStyle: 'analytical',
  confidence: 0.91,
  rationale: 'multi compare',
  source: 'llm'
})

assert(
  resolveModuleSurface({ type: 'chart' }, reportPlan) === 'artifact_panel',
  'report chart goes to artifact panel'
)
assert(
  shouldRenderModuleInArtifactPanel(reportPlan, 'chart'),
  'artifact panel renders chart'
)
assert(
  !shouldRenderModuleInline(reportPlan, 'chart'),
  'report chart not inline'
)

const artifactSlots = buildReplyArtifactSlots({
  plan: reportPlan,
  chartTitle: '趋势图',
  hasChart: true,
  hasTable: true,
  hasReport: true
})
assert(artifactSlots.length >= 2, 'artifact slots for report')
assert(artifactSlots.every((s) => s.surface === 'artifact_panel'), 'all report slots in panel')

const standardCollapsed = PresentationPlanSchema.parse({
  replyTier: 'standard',
  modules: [{ type: 'prose' }, { type: 'table', collapsed: true }],
  suggestions: [],
  proseStyle: 'conversational',
  confidence: 0.8,
  rationale: 'db detail collapsed',
  source: 'llm'
})
assert(
  resolveModuleSurface({ type: 'table', collapsed: true }, standardCollapsed) === 'artifact_panel',
  'standard collapsed table → artifact panel'
)
assert(
  resolveModuleSurface({ type: 'table', collapsed: false }, standardCollapsed) === 'inline',
  'standard open table stays inline'
)
const collapsedSlots = buildReplyArtifactSlots({
  plan: standardCollapsed,
  hasTable: true,
  hasChart: false,
  hasReport: false
})
assert(collapsedSlots.length === 1 && collapsedSlots[0]!.kind === 'table', 'collapsed table slot')

const singleFallback = assembleStructuralPresentationFallback({
  thickness: 'single_source',
  artifacts: [{ kind: 'db_result', label: 'db', rowCount: 12 }]
})
assert(singleFallback.modules.some((m) => m.type === 'table' && !m.collapsed), 'single_source table inline (not collapsed)')

console.log('smoke-presentation-plan: ok')
