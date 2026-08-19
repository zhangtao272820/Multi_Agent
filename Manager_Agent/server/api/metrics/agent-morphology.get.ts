import {
  getAgentMorphologyForRun,
  listAgentMorphology
} from '#agent-shared/agentMorphologyJournal'

/** 查询本轮 / 最近 Agent 形态快照（planned + final） */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const runId = String(q.runId || q.trace_id || q.traceId || '').trim()
  const kind = String(q.kind || '').trim()
  const limit = Math.min(80, Math.max(1, Number(q.limit ?? 30) || 30))

  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')

  if (runId) {
    const rows = await getAgentMorphologyForRun(runId)
    return {
      ok: true,
      runId,
      count: rows.length,
      records: rows
    }
  }

  const rows = await listAgentMorphology({
    limit,
    kind: kind === 'planned' || kind === 'final' ? kind : undefined
  })
  return {
    ok: true,
    count: rows.length,
    records: rows
  }
})
