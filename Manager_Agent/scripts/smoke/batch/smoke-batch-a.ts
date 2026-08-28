/**
 * 批次 A 回归：P1-2b / P1-7 / P1-8 / P1-10 子句灰度
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { rolloutHit, sessionBucket } from '../../../server/graph/core/evolution/featureRollout'
import { isDbChartShortcutEnabled, shouldUseDbChartShortcut } from '../../../server/graph/core/plan/planShortcuts'
import {
  shouldSkipRagRelevanceRefine,
  shouldTreatRagAsMiss,
  ragJudgeFalseNegativeOverride
} from '../../../server/graph/core/rag/ragRetrievePolicy'
import {
  isClauseDecomposeEnabled,
  isClauseDecomposeForcedOff
} from '../../../server/graph/core/routing/clauses'
import {
  dedupeRepeatedRagBlocks,
  ragPassthroughHasSubstantiveAnswer,
  resolveRagPassthroughText,
} from '#agent-shared/deterministicPassthrough'
import {
  listSkillDrafts,
  promoteSkillDraft,
  writeSkillDraft
} from '../../../server/utils/skills/skillDraftFromSuccess'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

// P1-2b: DB 快捷出图默认开
delete process.env.MANAGER_DB_CHART_SHORTCUT
assert(isDbChartShortcutEnabled(), 'db chart shortcut default on')
assert(
  shouldUseDbChartShortcut({
    intent: 'multi',
    question: '近7天 Top5 销售柱状图',
    constraints: { timeHints: [], subjectHints: [], wantsVisualize: true, wantsReport: false },
    probe: { db: { matched: true, tables: ['orders'] } },
    allowedAgents: ['db', 'visualize'],
    sessionId: 'sess-batch-a'
  }),
  'db chart shortcut matches by default'
)
process.env.MANAGER_DB_CHART_SHORTCUT = '0'
assert(!isDbChartShortcutEnabled(), 'db chart shortcut off when env=0')
delete process.env.MANAGER_DB_CHART_SHORTCUT

// P1-7: RAG 假阴性治理
assert(!shouldTreatRagAsMiss('暂未找到', 2), 'evidence blocks miss')
assert(shouldTreatRagAsMiss('暂未找到', 0), 'no evidence still miss')
const contradictoryRag =
  '文档里暂未找到关于养老机构护理员补贴标准的具体信息。参考：制度文件.docx\n\n养老机构护理员岗位补贴标准为每人每月800元，夜班津贴60元。'
const ragEvidence = [
  {
    kind: 'rag',
    hits: 2,
    citations: [{ source: '制度文件.docx', excerpt: '护理员岗位补贴标准为每人每月800元' }],
  },
]
const normalized = resolveRagPassthroughText({ text: contradictoryRag, evidence: ragEvidence })
assert(!normalized.includes('暂未找到'), 'strip miss lead when evidence exists')
assert(normalized.includes('800'), 'keep substantive subsidy facts')
assert(
  ragPassthroughHasSubstantiveAnswer({ text: contradictoryRag, evidence: ragEvidence }),
  'substantive after normalize'
)
const duped = `${normalized}\n\n${normalized}`
assert(dedupeRepeatedRagBlocks(duped).split('\n\n').length === 1, 'dedupe repeated rag blocks')
assert(
  shouldSkipRagRelevanceRefine(
    { hits: 1, citations: [{ title: 'a' }] },
    '根据知识库文档说明，探视制度为工作日下午两点至四点，家属需登记后进入。'
  ),
  'skip judge when evidence+answer'
)
assert(
  ragJudgeFalseNegativeOverride(
    { relevant: false },
    { hits: 2, citations: [{}] },
    '根据知识库文档，探视时间为工作日下午两点至四点，家属需登记后进入病区。'
  ),
  'override judge false negative'
)

// P1-8: Skill promote 工作流
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-promote-'))
await writeSkillDraft(
  { agent: 'db', question: 'Top5销售', hints: ['probe first'] },
  { draftsDir: tmp }
)
const listed = await listSkillDrafts({ draftsDir: tmp })
assert(listed.length === 1, 'list drafts')
const skillsTmp = path.join(tmp, 'skills-out')
const promoted = await promoteSkillDraft(listed[0]!.skillId, { draftsDir: tmp, skillsDir: skillsTmp })
assert(promoted.playbookPath.includes('skills-out'), 'promoted path')
await fs.rm(tmp, { recursive: true, force: true })

// P1-10: 子句灰度 25%
delete process.env.MANAGER_CLAUSE_DECOMPOSE
delete process.env.MANAGER_CLAUSE_DECOMPOSE_PCT
assert(!isClauseDecomposeForcedOff(), 'not forced off')
const bucket = sessionBucket('gray-rollout-test-session')
const expectRollout = rolloutHit('MANAGER_CLAUSE_DECOMPOSE_PCT', 'gray-rollout-test-session', 25)
assert(isClauseDecomposeEnabled('gray-rollout-test-session') === expectRollout, 'clause rollout consistent')
process.env.MANAGER_CLAUSE_DECOMPOSE = '0'
assert(!isClauseDecomposeEnabled('any'), 'clause force off')
delete process.env.MANAGER_CLAUSE_DECOMPOSE

console.log(`smoke: batch-a ok (bucket=${bucket})`)
