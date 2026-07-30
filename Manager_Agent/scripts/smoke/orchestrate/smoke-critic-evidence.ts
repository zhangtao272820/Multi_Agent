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
    gui: '标题：HTML 教程\n链接：https://www.runoob.com/html/html-tutorial.html'
  }
  const guiEvidence = [
    {
      kind: 'gui',
      itemCount: 0,
      finalUrl: 'https://www.runoob.com/html/html-tutorial.html',
      hasScreenshot: true,
      agentResult: {
        ok: true,
        agent: 'gui',
        answer: guiResults.gui,
        structured: { finalUrl: 'https://www.runoob.com/html/html-tutorial.html' },
        sources: [{ type: 'url', ref: 'https://www.runoob.com/html/html-tutorial.html' }]
      }
    }
  ]
  const guiAudit = formatEvidenceForCriticAudit({ evidence: guiEvidence, results: guiResults })
  assert(guiAudit.includes('gui：ok=yes'), 'gui evidence expands ok')
  assert(guiAudit.includes('finalUrl='), 'gui evidence includes finalUrl')
  assert(guiAudit.includes('items=0'), 'gui may have items=0')
  assert(guiAudit.includes('agentResult.ok=true'), 'gui audit explains ok gate')
  assert(
    hasSuccessfulGuiBrowseInRun({ results: guiResults, evidence: guiEvidence }),
    'ok=true + detail url must count as successful browse'
  )

  const stuck = {
    results: { gui: '仍停留在起始页：https://www.runoob.com/' },
    evidence: [
      {
        kind: 'gui',
        failed: true,
        finalUrl: 'https://www.runoob.com/',
        hasScreenshot: true,
        agentResult: {
          ok: false,
          agent: 'gui',
          error_code: 'navigation_unverified',
          answer: '仍停留在起始页',
          structured: { finalUrl: 'https://www.runoob.com/', failureType: 'navigation_unverified' }
        }
      }
    ]
  }
  assert(
    !hasSuccessfulGuiBrowseInRun(stuck),
    'homepage screenshot + navigation_unverified must NOT count as success'
  )

  const chromeErr = {
    results: {
      gui: "标题：This site can't be reached\n链接：chrome-error://chromewebdata/",
    },
    evidence: [
      {
        kind: 'gui',
        finalUrl: 'chrome-error://chromewebdata/',
        agentResult: {
          ok: true,
          agent: 'gui',
          answer: "标题：This site can't be reached\n链接：chrome-error://chromewebdata/",
          structured: { finalUrl: 'chrome-error://chromewebdata/' },
        },
      },
    ],
  }
  assert(
    !hasSuccessfulGuiBrowseInRun(chromeErr),
    'chrome-error finalUrl must NOT count as successful browse',
  )
}

{
  // 先失败后成功：critic 须见最新成功行 ok=yes（非 first-wins 失败行）
  const guiResults = {
    gui: '标题：HTML 教程\n链接：https://www.runoob.com/html/html-tutorial.html'
  }
  const guiEvidence = [
    {
      kind: 'gui',
      failed: true,
      finalUrl: 'https://www.runoob.com/',
      agentResult: {
        ok: false,
        agent: 'gui',
        error_code: 'navigation_unverified',
        answer: '仍停留在起始页',
        structured: { finalUrl: 'https://www.runoob.com/', failureType: 'navigation_unverified' }
      }
    },
    {
      kind: 'gui',
      itemCount: 0,
      finalUrl: 'https://www.runoob.com/html/html-tutorial.html',
      hasScreenshot: true,
      agentResult: {
        ok: true,
        agent: 'gui',
        answer: guiResults.gui,
        structured: { finalUrl: 'https://www.runoob.com/html/html-tutorial.html' },
        sources: [{ type: 'url', ref: 'https://www.runoob.com/html/html-tutorial.html' }]
      }
    }
  ]
  const audit = formatEvidenceForCriticAudit({ evidence: guiEvidence, results: guiResults })
  assert(audit.includes('gui：ok=yes'), 'latest successful gui must win in critic audit')
  assert(audit.includes('html-tutorial.html'), 'audit finalUrl from success row')
  assert(
    hasSuccessfulGuiBrowseInRun({ results: guiResults, evidence: guiEvidence }),
    'fail-then-success must count as successful browse'
  )
  assert(
    criticRetryContradictsRunEvidence({
      evaluation: {
        score: 1,
        hasDataEvidence: true,
        hasImplicitDataEvidence: true,
        recommendation: 'accept'
      }
    }),
    'success + accept should override critic retry'
  )
}


console.log('smoke: critic evidence ok')
