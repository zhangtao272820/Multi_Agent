import { listGlobalCandidates, reviewGlobalCandidate } from '../../graph/core/evolution/globalEvolutionBridge'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const status = String(q.status || 'pending').trim() as 'pending' | 'approved' | 'rejected' | 'all'
  const rows = await listGlobalCandidates(
    status === 'approved' || status === 'rejected' || status === 'all' ? status : 'pending'
  )
  return { ok: true, candidates: rows }
})
