/**
 * G5：证据新鲜度离线 smoke。
 */
import {
  isEvidenceStale,
  collectStaleEvidenceSources,
  buildStaleEvidenceHint
} from '../../../server/graph/core/runtime/evidenceFreshness'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const now = Date.parse('2026-07-27T00:00:00.000Z')

{
  assert(
    isEvidenceStale({ ingest_at: '2024-01-01T00:00:00.000Z', source: 'old.docx' }, now, 365),
    'old evidence is stale'
  )
  assert(
    !isEvidenceStale({ ingest_at: '2026-07-01T00:00:00.000Z', source: 'new.docx' }, now, 365),
    'fresh evidence not stale'
  )
  assert(!isEvidenceStale({ source: 'no-date.docx' }, now, 365), 'missing ingest_at not stale')
}

{
  const stale = collectStaleEvidenceSources(
    [
      { source: 'a', ingest_at: '2020-01-01T00:00:00.000Z' },
      { source: 'b', ingest_at: '2026-07-20T00:00:00.000Z' },
      { source: 'a', ingest_at: '2019-01-01T00:00:00.000Z' }
    ],
    now,
    365
  )
  assert(stale.length === 1 && stale[0] === 'a', 'deduped stale sources')
  const hint = buildStaleEvidenceHint(stale)
  assert(hint && hint.includes('过期') && hint.includes('a'), 'hint text')
}

console.log('smoke-evidence-freshness: ok')
