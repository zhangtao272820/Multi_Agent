/**
 * Wave 8：元意图冷路径分发 — 复用现有 shadow/draft/prefs，不改 cap。
 */
import { promoteExperienceFromPositiveFeedback } from '../unifiedLearning/promoteFromFeedback'
import { proposeUserProfilePrefs, loadUserProfile, detectPrefsConflictNote } from './userProfile'
import { upsertRuleCandidate } from './ruleCandidateStore'
import {
  buildMemoryCaptureProposal,
  type MemoryCaptureProposal,
  type MemoryMetaIntentParsed,
} from './memoryMetaIntent'
import { maybeAutoDraftSkillFromSuccess } from '../../../utils/skills/skillDraftAuto'

export type MemoryMetaIntentDispatchContext = {
  policyDir: string
  runId: string
  sessionId?: string
  userId?: string
  tenantId?: string
  question: string
  answer: string
  intent: string
  planAgents: string[]
  successScore: number
  needsClarify: boolean
  failureCategory: string
  scenarioKey?: string
  feedbackScore?: number | null
  probeDbMatched?: boolean
  probeRagHits?: number
}

export type MemoryMetaIntentDispatchResult = {
  proposal: MemoryCaptureProposal | null
  dispatched: boolean
  detail?: string
}

const EXPLICIT_FEEDBACK_SCORE = 0.85

export async function dispatchMemoryMetaIntent(
  parsed: MemoryMetaIntentParsed,
  ctx: MemoryMetaIntentDispatchContext,
  source: MemoryCaptureProposal['source'] = 'explicit_user_request'
): Promise<MemoryMetaIntentDispatchResult> {
  if (parsed.kind === 'none' || parsed.confidence < 0.5) {
    return { proposal: null, dispatched: false, detail: 'none_or_low_confidence' }
  }

  if (parsed.kind === 'todo') {
    const proposal = buildMemoryCaptureProposal({
      parsed,
      source,
      runId: ctx.runId,
      dispatch: {
        status: 'acknowledged_pre_ingest',
        note: '待办由消息入栈阶段处理；finalize 不重复入栈',
      },
    })
    return { proposal, dispatched: false, detail: 'todo_pre_ingest_ack' }
  }

  if (ctx.needsClarify && parsed.kind !== 'save_preference') {
    return {
      proposal: buildMemoryCaptureProposal({
        parsed,
        source,
        runId: ctx.runId,
        dispatch: { status: 'skipped', note: 'needs_clarify' },
      }),
      dispatched: false,
      detail: 'needs_clarify',
    }
  }

  const answer = String(ctx.answer || '').trim()
  if (
    (parsed.kind === 'save_answer' || parsed.kind === 'save_playbook') &&
    answer.length < 16
  ) {
    return {
      proposal: buildMemoryCaptureProposal({
        parsed,
        source,
        runId: ctx.runId,
        dispatch: { status: 'skipped', note: 'empty_answer' },
      }),
      dispatched: false,
      detail: 'empty_answer',
    }
  }

  if (parsed.kind === 'save_answer') {
    const fb = Math.max(
      EXPLICIT_FEEDBACK_SCORE,
      typeof ctx.feedbackScore === 'number' ? ctx.feedbackScore : 0,
      ctx.successScore >= 0.72 ? ctx.successScore : 0
    )
    const pr = await promoteExperienceFromPositiveFeedback({
      policyDir: ctx.policyDir,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      feedbackScore: fb,
      userTaskOverride: ctx.question,
      intentOverride: ctx.intent,
      pathOverride: ctx.planAgents.length ? ctx.planAgents : undefined,
      memorySource: source === 'explicit_user_request' ? 'explicit_user_request' : 'explicit_feedback',
    }).catch(() => ({ promoted: false, reason: 'error' }))
    if (pr.promoted && ctx.runId) {
      const { tagMgrRunArtifactCaptureSource } = await import('#agent-shared/artifactStore')
      await tagMgrRunArtifactCaptureSource(
        ctx.runId,
        source === 'explicit_user_request' ? 'explicit_user_request' : 'explicit_feedback'
      ).catch(() => false)
    }
    const pendingReview = pr.reason === 'pending_review'
    const proposal = buildMemoryCaptureProposal({
      parsed,
      source,
      runId: ctx.runId,
      dispatch: {
        status: pr.promoted ? 'applied_shadow' : pendingReview ? 'draft_pending_review' : 'skipped',
        experienceCandidateId: pr.candidateId,
        note: pr.promoted
          ? 'experience_promoted'
          : pendingReview
            ? [pr.conflictNote, 'experience_candidate_pending_review'].filter(Boolean).join('; ')
            : String(pr.reason || 'promote_pending'),
      },
    })
    return {
      proposal,
      dispatched: pr.promoted || pendingReview,
      detail: pr.promoted
        ? 'save_answer_promoted'
        : pendingReview
          ? 'save_answer_pending_review'
          : String(pr.reason || 'save_answer_pending'),
    }
  }

  if (parsed.kind === 'save_playbook') {
    const boostedScore = Math.max(ctx.successScore, EXPLICIT_FEEDBACK_SCORE)
    const draft = await maybeAutoDraftSkillFromSuccess(
      {
        agent: 'manager',
        question: ctx.question,
        answer,
        path: ctx.planAgents.join('→'),
        runId: ctx.runId,
        successScore: boostedScore,
        needsClarify: ctx.needsClarify,
        scenarioKey: ctx.scenarioKey,
        failureCategory: ctx.failureCategory,
        planAgents: ctx.planAgents,
        probeDbMatched: ctx.probeDbMatched,
        probeRagHits: ctx.probeRagHits,
        hints: [
          'source=explicit_user_request',
          parsed.title ? `title=${parsed.title}` : '',
          parsed.summary ? `summary=${parsed.summary}` : '',
        ].filter(Boolean),
      },
      process.env
    ).catch(() => ({ drafted: false, reason: 'error' }))
    const proposal = buildMemoryCaptureProposal({
      parsed,
      source,
      runId: ctx.runId,
      dispatch: {
        status: draft.drafted ? 'draft_pending_review' : 'skipped',
        skillId: draft.skillId,
        note: draft.drafted ? 'skill_draft_written' : String(draft.reason || 'draft_skipped'),
      },
    })
    return {
      proposal,
      dispatched: draft.drafted,
      detail: draft.drafted ? 'save_playbook_drafted' : String(draft.reason || 'draft_skipped'),
    }
  }

  if (parsed.kind === 'save_preference') {
    const uid = String(ctx.userId || '').trim()
    if (!uid) {
      return {
        proposal: buildMemoryCaptureProposal({
          parsed,
          source,
          runId: ctx.runId,
          dispatch: { status: 'skipped', note: 'missing_user_id' },
        }),
        dispatched: false,
        detail: 'missing_user_id',
      }
    }
    const patch = parsed.preferencePatch || {}
    const agents =
      patch.preferredAgents?.length ? patch.preferredAgents : ctx.planAgents.slice(0, 4)
    const prefsPatch = {
      preferredAgents: agents.length ? agents : undefined,
      refusePreference: patch.refusePreference,
      timezone: patch.timezone,
    }
    const prevProfile = await loadUserProfile(ctx.policyDir, '', uid, ctx.tenantId).catch(() => null)
    const conflictNote = detectPrefsConflictNote(prevProfile?.prefs, prefsPatch)
    await proposeUserProfilePrefs(ctx.policyDir, uid, prefsPatch, ctx.tenantId, 'explicit_user_request').catch(
      () => null
    )
    const proposal = buildMemoryCaptureProposal({
      parsed,
      source,
      runId: ctx.runId,
      dispatch: {
        status: 'draft_pending_review',
        note: conflictNote
          ? `prefs_require_explicit_confirm; ${conflictNote}`
          : 'prefs_require_explicit_confirm',
      },
    })
    return { proposal, dispatched: true, detail: 'save_preference_proposed' }
  }

  if (parsed.kind === 'save_org_rule') {
    const row = await upsertRuleCandidate(ctx.policyDir, {
      title: parsed.title || parsed.summary || '组织规则候选',
      summary: parsed.summary,
      businessQuestion: ctx.question,
      answerSnippet: answer.slice(0, 800),
      sourceRunId: ctx.runId,
      scope: 'manager',
    }).catch(() => null)
    const proposal = buildMemoryCaptureProposal({
      parsed,
      source,
      runId: ctx.runId,
      dispatch: {
        status: row ? 'draft_pending_review' : 'skipped',
        ruleCandidateId: row?.id,
        note: row ? 'rule_candidate_written' : 'rule_candidate_disabled',
      },
    })
    return {
      proposal,
      dispatched: Boolean(row),
      detail: row ? 'save_org_rule_drafted' : 'rule_candidate_skipped',
    }
  }

  return { proposal: null, dispatched: false, detail: 'unhandled_kind' }
}
