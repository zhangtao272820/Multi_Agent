/**
 * Artifact 导出 / 修订注 契约 smoke（不调 LLM）。
 */
import {
  base64PngToBytes,
  buildArtifactExportManifest,
  buildZipStore,
  formatReportRevisionNote,
  isReportRevisionNoteLine,
  mergeSummaryWithRevisionNote,
  tableToCsv
} from '../../../app/composables/managerArtifactExport'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const note = formatReportRevisionNote('2026-08-28T02:51:00.000Z')
assert(note.includes('报告已在分析面板修订'), 'note prefix')
assert(isReportRevisionNoteLine(note), 'note line detect')

const merged = mergeSummaryWithRevisionNote('首段结论。\n\n### 要点\n- a', note)
assert(merged.includes('首段结论'), 'keeps body')
assert(merged.includes(note), 'appends note')
const merged2 = mergeSummaryWithRevisionNote(merged, formatReportRevisionNote('2026-08-28T03:00:00.000Z'))
assert((merged2.match(/报告已在分析面板修订/g) || []).length === 1, 'idempotent note')

const csv = tableToCsv({
  headers: ['姓名', '值'],
  rows: [
    ['林婉清', '1'],
    ['A,B', '2\n3']
  ]
})
assert(csv.startsWith('姓名,值\n'), 'csv header')
assert(csv.includes('"A,B"'), 'csv escape comma')
assert(csv.includes('"2\n3"'), 'csv escape newline')

const pngB64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const bytes = base64PngToBytes(`data:image/png;base64,${pngB64}`)
assert(bytes && bytes.length > 10, 'png decode')

const zip = buildZipStore([
  { name: 'report.md', data: new TextEncoder().encode('# hi\n') },
  { name: 'table.csv', data: new TextEncoder().encode('a,b\n1,2\n') },
  { name: 'chart.png', data: bytes! },
  {
    name: 'manifest.json',
    data: new TextEncoder().encode(
      buildArtifactExportManifest({
        turnId: 7,
        title: '测试',
        hasReport: true,
        hasTable: true,
        hasChart: true,
        reportEdited: true
      })
    )
  }
])
assert(zip.length > 80, 'zip non-empty')
// ZIP local file header signature PK\x03\x04
assert(zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04, 'zip local sig')

const manifest = JSON.parse(
  buildArtifactExportManifest({
    turnId: 1,
    hasReport: true,
    hasTable: false,
    hasChart: false
  })
)
assert(manifest.files.includes('report.md'), 'manifest files')
assert(!manifest.files.includes('table.csv'), 'manifest omits missing')

console.log('smoke-artifact-export: ok')
