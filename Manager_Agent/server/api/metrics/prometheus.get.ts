import path from 'node:path'
import { buildManagerMetricsDashboard } from '../../graph/core/runtime/metricsAggregate'
import { buildAgentRegistry } from '../../graph/core/agent/agentRegistry'
import { queryMemoryPgStats } from '#agent-shared/memoryDashboard'
import { queryToolMemoryTop } from '#agent-shared/toolMemoryStore'
import { getBackpressureSnapshot } from '../../graph/core/runtime/backpressure'
import { getRequestRateLimitSnapshot } from '../../graph/core/runtime/requestRateLimit'
import { getContentTrustMetricsSnapshot } from '#agent-shared/contentTrustMetrics'
import { getWsStreamSloSnapshot } from '#agent-shared/wsStreamSlo'
import { appendSliCostThicknessPrometheusLines } from '../../graph/core/runtime/sliPrometheus'
import { managerDataRoot, resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'

function escLabel(v: string) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

function line(name: string, value: number, labels?: Record<string, string>) {
  const parts = labels
    ? Object.entries(labels)
        .filter(([, val]) => val !== undefined && val !== '')
        .map(([k, val]) => `${k}="${escLabel(String(val))}"`)
        .join(',')
    : ''
  const suffix = parts ? `{${parts}}` : ''
  const num = Number.isFinite(value) ? value : 0
  return `${name}${suffix} ${num}`
}

export default defineEventHandler(async (event) => {
  const metricsRoot = managerDataRoot()
  const policyDir = resolveManagerPolicyDir()
  const fs = await import('node:fs/promises')
  const metJsonlPath = path.join(metricsRoot, 'manager-metrics.jsonl')

  const phaseAgg: Record<string, { count: number; totalMs: number }> = {}
  const tokensByPhase: Record<string, number> = {}
  const tokensByAgent: Record<string, number> = {}
  let runCount = 0
  let totalTokens = 0
  try {
    const t = await fs.readFile(metJsonlPath, 'utf8').catch(() => '')
    const lines = t.split('\n').filter((l) => l.trim()).slice(-2000)
    const runIds = new Set<string>()
    for (const lineText of lines) {
      try {
        const rec = JSON.parse(lineText) as {
          runId?: string
          phase?: string
          ms?: number
          tokens?: number
          agent?: string
          extra?: { agent?: string }
        }
        const runId = String(rec?.runId ?? '').trim()
        if (runId) runIds.add(runId)
        const k = String(rec?.phase || 'unknown')
        const ms = Number(rec?.ms || 0)
        if (!phaseAgg[k]) phaseAgg[k] = { count: 0, totalMs: 0 }
        phaseAgg[k].count += 1
        phaseAgg[k].totalMs += Number.isFinite(ms) ? ms : 0
        const tok = Number(rec?.tokens || 0)
        if (Number.isFinite(tok) && tok > 0) {
          totalTokens += tok
          tokensByPhase[k] = (tokensByPhase[k] || 0) + tok
          const agentBucket =
            String(rec?.agent || rec?.extra?.agent || '').trim() ||
            (['db', 'rag', 'code', 'crawler', 'admin', 'multimodal', 'music', 'video', 'clean', 'report'].includes(k)
              ? k
              : '')
          if (agentBucket) tokensByAgent[agentBucket] = (tokensByAgent[agentBucket] || 0) + tok
        }
      } catch {}
    }
    runCount = runIds.size
  } catch {}

  const dashboard = await buildManagerMetricsDashboard(policyDir).catch(() => null)
  const registry = buildAgentRegistry()
  const entries = registry.entries || []

  const out: string[] = [
    '# HELP manager_runs_total Distinct run ids in recent metrics window',
    '# TYPE manager_runs_total gauge',
    line('manager_runs_total', runCount),
    '# HELP manager_registry_agents Registered capability agents',
    '# TYPE manager_registry_agents gauge',
    line('manager_registry_agents', entries.length)
  ]

  out.push('# HELP manager_tokens_total Sum of recorded tokens in recent metrics window')
  out.push('# TYPE manager_tokens_total gauge')
  out.push(line('manager_tokens_total', totalTokens))

  const bp = getBackpressureSnapshot()
  out.push('# HELP manager_agent_sli_inflight Active manager runs (G2 backpressure)')
  out.push('# TYPE manager_agent_sli_inflight gauge')
  out.push(line('manager_agent_sli_inflight', bp.inflightRuns))
  out.push('# HELP manager_agent_sli_queue_depth Admission queue depth (waiting, not inflight)')
  out.push('# TYPE manager_agent_sli_queue_depth gauge')
  out.push(line('manager_agent_sli_queue_depth', bp.queueDepth))
  for (const [tenant, n] of Object.entries(bp.inflightByTenant || {})) {
    out.push('# HELP manager_agent_tenant_inflight Per-tenant inflight runs')
    out.push('# TYPE manager_agent_tenant_inflight gauge')
    out.push(line('manager_agent_tenant_inflight', n, { tenant }))
  }
  for (const [agent, n] of Object.entries(bp.inflightByExpert)) {
    out.push('# HELP manager_agent_expert_inflight Expert inflight calls (G2)')
    out.push('# TYPE manager_agent_expert_inflight gauge')
    out.push(line('manager_agent_expert_inflight', n, { agent }))
  }

  for (const [phase, v] of Object.entries(phaseAgg)) {
    out.push('# HELP manager_phase_ms_avg Average phase latency ms')
    out.push('# TYPE manager_phase_ms_avg gauge')
    out.push(line('manager_phase_ms_avg', v.count ? Math.round(v.totalMs / v.count) : 0, { phase }))
    out.push('# HELP manager_phase_count Phase invocation count')
    out.push('# TYPE manager_phase_count counter')
    out.push(line('manager_phase_count', v.count, { phase }))
    const pt = tokensByPhase[phase] || 0
    if (pt > 0) {
      out.push('# HELP manager_phase_tokens_total Tokens by phase in recent window')
      out.push('# TYPE manager_phase_tokens_total gauge')
      out.push(line('manager_phase_tokens_total', pt, { phase }))
    }
  }

  for (const [agent, tok] of Object.entries(tokensByAgent)) {
    if (tok <= 0) continue
    out.push('# HELP manager_agent_tokens_total Tokens attributed to worker agent in recent window')
    out.push('# TYPE manager_agent_tokens_total gauge')
    out.push(line('manager_agent_tokens_total', tok, { agent }))
  }

  const evo = dashboard as Record<string, unknown> | null
  const sli = evo && typeof evo === 'object' ? ((evo as any).sli as Record<string, unknown> | undefined) : undefined
  if (sli && typeof sli === 'object') {
    const p95 = Number(sli.p95LatencyMs ?? NaN)
    if (Number.isFinite(p95)) {
      out.push('# HELP manager_sli_p95_latency_ms End-to-end phase latency P95 ms')
      out.push('# TYPE manager_sli_p95_latency_ms gauge')
      out.push(line('manager_sli_p95_latency_ms', p95))
    }
    const errRate = Number(sli.expertErrorRate ?? NaN)
    if (Number.isFinite(errRate)) {
      out.push('# HELP manager_sli_expert_error_rate Expert step failure rate 0..1')
      out.push('# TYPE manager_sli_expert_error_rate gauge')
      out.push(line('manager_sli_expert_error_rate', errRate))
    }
    const byCode = sli.expertErrorsByCode as Record<string, number> | undefined
    if (byCode && typeof byCode === 'object') {
      for (const [code, n] of Object.entries(byCode)) {
        out.push('# HELP manager_sli_expert_errors_total Expert errors by error_code')
        out.push('# TYPE manager_sli_expert_errors_total gauge')
        out.push(line('manager_sli_expert_errors_total', Number(n) || 0, { error_code: code }))
      }
    }
    const hitlP95 = Number(sli.hitlWaitMsP95 ?? NaN)
    if (Number.isFinite(hitlP95)) {
      out.push('# HELP manager_sli_hitl_wait_p95_ms HITL wait duration P95 ms')
      out.push('# TYPE manager_sli_hitl_wait_p95_ms gauge')
      out.push(line('manager_sli_hitl_wait_p95_ms', hitlP95))
    }
    const rejectRate = Number(sli.evidenceRejectionRate ?? NaN)
    if (Number.isFinite(rejectRate)) {
      out.push('# HELP manager_sli_evidence_rejection_rate Evidence gate / clarify rate 0..1')
      out.push('# TYPE manager_sli_evidence_rejection_rate gauge')
      out.push(line('manager_sli_evidence_rejection_rate', rejectRate))
    }
    const sliTok = Number(sli.totalTokens ?? NaN)
    if (Number.isFinite(sliTok)) {
      out.push('# HELP manager_sli_tokens_total Token sum in SLI window')
      out.push('# TYPE manager_sli_tokens_total gauge')
      out.push(line('manager_sli_tokens_total', sliTok))
    }
    const routeClear = Number((sli as any).routeCommitmentClearRate ?? NaN)
    if (Number.isFinite(routeClear)) {
      out.push('# HELP manager_sli_route_clear_rate Route sourceCommitment=clear rate 0..1')
      out.push('# TYPE manager_sli_route_clear_rate gauge')
      out.push(line('manager_sli_route_clear_rate', routeClear))
    }
    const avgLlm = Number((sli as any).routeAvgLlmCalls ?? NaN)
    if (Number.isFinite(avgLlm)) {
      out.push('# HELP manager_sli_route_avg_llm_calls Avg route LLM calls per route_authority sample')
      out.push('# TYPE manager_sli_route_avg_llm_calls gauge')
      out.push(line('manager_sli_route_avg_llm_calls', avgLlm))
    }
    const skipAlign = Number((sli as any).routeSkipAlignRate ?? NaN)
    if (Number.isFinite(skipAlign)) {
      out.push('# HELP manager_sli_route_skip_align_rate Route align skip rate 0..1')
      out.push('# TYPE manager_sli_route_skip_align_rate gauge')
      out.push(line('manager_sli_route_skip_align_rate', skipAlign))
    }
    appendSliCostThicknessPrometheusLines(out, sli as Record<string, unknown>, line)
  }

  const rateSnap = getRequestRateLimitSnapshot()
  out.push('# HELP manager_request_rate_limited_total Chat requests rejected by MANAGER_REQUEST_RATE_PER_MIN')
  out.push('# TYPE manager_request_rate_limited_total counter')
  out.push(line('manager_request_rate_limited_total', rateSnap.rejectedTotal))

  const trustSnap = getContentTrustMetricsSnapshot()
  out.push('# HELP manager_content_trust_wrap_total Untrusted content wrap operations')
  out.push('# TYPE manager_content_trust_wrap_total counter')
  out.push(line('manager_content_trust_wrap_total', trustSnap.wrapTotal))
  out.push('# HELP manager_content_trust_sanitize_empty_total Sanitize emptied untrusted body')
  out.push('# TYPE manager_content_trust_sanitize_empty_total counter')
  out.push(line('manager_content_trust_sanitize_empty_total', trustSnap.sanitizeEmptyTotal))
  out.push('# HELP manager_content_trust_strict_total Strict mode wrap operations')
  out.push('# TYPE manager_content_trust_strict_total counter')
  out.push(line('manager_content_trust_strict_total', trustSnap.strictModeTotal))

  const streamSlo = getWsStreamSloSnapshot()
  if (streamSlo.ttftSampleCount > 0) {
    out.push('# HELP manager_ws_ttft_p50_ms WS first stream event TTFT P50 ms')
    out.push('# TYPE manager_ws_ttft_p50_ms gauge')
    out.push(line('manager_ws_ttft_p50_ms', streamSlo.ttftP50Ms))
    out.push('# HELP manager_ws_ttft_samples Total TTFT samples recorded')
    out.push('# TYPE manager_ws_ttft_samples gauge')
    out.push(line('manager_ws_ttft_samples', streamSlo.ttftSampleCount))
  }
  if (streamSlo.cancelSampleCount > 0) {
    out.push('# HELP manager_ws_cancel_ack_p50_ms Cancel request to ack P50 ms')
    out.push('# TYPE manager_ws_cancel_ack_p50_ms gauge')
    out.push(line('manager_ws_cancel_ack_p50_ms', streamSlo.cancelAckP50Ms))
  }

  if (evo && typeof evo === 'object') {
    const searchHit = Number((evo as any).searchHitRate ?? (evo as any).search_hit_rate ?? NaN)
    if (Number.isFinite(searchHit)) {
      out.push('# HELP manager_search_hit_rate Recent search hit rate 0..1')
      out.push('# TYPE manager_search_hit_rate gauge')
      out.push(line('manager_search_hit_rate', searchHit))
    }
    const fps = Number((evo as any).firstPassSuccessRate ?? NaN)
    if (Number.isFinite(fps)) {
      out.push('# HELP manager_first_pass_success_rate First-pass success rate 0..1')
      out.push('# TYPE manager_first_pass_success_rate gauge')
      out.push(line('manager_first_pass_success_rate', fps))
    }
    const nluCount = Number((evo as any).nluSampleCount ?? NaN)
    if (Number.isFinite(nluCount)) {
      out.push('# HELP manager_nlu_sample_count NLU metric samples in window')
      out.push('# TYPE manager_nlu_sample_count gauge')
      out.push(line('manager_nlu_sample_count', nluCount))
    }
    const avgFinal = Number((evo as any).avgFinalConfidence ?? NaN)
    if (Number.isFinite(avgFinal)) {
      out.push('# HELP manager_avg_final_confidence Average final confidence 0..1')
      out.push('# TYPE manager_avg_final_confidence gauge')
      out.push(line('manager_avg_final_confidence', avgFinal))
    }
    const replayRate = Number((evo as any).experienceReplayUsageRate ?? NaN)
    if (Number.isFinite(replayRate)) {
      out.push('# HELP manager_experience_replay_rate Experience replay usage 0..1')
      out.push('# TYPE manager_experience_replay_rate gauge')
      out.push(line('manager_experience_replay_rate', replayRate))
    }
    const byAgent = (evo as any).byAgent as Record<string, { count?: number; avgSuccess?: number }> | undefined
    if (byAgent && typeof byAgent === 'object') {
      for (const [agent, stats] of Object.entries(byAgent)) {
        const id = String(agent || '').trim()
        if (!id) continue
        const count = Number(stats?.count ?? 0)
        const succ = Number(stats?.avgSuccess ?? NaN)
        if (Number.isFinite(count) && count > 0) {
          out.push('# HELP manager_agent_experience_count Experience samples by agent path')
          out.push('# TYPE manager_agent_experience_count gauge')
          out.push(line('manager_agent_experience_count', count, { agent: id }))
        }
        if (Number.isFinite(succ)) {
          out.push('# HELP manager_agent_success_rate Agent path success rate 0..1')
          out.push('# TYPE manager_agent_success_rate gauge')
          out.push(line('manager_agent_success_rate', succ, { agent: id }))
        }
      }
    }
  }

  for (const entry of entries) {
    const id = String(entry.id || '')
    if (!id) continue
    out.push('# HELP manager_agent_registered Agent in registry (1=present)')
    out.push('# TYPE manager_agent_registered gauge')
    out.push(line('manager_agent_registered', 1, { agent: id }))
  }

  const memStats = await queryMemoryPgStats().catch(() => null)
  if (memStats?.pgReachable) {
    out.push('# HELP manager_memory_sessions Total mgr_sessions rows')
    out.push('# TYPE manager_memory_sessions gauge')
    out.push(line('manager_memory_sessions', memStats.sessions))
    out.push('# HELP manager_memory_session_turns Total mgr_session_turns rows')
    out.push('# TYPE manager_memory_session_turns gauge')
    out.push(line('manager_memory_session_turns', memStats.sessionTurns))
    out.push('# HELP manager_memory_experience_entries Experience memory entries')
    out.push('# TYPE manager_memory_experience_entries gauge')
    out.push(line('manager_memory_experience_entries', memStats.memoryEntries.experience ?? 0))
    out.push('# HELP manager_memory_semantic_entries Semantic memory entries')
    out.push('# TYPE manager_memory_semantic_entries gauge')
    out.push(line('manager_memory_semantic_entries', memStats.semanticFacts))
    out.push('# HELP manager_memory_embeddings Vector embedding rows')
    out.push('# TYPE manager_memory_embeddings gauge')
    out.push(line('manager_memory_embeddings', memStats.embeddings))
    out.push('# HELP manager_tool_memory_rows Tool memory aggregate rows')
    out.push('# TYPE manager_tool_memory_rows gauge')
    out.push(line('manager_tool_memory_rows', memStats.toolMemoryRows))
    out.push('# HELP manager_skill_draft_rows Pending skill draft rows')
    out.push('# TYPE manager_skill_draft_rows gauge')
    out.push(line('manager_skill_draft_rows', memStats.skillDrafts))
    out.push('# HELP manager_session_folded_rows Memory fold completed sessions')
    out.push('# TYPE manager_session_folded_rows gauge')
    out.push(line('manager_session_folded_rows', memStats.foldedSessions))
    out.push('# HELP manager_evo_policy_versions Evolution policy version rows')
    out.push('# TYPE manager_evo_policy_versions gauge')
    out.push(line('manager_evo_policy_versions', memStats.evoPolicies))
    out.push('# HELP manager_federation_db_experience_rows DB query experience federation rows')
    out.push('# TYPE manager_federation_db_experience_rows gauge')
    out.push(line('manager_federation_db_experience_rows', memStats.dbExperienceRows))
    out.push('# HELP manager_federation_rag_signal_rows RAG learning signal federation rows')
    out.push('# TYPE manager_federation_rag_signal_rows gauge')
    out.push(line('manager_federation_rag_signal_rows', memStats.ragLearningSignals))
    out.push('# HELP manager_federation_admin_experience_rows Admin tool experience federation rows')
    out.push('# TYPE manager_federation_admin_experience_rows gauge')
    out.push(line('manager_federation_admin_experience_rows', memStats.adminToolExperience))
    out.push('# HELP manager_federation_code_experience_rows Code query experience federation rows')
    out.push('# TYPE manager_federation_code_experience_rows gauge')
    out.push(line('manager_federation_code_experience_rows', memStats.codeExperienceRows))
    out.push('# HELP manager_federation_crawler_experience_rows Extractor crawl experience federation rows')
    out.push('# TYPE manager_federation_crawler_experience_rows gauge')
    out.push(line('manager_federation_crawler_experience_rows', memStats.crawlerExperienceRows))
    out.push('# HELP manager_federation_gui_experience_rows Lobster GUI experience federation rows')
    out.push('# TYPE manager_federation_gui_experience_rows gauge')
    out.push(line('manager_federation_gui_experience_rows', memStats.guiExperienceRows))
    out.push('# HELP manager_mcp_registry_rows MCP tool registry rows')
    out.push('# TYPE manager_mcp_registry_rows gauge')
    out.push(line('manager_mcp_registry_rows', memStats.mcpRegistryRows))

    const metricsTenant = String(process.env.MGR_METRICS_TENANT_ID || process.env.MGR_DEFAULT_TENANT_ID || 'default').trim()
    const tools = await queryToolMemoryTop({ tenantId: metricsTenant, limit: 12 }).catch(() => [])
    for (const t of tools) {
      out.push('# HELP manager_tool_success_rate Per-tool success rate 0..1')
      out.push('# TYPE manager_tool_success_rate gauge')
      out.push(
        line('manager_tool_success_rate', t.successRate, {
          agent: t.agent,
          tool: t.toolName,
          tenant: t.tenantId || metricsTenant
        })
      )
      out.push('# HELP manager_tool_trials Per-tool trial count')
      out.push('# TYPE manager_tool_trials gauge')
      out.push(
        line('manager_tool_trials', t.trials, {
          agent: t.agent,
          tool: t.toolName,
          tenant: t.tenantId || metricsTenant
        })
      )
    }
  }

  setResponseHeader(event, 'Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  return out.join('\n') + '\n'
})
