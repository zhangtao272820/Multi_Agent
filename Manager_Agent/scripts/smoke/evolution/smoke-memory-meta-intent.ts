/**
 * Wave 8：元意图分流契约 smoke（不调 LLM、不写真实 PG）
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildMemoryCaptureProposal,
  isMemoryMetaIntentEnabled,
  isRuleCandidateEnabled,
} from '../../../server/graph/core/memory/memoryMetaIntent'
import { dispatchMemoryMetaIntent } from '../../../server/graph/core/memory/dispatchMemoryMetaIntent'
import { memoryCaptureProposalLabel } from '../../../server/graph/core/memory/runMemoryMetaIntentCapture'
import { resolveMemoryMetaIntentFallback } from '../../../server/graph/llm/memoryMetaIntentLlm'
import { listRuleCandidates, upsertRuleCandidate } from '../../../server/graph/core/memory/ruleCandidateStore'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke:memory-meta-intent] ${msg}`)
}

async function main() {
  console.log('smoke:memory-meta-intent: start')

  assert(isMemoryMetaIntentEnabled(), 'MANAGER_MEMORY_META_INTENT default on')
  assert(isRuleCandidateEnabled(), 'MGR_RULE_CANDIDATE_ENABLED default on')

  const todoProposal = buildMemoryCaptureProposal({
    parsed: { kind: 'todo', confidence: 0.9, title: '周五交报告' },
    source: 'explicit_user_request',
    runId: 'run_fixture',
    dispatch: { status: 'acknowledged_pre_ingest', note: 'pre_ingest' },
  })
  assert(todoProposal?.kind === 'todo', 'todo proposal')
  assert(todoProposal?.status === 'acknowledged_pre_ingest', 'todo ack')

  const playbookProposal = buildMemoryCaptureProposal({
    parsed: { kind: 'save_playbook', confidence: 0.88, title: '制度+查数复合查法' },
    source: 'explicit_user_request',
    runId: 'run_fixture',
    dispatch: { status: 'draft_pending_review', skillId: 'manager_learned_x', note: 'draft' },
  })
  assert(playbookProposal?.kind === 'save_playbook', 'playbook proposal')
  assert(
    memoryCaptureProposalLabel(playbookProposal!).includes('待管理员审核'),
    'playbook label'
  )

  const fb = resolveMemoryMetaIntentFallback({ feedbackScore: 0.82 })
  assert(fb?.kind === 'save_answer', 'feedback fallback save_answer')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-meta-intent-'))
  const policyDir = path.join(tmp, 'policy')
  await fs.mkdir(policyDir, { recursive: true })

  process.env.MANAGER_MEMORY_META_INTENT = '1'
  process.env.MGR_RULE_CANDIDATE_ENABLED = '1'
  process.env.MGR_SKILL_AUTO_DRAFT = '0'
  process.env.OPENAI_API_KEY = ''

  const todoDispatch = await dispatchMemoryMetaIntent(
    { kind: 'todo', confidence: 0.92, title: '周五交报告' },
    {
      policyDir,
      runId: 'run_todo',
      question: '记住：周五交报告',
      answer: '好的，已记录。',
      intent: 'chat',
      planAgents: ['chat'],
      successScore: 0.9,
      needsClarify: false,
      failureCategory: 'success',
    }
  )
  assert(todoDispatch.proposal?.status === 'acknowledged_pre_ingest', 'dispatch todo ack')
  assert(!todoDispatch.dispatched, 'todo not double-ingest')

  const noneDispatch = await dispatchMemoryMetaIntent(
    { kind: 'none', confidence: 0.1 },
    {
      policyDir,
      runId: 'run_none',
      question: '查一下补贴标准',
      answer: '根据制度……',
      intent: 'rag',
      planAgents: ['rag'],
      successScore: 0.9,
      needsClarify: false,
      failureCategory: 'success',
    }
  )
  assert(!noneDispatch.proposal, 'none produces no proposal')

  const ruleRow = await upsertRuleCandidate(policyDir, {
    title: '禁止编造占比',
    summary: '无 citation 不出具体百分比',
    businessQuestion: '写成规则：无 citation 不出具体百分比',
    answerSnippet: '已理解',
    sourceRunId: 'run_rule',
  })
  assert(ruleRow?.id?.startsWith('rule_'), 'rule candidate id')
  const listed = await listRuleCandidates(policyDir, { status: 'draft' })
  assert(listed.some((r) => r.id === ruleRow?.id), 'rule candidate listed')

  const clarifySkip = await dispatchMemoryMetaIntent(
    { kind: 'save_playbook', confidence: 0.9, title: '打法' },
    {
      policyDir,
      runId: 'run_clarify',
      question: '以后都这么查',
      answer: '请补充你要查的机构范围？',
      intent: 'rag',
      planAgents: ['rag'],
      successScore: 0.5,
      needsClarify: true,
      failureCategory: 'needs_clarify',
    }
  )
  assert(clarifySkip.proposal?.status === 'skipped', 'needs_clarify skips playbook')

  const answerDispatch = await dispatchMemoryMetaIntent(
    { kind: 'save_answer', confidence: 0.91, title: '补贴标准答复', summary: '记住本轮答案' },
    {
      policyDir,
      runId: 'run_save_answer',
      sessionId: 'sess_fixture',
      question: '养老机构护理员补贴标准是多少？',
      answer: '根据制度文件，护理员补贴标准为……（fixture 证据摘要）',
      intent: 'rag',
      planAgents: ['rag'],
      successScore: 0.8,
      needsClarify: false,
      failureCategory: 'success',
    },
    'explicit_user_request'
  )
  assert(answerDispatch.dispatched, 'save_answer dispatched with override')
  assert(answerDispatch.proposal?.status === 'draft_pending_review', 'save_answer draft_pending_review')
  assert(answerDispatch.proposal?.experienceCandidateId?.startsWith('exp_'), 'save_answer candidate id')

  const { listExperienceCandidates, detectExperienceConflictNote } = await import(
    '../../../server/graph/core/memory/experienceCandidateStore'
  )
  const expListed = await listExperienceCandidates(policyDir, { status: 'draft' })
  assert(expListed.some((r) => r.id === answerDispatch.proposal?.experienceCandidateId), 'experience candidate listed')
  const conflict = detectExperienceConflictNote(
    [{ scenarioKey: expListed[0]!.scenarioKey, pathKey: 'admin' }],
    { scenarioKey: expListed[0]!.scenarioKey, pathKey: 'rag' }
  )
  assert(conflict?.includes('path 冲突'), 'experience conflict detect')

  const { promoteExperienceCandidateById } = await import(
    '../../../server/graph/core/unifiedLearning/promoteFromFeedback'
  )
  const expPromote = await promoteExperienceCandidateById(
    policyDir,
    answerDispatch.proposal!.experienceCandidateId!
  )
  assert(expPromote.ok, 'experience candidate promote ok')
  const expAfter = await listExperienceCandidates(policyDir, { status: 'promoted' })
  assert(expAfter.some((r) => r.id === answerDispatch.proposal?.experienceCandidateId), 'promoted experience')

  const orgDispatch = await dispatchMemoryMetaIntent(
    { kind: 'save_org_rule', confidence: 0.9, title: '无 citation 不出百分比', summary: '写成规则' },
    {
      policyDir,
      runId: 'run_org',
      question: '写成规则：无 citation 不出具体百分比',
      answer: '好的，已记为规则候选，待管理员审核。',
      intent: 'chat',
      planAgents: ['chat'],
      successScore: 0.9,
      needsClarify: false,
      failureCategory: 'success',
    }
  )
  assert(orgDispatch.dispatched, 'save_org_rule dispatched')
  assert(orgDispatch.proposal?.ruleCandidateId, 'org rule id on proposal')

  const disabled = await dispatchMemoryMetaIntent(
    { kind: 'save_org_rule', confidence: 0.9, title: 'x' },
    {
      policyDir,
      runId: 'run_off',
      question: '写成规则',
      answer: 'ok ok ok ok ok ok ok',
      intent: 'chat',
      planAgents: ['chat'],
      successScore: 0.9,
      needsClarify: false,
      failureCategory: 'success',
    }
  )
  // with MGR_RULE_CANDIDATE_ENABLED still 1 — already drafted above; just ensure none path for disabled env
  process.env.MGR_RULE_CANDIDATE_ENABLED = '0'
  const orgOff = await dispatchMemoryMetaIntent(
    { kind: 'save_org_rule', confidence: 0.9, title: 'y', summary: 'off' },
    {
      policyDir,
      runId: 'run_org_off',
      question: '写成规则 off',
      answer: 'ok ok ok ok ok ok ok',
      intent: 'chat',
      planAgents: ['chat'],
      successScore: 0.9,
      needsClarify: false,
      failureCategory: 'success',
    }
  )
  assert(orgOff.proposal?.status === 'skipped', 'rule candidate can be disabled')
  void disabled

  process.env.MGR_RULE_CANDIDATE_ENABLED = '1'
  const { setRuleCandidateStatus, getRuleCandidate } = await import(
    '../../../server/graph/core/memory/ruleCandidateStore'
  )
  const promote = await setRuleCandidateStatus(policyDir, ruleRow!.id, 'promoted')
  assert(promote.ok, 'promote rule ok')
  const after = await getRuleCandidate(policyDir, ruleRow!.id)
  assert(after?.status === 'promoted', 'promoted status')
  const reject = await setRuleCandidateStatus(policyDir, orgDispatch.proposal!.ruleCandidateId!, 'rejected')
  assert(reject.ok, 'reject rule ok')

  const { updateUserProfilePrefs } = await import('../../../server/graph/core/memory/userProfile')
  await updateUserProfilePrefs(policyDir, 'user_pref_conflict', { preferredAgents: ['rag', 'db'] }, 'default')
  const prefConflict = await dispatchMemoryMetaIntent(
    {
      kind: 'save_preference',
      confidence: 0.92,
      preferencePatch: { preferredAgents: ['admin'] },
    },
    {
      policyDir,
      runId: 'run_pref_conflict',
      userId: 'user_pref_conflict',
      question: '以后查数优先走 admin',
      answer: '好的，已记为偏好候选，待确认。',
      intent: 'admin',
      planAgents: ['admin'],
      successScore: 0.9,
      needsClarify: false,
      failureCategory: 'success',
    }
  )
  assert(prefConflict.dispatched, 'save_preference dispatched')
  assert(
    prefConflict.proposal?.note?.includes('专家偏好冲突'),
    'save_preference surfaces conflict note'
  )

  console.log('smoke:memory-meta-intent: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
