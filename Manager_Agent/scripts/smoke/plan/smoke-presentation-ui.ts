/**
 * Presentation UI 辅助 smoke（前端纯函数，不调 LLM）。
 */
import {
  activePresentationPlan,
  hasArtifactPanel,
  modulePrefersArtifactPanel,
  shouldShowInlineChart,
  shouldShowInlineReportAppendix,
  shouldShowInlineTable,
  shouldStripAuxBlocksDuringStream,
  streamingArtifactHint,
  turnHasEditedReport,
  type ReplyArtifactKind
} from '../../../app/composables/managerPresentationUi'
import type { TurnGroup } from '../../../app/composables/managerChatTypes'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function turn(partial: Partial<TurnGroup>): TurnGroup {
  return {
    id: 1,
    results: [],
    errors: [],
    process: [],
    codePatches: [],
    searchSources: [],
    ragEvidence: [],
    ...partial
  }
}

const reportTurn = turn({
  userFacing: {
    replyTier: 'report',
    presentationPlan: {
      replyTier: 'report',
      modules: [
        { type: 'prose' },
        { type: 'chart' },
        { type: 'table' },
        { type: 'report_appendix' }
      ],
      confidence: 0.9
    },
    artifacts: [
      { id: 'chart-chart', kind: 'chart', title: '趋势', surface: 'artifact_panel' },
      { id: 'table-table', kind: 'table', title: '明细', surface: 'artifact_panel' }
    ],
    chart: { title: '趋势', option: { series: [] } },
    table: { headers: ['a'], rows: [['1']] }
  }
})

assert(activePresentationPlan(reportTurn)?.replyTier === 'report', 'active plan')
assert(modulePrefersArtifactPanel(reportTurn, 'chart'), 'report chart prefers panel')
assert(!shouldShowInlineChart(reportTurn, true), 'report chart not inline')
assert(!shouldShowInlineTable(reportTurn, true), 'report table not inline')
assert(hasArtifactPanel(reportTurn), 'has artifact panel')
assert(shouldStripAuxBlocksDuringStream(reportTurn), 'stream strips aux')
assert(streamingArtifactHint(reportTurn).includes('图表'), 'stream hint mentions chart')

const standardInline = turn({
  userFacing: {
    replyTier: 'standard',
    presentationPlan: {
      replyTier: 'standard',
      modules: [{ type: 'prose' }, { type: 'table' }],
      confidence: 0.85
    },
    artifacts: [{ id: 't', kind: 'table', title: '表', surface: 'inline' }],
    table: { headers: ['x'], rows: [['1']] }
  }
})
assert(shouldShowInlineTable(standardInline, true), 'standard table inline')
assert(!hasArtifactPanel(standardInline), 'no panel for inline-only')

const reportPanelTurn = turn({
  userFacing: {
    replyTier: 'report',
    presentationPlan: {
      replyTier: 'report',
      modules: [{ type: 'prose' }, { type: 'report_appendix' }],
      confidence: 0.9
    },
    artifacts: [{ id: 'r', kind: 'report', title: '报告', surface: 'artifact_panel' }],
    appendix: '### 详细\n内容足够长用于附录展示测试用例一二三四五六七八',
    reportEdited: true
  }
})
assert(!shouldShowInlineReportAppendix(reportPanelTurn), 'report in panel hides bubble appendix')
assert(turnHasEditedReport(reportPanelTurn), 'edited badge')
assert(
  Boolean(reportPanelTurn.userFacing?.reportEdited),
  'reportEdited flag on payload'
)

const collapsed = turn({
  presentationPlan: {
    replyTier: 'standard',
    modules: [{ type: 'prose' }, { type: 'table', collapsed: true }],
    confidence: 0.8
  }
})
assert(modulePrefersArtifactPanel(collapsed, 'table'), 'collapsed table prefers panel')
assert(streamingArtifactHint(collapsed).includes('数据表'), 'collapsed stream hint')

const kinds: ReplyArtifactKind[] = ['chart', 'table', 'report']
assert(kinds.length === 3, 'kind union')

console.log('smoke-presentation-ui: ok')
