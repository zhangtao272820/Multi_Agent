import { buildTraceDeepLinks } from '../../graph/core/runtime/traceDeepLinks'

/** Wave6：Trace 深链（Langfuse / Tempo）形态 */
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const runId = String(q.runId || q.trace_id || q.traceId || '').trim()
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: 'runId required' })
  }
  const links = buildTraceDeepLinks(runId)
  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  return {
    ok: true,
    ...links
  }
})
