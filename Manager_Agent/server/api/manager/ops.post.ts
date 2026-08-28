import path from 'node:path'
import {
  loadManagerPolicy,
  loadManagerPolicyShadow,
  restoreManagerPolicyFromPrevious,
  summarizeManagerPolicyDiff
} from '../../graph/core/shared'
import { maybeCurateManagerMemory } from '../../graph/core/memory/memoryCurator'
import { rebuildVectorIndex } from '../../graph/core/memory/vectorMemory'
import {
  clearActivePromptPatches,
  loadActivePromptPatches,
  loadShadowPromptPatches,
  promoteShadowPromptPatches,
  summarizePromptPatchDiff
} from '../../graph/core/evolution/promptPatches'
import { maybeEvolvePromptPatches } from '../../graph/core/evolution/promptEvolution'
import { analyzeFailureInsights } from '../../graph/core/evolution/failureInsights'
import {
  loadActivePlannerRules,
  loadShadowPlannerRules,
  promoteShadowPlannerRules,
  summarizePlannerRulesDiff
} from '../../graph/core/evolution/plannerRules'
import {
  runEvolutionExperimentCycle,
  forcePromoteExperiment,
  forceRollbackExperiment
} from '../../graph/core/evolution/evolutionExperiments'
import { runProactiveLoopTick } from '../../graph/core/task/proactiveLoop'
import { processAutonomousQueueTick } from '../../graph/core/task/autonomousQueue'
import { executeHeadlessManagerRun } from '../../graph/core/runtime/headlessRun'
import { maybeCurateLayeredMemory } from '../../graph/core/layeredMemory'
import {
  listSkillDrafts,
  promoteSkillDraft,
  rejectSkillDraft,
  listSkillDraftsFromPg
} from '../../utils/skills/skillDraftFromSuccess'
import { promoteHighConfidenceSkillDrafts } from '../../utils/skills/skillDraftBatchPromote'
import { clearPlaybookCache } from '../../utils/skills/loadPlaybook'
import { fetchEvolutionHubSummary, runEvolutionHubAudit } from '../../utils/platform/evolutionHub'
import { runUnifiedEvoAuditJob } from '#agent-shared/evoAuditJob'
import { queryMemoryPgStats } from '#agent-shared/memoryDashboard'
import { runSemanticConsolidationJob } from '#agent-shared/semanticConsolidationJob'
import { runMemoryFoldJob } from '#agent-shared/memoryFoldJob'
import { queryToolMemoryTop } from '#agent-shared/toolMemoryStore'
import { runPgDailyBackup } from '#agent-shared/pgDailyBackupJob'
import { runMemoryBackfillJob } from '#agent-shared/memoryBackfillJob'
import { runSkillDraftBackfillJob } from '../../utils/skills/skillDraftBackfillJob'
import { listEvoPolicies } from '#agent-shared/evoPolicyStore'
import { verifyBeforePromote } from '#agent-shared/evolutionVerify'
import { seedManagerEvalSuiteFromGolden, runEvalSuite } from '#agent-shared/onlineEvalStore'
import { forgetMemory } from '#agent-shared/agentMemoryApi'
import { updateUserProfilePrefs } from '../../graph/core/memory/userProfile'
import { resolveManagerPolicyDir } from '../../utils/session/managerPolicyDir'
import { loadPolicyRules } from '#agent-shared/toolCallPolicyEngine'
import { queryTenantAuditStats } from '#agent-shared/tenantAuditStore'
import { maybePromoteManagerPolicyShadow } from '../../graph/core/evolution/autoEvolution'

/**
 * 运维接口（需 `MANAGER_OPS_TOKEN` + 请求头 `x-manager-ops-token`）。
 * POST `/api/manager/ops` body: `{ "action": "..." }`
 */
export default defineEventHandler(async (event) => {
  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }
  const token = String(getHeader(event, 'x-manager-ops-token') || '').trim()
  const expected = String(process.env.MANAGER_OPS_TOKEN || '').trim()
  if (!expected || token !== expected) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>
  const action = String(body?.action || '').trim()
  const dir = path.join(process.cwd(), '.data')

  if (action === 'policy_rollback') {
    const r = await restoreManagerPolicyFromPrevious(dir)
    return { ok: r.ok, message: r.message }
  }

  if (action === 'memory_curate') {
    const r = await maybeCurateManagerMemory(dir, { force: true })
    return { ok: true, memoryCurate: r }
  }

  if (action === 'policy_shadow_diff') {
    const active = await loadManagerPolicy(dir)
    const shadow = await loadManagerPolicyShadow(dir)
    if (!shadow) {
      return { ok: true, shadowPresent: false, message: '未找到 .data/manager-policy.shadow.json' }
    }
    const diff = summarizeManagerPolicyDiff(active, shadow)
    return {
      ok: true,
      shadowPresent: true,
      activeVersion: active.version,
      shadowVersion: shadow.version,
      diffPathCount: diff.diffPathCount,
      paths: diff.paths
    }
  }

  if (action === 'vector_reindex') {
    const max = Number(body?.maxEntries ?? 500)
    const r = await rebuildVectorIndex(dir, { maxEntries: Number.isFinite(max) ? max : 500 })
    return { ok: r.ok, vectorReindex: r }
  }

  if (action === 'prompt_shadow_diff') {
    const active = await loadActivePromptPatches(dir)
    const shadow = await loadShadowPromptPatches(dir)
    return { ok: true, diff: summarizePromptPatchDiff(active, shadow), active, shadow }
  }

  if (action === 'prompt_promote') {
    const minConf = Number(body?.minConfidence ?? 0.68)
    const r = await promoteShadowPromptPatches(dir, {
      minConfidence: Number.isFinite(minConf) ? minConf : 0.68
    })
    return { ok: r.promoted, promptPromote: r }
  }

  if (action === 'prompt_clear_active') {
    await clearActivePromptPatches(dir)
    return { ok: true, message: '已清除 manager-prompt-patches.json' }
  }

  if (action === 'prompt_evolve_force') {
    const insights = await analyzeFailureInsights(dir)
    const r = await maybeEvolvePromptPatches(dir, insights, { force: true })
    return { ok: r.evolved, promptEvolve: r, samples: insights.samples }
  }

  if (action === 'planner_rules_shadow_diff') {
    const active = await loadActivePlannerRules(dir)
    const shadow = await loadShadowPlannerRules(dir)
    return { ok: true, diff: summarizePlannerRulesDiff(active, shadow), active, shadow }
  }

  if (action === 'planner_rules_promote') {
    const minConf = Number(body?.minConfidence ?? 0.68)
    const r = await promoteShadowPlannerRules(dir, {
      minConfidence: Number.isFinite(minConf) ? minConf : 0.68
    })
    return { ok: r.promoted, plannerRulesPromote: r }
  }

  if (action === 'planner_rules_evolve_force') {
    const insights = await analyzeFailureInsights(dir)
    const r = await maybeEvolvePlannerRules(dir, insights, { force: true })
    return { ok: r.evolved, plannerRulesEvolve: r, samples: insights.samples }
  }

  if (action === 'evolution_curator_tick') {
    const insights = await analyzeFailureInsights(dir)
    const mem = await maybeCurateManagerMemory(dir, { force: true })
    const cycle = await runEvolutionExperimentCycle(dir, insights, { force: true })
    return { ok: true, memoryCurate: mem, evolutionExperimentCycle: cycle, samples: insights.samples }
  }

  if (action === 'evolution_experiment_tick') {
    const insights = await analyzeFailureInsights(dir)
    const cycle = await runEvolutionExperimentCycle(dir, insights, { force: true })
    return { ok: true, evolutionExperimentCycle: cycle, samples: insights.samples }
  }

  if (action === 'evolution_experiment_promote') {
    const experimentId = String(body?.experimentId || '').trim()
    if (!experimentId) return { ok: false, message: 'missing experimentId' }
    const r = await forcePromoteExperiment(dir, experimentId)
    return { ok: r.ok, result: r }
  }

  if (action === 'evolution_experiment_rollback') {
    const experimentId = String(body?.experimentId || '').trim()
    if (!experimentId) return { ok: false, message: 'missing experimentId' }
    const r = await forceRollbackExperiment(dir, experimentId)
    return { ok: r.ok, result: r }
  }

  if (action === 'proactive_tick') {
    const r = await runProactiveLoopTick(dir)
    return { ok: true, proactive: r }
  }

  if (action === 'autonomous_queue_tick') {
    const r = await processAutonomousQueueTick(dir, executeHeadlessManagerRun)
    return { ok: true, autonomous: r }
  }

  if (action === 'memory_layers_curate') {
    const r = await maybeCurateLayeredMemory(dir, { force: true })
    return { ok: true, layeredMemoryCurate: r }
  }

  if (action === 'skill_drafts_list') {
    const [drafts, pgDrafts] = await Promise.all([listSkillDrafts(), listSkillDraftsFromPg({ limit: 50 })])
    return { ok: true, drafts, pgDrafts }
  }

  if (action === 'skill_draft_promote') {
    const skillId = String(body?.skillId || '').trim()
    if (!skillId) return { ok: false, message: 'missing skillId' }
    // 单条晋级禁止 skipVerify；与 batch 同纪律走 verifyBeforePromote
    const verify = await verifyBeforePromote('manager')
    if (!verify.ok) return { ok: false, message: verify.reason || 'verify_failed', verify }
    const pgHit = (await listSkillDraftsFromPg({ limit: 200 })).find((r) => r.skillId === skillId)
    const out = await promoteSkillDraft(skillId, pgHit?.markdown ? { markdown: pgHit.markdown } : undefined)
    return { ok: true, ...out, verify }
  }

  if (action === 'skill_draft_promote_batch') {
    const dryRun = Boolean(body?.dryRun)
    const minScore = Number(body?.minScore ?? process.env.MGR_SKILL_BATCH_PROMOTE_MIN_SCORE ?? 0.85)
    const maxCount = Number(body?.maxCount ?? 50)
    const report = await promoteHighConfidenceSkillDrafts(
      {
        dryRun,
        minScore: Number.isFinite(minScore) ? minScore : 0.85,
        maxCount: Number.isFinite(maxCount) ? maxCount : 50,
        // skipVerify 仅 batch 内部二次门禁；请求体 true 仍可能被拒绝
        skipVerify: body?.skipVerify === true,
        agent: body?.agent ? String(body.agent) : undefined
      },
      process.env
    )
    return { ok: report.failed.every((f) => f.skillId !== '*'), skillDraftPromoteBatch: report }
  }

  if (action === 'skill_draft_reject') {
    const skillId = String(body?.skillId || '').trim()
    if (!skillId) return { ok: false, message: 'missing skillId' }
    await rejectSkillDraft(skillId)
    return { ok: true, skillId }
  }

  if (action === 'rule_candidates_list') {
    const { listRuleCandidates } = await import('../../graph/core/memory/ruleCandidateStore')
    const statusRaw = body?.status != null ? String(body.status).trim() : 'draft'
    const rows = await listRuleCandidates(dir, {
      limit: Number(body?.limit ?? 50),
      status:
        statusRaw === 'all'
          ? undefined
          : (statusRaw as 'draft' | 'promoted' | 'rejected'),
    })
    return { ok: true, ruleCandidates: rows }
  }

  if (action === 'rule_candidate_promote') {
    const ruleId = String(body?.ruleCandidateId || body?.skillId || body?.key || '').trim()
    if (!ruleId) return { ok: false, message: 'missing ruleCandidateId' }
    const verify = await verifyBeforePromote('manager')
    if (!verify.ok) return { ok: false, message: verify.reason || 'verify_failed', verify }
    const { setRuleCandidateStatus } = await import('../../graph/core/memory/ruleCandidateStore')
    const out = await setRuleCandidateStatus(dir, ruleId, 'promoted')
    return { ok: out.ok, ...out, verify }
  }

  if (action === 'rule_candidate_reject') {
    const ruleId = String(body?.ruleCandidateId || body?.skillId || body?.key || '').trim()
    if (!ruleId) return { ok: false, message: 'missing ruleCandidateId' }
    const { setRuleCandidateStatus } = await import('../../graph/core/memory/ruleCandidateStore')
    const out = await setRuleCandidateStatus(dir, ruleId, 'rejected')
    return { ok: out.ok, ...out }
  }

  if (action === 'experience_candidates_list') {
    const { listExperienceCandidates } = await import('../../graph/core/memory/experienceCandidateStore')
    const statusRaw = body?.status != null ? String(body.status).trim() : 'draft'
    const rows = await listExperienceCandidates(dir, {
      limit: Number(body?.limit ?? 50),
      status:
        statusRaw === 'all'
          ? undefined
          : (statusRaw as 'draft' | 'promoted' | 'rejected'),
    })
    return { ok: true, experienceCandidates: rows }
  }

  if (action === 'experience_candidate_promote') {
    const candidateId = String(body?.experienceCandidateId || body?.skillId || body?.key || '').trim()
    if (!candidateId) return { ok: false, message: 'missing experienceCandidateId' }
    const verify = await verifyBeforePromote('manager')
    if (!verify.ok) return { ok: false, message: verify.reason || 'verify_failed', verify }
    const { promoteExperienceCandidateById } = await import('../../graph/core/unifiedLearning/promoteFromFeedback')
    const out = await promoteExperienceCandidateById(dir, candidateId)
    return { ok: out.ok, ...out, verify }
  }

  if (action === 'experience_candidate_reject') {
    const candidateId = String(body?.experienceCandidateId || body?.skillId || body?.key || '').trim()
    if (!candidateId) return { ok: false, message: 'missing experienceCandidateId' }
    const { setExperienceCandidateStatus } = await import('../../graph/core/memory/experienceCandidateStore')
    const out = await setExperienceCandidateStatus(dir, candidateId, 'rejected')
    return { ok: out.ok, ...out }
  }

  if (action === 'pending_prefs_list') {
    const { listPendingPrefsProfiles } = await import('../../graph/core/memory/userProfile')
    const rows = await listPendingPrefsProfiles(dir, { limit: Number(body?.limit ?? 40) })
    return { ok: true, pendingPrefs: rows }
  }

  if (action === 'skill_playbook_reload') {
    clearPlaybookCache()
    return { ok: true, message: 'playbook cache cleared' }
  }

  if (action === 'evolution_hub') {
    const hub = await fetchEvolutionHubSummary()
    const policies = {
      manager: await listEvoPolicies('manager'),
      db: await listEvoPolicies('db'),
      rag: await listEvoPolicies('rag')
    }
    return { ok: true, evolutionHub: hub, evoPolicies: policies }
  }

  if (action === 'memory_dashboard') {
    const [pgStats, evolutionHub, evoPolicies] = await Promise.all([
      queryMemoryPgStats(),
      fetchEvolutionHubSummary(),
      Promise.all([
        listEvoPolicies('manager'),
        listEvoPolicies('db'),
        listEvoPolicies('rag')
      ]).then(([manager, db, rag]) => ({ manager, db, rag }))
    ])
    return { ok: true, pgStats, evolutionHub, evoPolicies }
  }

  if (action === 'semantic_consolidate') {
    const report = await runSemanticConsolidationJob()
    return { ok: true, semanticConsolidation: report }
  }

  if (action === 'memory_fold') {
    const report = await runMemoryFoldJob()
    return { ok: true, memoryFold: report }
  }

  if (action === 'memory_forget') {
    const report = await forgetMemory({
      tenantId: body?.tenantId ? String(body.tenantId) : undefined,
      memoryId: body?.memoryId ?? body?.id,
      userKey: body?.userKey ? String(body.userKey) : undefined,
      query: body?.query ? String(body.query) : undefined,
      limit: body?.limit != null ? Number(body.limit) : undefined,
    })
    return { ok: report.ok, memoryForget: report }
  }

  if (action === 'memory_lifecycle') {
    const [fold, consolidate] = await Promise.all([runMemoryFoldJob(), runSemanticConsolidationJob()])
    return {
      ok: true,
      memoryLifecycle: {
        fold,
        consolidate,
        note: 'curate≠promote; importance+forget via memory_forget',
      },
    }
  }

  if (action === 'user_profile_prefs') {
    const userId = String(body?.userId || '').trim()
    const decision = String(body?.decision || body?.mode || 'set').trim().toLowerCase()
    const policyDir = resolveManagerPolicyDir(body?.tenantId ? String(body.tenantId) : undefined)
    const tenantId = body?.tenantId ? String(body.tenantId) : undefined
    if (decision === 'confirm') {
      const { confirmPendingUserPrefs } = await import('../../graph/core/memory/userProfile')
      const profile = await confirmPendingUserPrefs(policyDir, userId, tenantId)
      return { ok: Boolean(profile), profile, decision: 'confirm' }
    }
    if (decision === 'reject') {
      const { rejectPendingUserPrefs } = await import('../../graph/core/memory/userProfile')
      const profile = await rejectPendingUserPrefs(policyDir, userId, tenantId)
      return { ok: Boolean(profile), profile, decision: 'reject' }
    }
    const prefs = (body?.prefs && typeof body.prefs === 'object' ? body.prefs : {}) as {
      timezone?: string
      preferredAgents?: string[]
      refusePreference?: string
    }
    const profile = await updateUserProfilePrefs(policyDir, userId, prefs, tenantId)
    return { ok: Boolean(profile), profile, decision: 'set' }
  }

  if (action === 'tool_memory_stats') {
    const rows = await queryToolMemoryTop({ limit: 20 })
    return { ok: true, toolMemory: rows }
  }

  if (action === 'pg_backup') {
    const report = await runPgDailyBackup()
    return { ok: report.ok, pgBackup: report }
  }

  if (action === 'memory_backfill') {
    const dryRun = Boolean(body?.dryRun)
    const maxRows = Number(body?.maxRows ?? 800)
    const report = await runMemoryBackfillJob(process.env, {
      dryRun,
      maxRows: Number.isFinite(maxRows) ? maxRows : 800
    })
    return { ok: true, dryRun, memoryBackfill: report }
  }

  if (action === 'skill_draft_backfill') {
    const dryRun = Boolean(body?.dryRun)
    const maxRows = Number(body?.maxRows ?? 400)
    const skipVerify = body?.skipVerify !== false
    const report = await runSkillDraftBackfillJob(process.env, {
      dryRun,
      maxRows: Number.isFinite(maxRows) ? maxRows : 400,
      skipVerify
    })
    return { ok: true, dryRun, skillDraftBackfill: report }
  }

  if (action === 'evolution_promote_verify') {
    const verify = await verifyBeforePromote('manager')
    if (!verify.ok) return { ok: false, verify, promoted: null }
    const minPrompt = Number(body?.minConfidence ?? 0.72)
    const minPolicy = Number(body?.minConfidence ?? 0.72)
    const minRules = Number(body?.minConfidence ?? 0.68)
    const [prompt, policy, rules] = await Promise.all([
      promoteShadowPromptPatches(dir, { minConfidence: Number.isFinite(minPrompt) ? minPrompt : 0.72 }),
      maybePromoteManagerPolicyShadow(dir, { minConfidence: Number.isFinite(minPolicy) ? minPolicy : 0.72 }),
      promoteShadowPlannerRules(dir, { minConfidence: Number.isFinite(minRules) ? minRules : 0.68 })
    ])
    return {
      ok: true,
      verify,
      promoted: {
        promptPatches: prompt.promoted,
        policy: policy.promoted,
        plannerRules: rules.promoted
      },
      detail: { prompt, policy, rules }
    }
  }

  if (action === 'evo_audit_tick') {
    const audit = await runUnifiedEvoAuditJob()
    const hub = await runEvolutionHubAudit()
    return { ok: true, audit, hub }
  }

  if (action === 'online_eval_seed') {
    const seeded = await seedManagerEvalSuiteFromGolden()
    return { ok: seeded.seeded, seeded }
  }

  if (action === 'online_eval_run') {
    const suiteId = String(body?.suiteId || 'manager_golden_smoke').trim()
    if (suiteId === 'manager_golden_smoke') await seedManagerEvalSuiteFromGolden().catch(() => undefined)
    const runModeRaw = String(body?.runMode || '').trim().toLowerCase()
    const runMode = runModeRaw === 'structure' || runModeRaw === 'trace' ? runModeRaw : undefined
    const summary = await runEvalSuite(suiteId, { trigger: 'ops', runMode })
    return { ok: Boolean(summary?.ok), summary, runMode: summary?.runMode }
  }

  if (action === 'online_eval_latest') {
    const { getLatestEvalRun } = await import('#agent-shared/onlineEvalStore')
    const suiteId = String(body?.suiteId || 'manager_golden_smoke').trim()
    const latest = await getLatestEvalRun(suiteId)
    return { ok: Boolean(latest?.ok), latest }
  }

  if (action === 'policy_rules_list') {
    const rules = await loadPolicyRules()
    return { ok: true, count: rules.length, rules }
  }

  if (action === 'tenant_audit_stats') {
    const stats = await queryTenantAuditStats(String(body?.tenantId || '').trim() || undefined)
    return { ok: Boolean(stats), stats }
  }

  return {
    ok: false,
    message:
      `未知 action：${action || '(empty)'}；支持：... | online_eval_seed | online_eval_run | online_eval_latest | memory_forget | memory_lifecycle | user_profile_prefs | policy_rules_list | tenant_audit_stats | evo_audit_tick`
  }
})
