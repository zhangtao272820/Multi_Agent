/**
 * GUI 网络失败不得评满分：wrapGuiResult + evaluator + failed evidence
 */
import assert from 'node:assert/strict'
import { wrapGuiResult } from '../../../server/utils/agents/agentResult'
import { createEvaluatorNode } from '../../../server/graph/nodes/evaluator/createEvaluatorNode'
import {
  hasFailedGuiEvidenceInRun,
} from '../../../server/graph/core/runtime/guiTerminal'
import { hasSuccessfulGuiBrowseInRun } from '../../../server/graph/core/output/criticEvidence'

const dnsFailAnswer =
  '无法访问目标页面，域名解析失败。请检查连接是否正确或网络环境是否正常。页面：https://www.runoob.com/'

const wrapped = wrapGuiResult(dnsFailAnswer, {
  task: '打开 https://www.runoob.com/ ，点击第一个教程链接并提取标题',
  finalUrl: 'https://www.runoob.com/',
})
assert.equal(wrapped.ok, false, 'wrapGuiResult must not ok on DNS failure')
assert.equal(wrapped.error_code, 'network')
assert.equal(String(wrapped.structured?.failureType || ''), 'network')

const state = {
  intent: 'gui',
  final: dnsFailAnswer,
  results: { gui: dnsFailAnswer },
  evidence: [
    {
      kind: 'gui',
      failed: true,
      agentResult: wrapped,
      finalUrl: 'https://www.runoob.com/',
    },
  ],
  plan: [{ agent: 'gui' }],
  meta: {},
}

assert.equal(hasFailedGuiEvidenceInRun(state), true)
assert.equal(hasSuccessfulGuiBrowseInRun(state), false)

const evaluator = createEvaluatorNode({
  opts: { sendEvent: () => undefined },
  mergeMeta: (s, patch) => ({ ...(s?.meta || {}), ...patch }),
})
const out = await evaluator(state)
const score = Number(out.evaluation?.score ?? 1)
const hasData = Boolean(out.evaluation?.hasDataEvidence)
const rec = String(out.evaluation?.recommendation || '')
assert.ok(score < 0.65, `DNS failure score must be <0.65, got ${score}`)
assert.equal(hasData, false, 'DNS failure must not count as dataEvidence')
assert.ok(Number(out.evaluation?.errorCount ?? 0) >= 1, 'errorCount >= 1')
assert.ok(rec === 'retry' || rec === 'retry_if_possible', `recommend retry-ish, got ${rec}`)

console.log('smoke-gui-network-score: ok')
