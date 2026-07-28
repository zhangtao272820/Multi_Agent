/**
 * Critic 审计上下文 smoke：证据须注入 prompt，且与评估器一致时不应触发改道重试。
 * 含 admin 写成功契约：证据块展开 + override。
 * 含 GUI finalUrl+items=0：不得当作失败。
 */
import {
  criticRetryContradictsRunEvidence,
  formatEvidenceForCriticAudit,
  formatEvaluatorForCriticAudit,
  hasSuccessfulAdminWriteInRun,
  hasSuccessfulGuiBrowseInRun
} from '../../../server/graph/core/output/criticEvidence'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const results = {
  rag: '[事实1] 月收入：6000 月支出：5000 公积金：510 五险：560 [来源] 个人月收入.txt'
}
const evidence = [{ kind: 'rag', hits: 1, citations: [{ source: '个人月收入.txt' }] }]
const evaluation = {
  score: 1,
  hasDataEvidence: true,
  hasImplicitDataEvidence: true,
  recommendation: 'accept'
}

const auditBlock = formatEvidenceForCriticAudit({ evidence, results })
assert(auditBlock.includes('个人月收入.txt'), 'critic audit includes citation')
assert(auditBlock.includes('6000'), 'critic audit includes rag output numbers')

const evalBlock = formatEvaluatorForCriticAudit(evaluation)
assert(evalBlock.includes('dataEvidence=yes'), 'critic audit includes evaluator')

const shouldIgnoreRetry = criticRetryContradictsRunEvidence({ evaluation })
assert(shouldIgnoreRetry, 'good evidence + evaluator should override critic retry')

const adminResults = {
  admin: '已添加日程并设置提醒：项目周会 (2026年7月29日 10:00)'
}
const adminEvidence = [
  {
    kind: 'admin',
    query: '添加日程：项目周会',
    pendingDecide: true,
    agentResult: { ok: true, agent: 'admin', answer: adminResults.admin }
  }
]
const adminAudit = formatEvidenceForCriticAudit({ evidence: adminEvidence, results: adminResults })
assert(adminAudit.includes('admin：ok=yes'), 'admin evidence expands ok')
assert(adminAudit.includes('已添加日程'), 'admin evidence includes sub-output')
assert(adminAudit.includes('pendingDecide=yes'), 'admin evidence includes pendingDecide')

assert(
  hasSuccessfulAdminWriteInRun({ results: adminResults, evidence: adminEvidence }),
  'successful admin write should be detected'
)

const adminEval = {
  score: 1,
  hasDataEvidence: true,
  hasImplicitDataEvidence: true,
  recommendation: 'accept'
}
assert(
  criticRetryContradictsRunEvidence({ evaluation: adminEval }),
  'admin-only write with dataEvidence should override critic retry'
)

const failedAdmin = {
  results: { admin: '【待确认】将创建日程：项目周会' },
  evidence: [
    {
      kind: 'admin',
      query: '添加日程',
      agentResult: { ok: false, agent: 'admin', answer: '【待确认】将创建日程：项目周会' }
    }
  ]
}
assert(
  !hasSuccessfulAdminWriteInRun(failedAdmin),
  'pending/failed admin must not count as successful write'
)

const adminFallbackOnly = formatEvidenceForCriticAudit({
  evidence: [],
  results: { admin: '已添加日程并设置提醒：项目周会' }
})
assert(
  adminFallbackOnly.includes('admin 子输出（无独立 evidence 行）'),
  'admin results without evidence row still appear in audit block'
)

{
  const guiResults = {
    gui: '标题：菜鸟教程\n链接：https://www.runoob.com/'
  }
  const guiEvidence = [
    {
      kind: 'gui',
      itemCount: 0,
      finalUrl: 'https://www.runoob.com/',
      hasScreenshot: true,
      agentResult: {
        ok: true,
        agent: 'gui',
        answer: guiResults.gui,
        structured: { finalUrl: 'https://www.runoob.com/' },
        sources: [{ type: 'url', ref: 'https://www.runoob.com/' }]
      }
    }
  ]
  const guiAudit = formatEvidenceForCriticAudit({ evidence: guiEvidence, results: guiResults })
  assert(guiAudit.includes('gui：ok=yes'), 'gui evidence expands ok')
  assert(guiAudit.includes('finalUrl=https://www.runoob.com/'), 'gui evidence includes finalUrl')
  assert(guiAudit.includes('items=0'), 'gui may have items=0')
  assert(guiAudit.includes('items=0 不等于 GUI 失败'), 'gui audit explains items=0')
  assert(
    hasSuccessfulGuiBrowseInRun({ results: guiResults, evidence: guiEvidence }),
    'finalUrl + items=0 must count as successful browse'
  )
}

console.log('smoke: critic evidence ok')
