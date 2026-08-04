/**
 * J3：Lobster AgentResult — 页面 Observation 一律 untrusted；failureType ↔ error_code。
 * 离线纯函数，不启浏览器。
 */
import { buildGuiAgentResult } from '../server/utils/agent_result'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

{
  const okish = buildGuiAgentResult({
    task: '打开示例页并提取标题',
    status: 'done',
    finalUrl: 'https://example.com/',
    answer: 'Example Domain',
    data: [{ via: 'extract', url: 'https://example.com/', items: [{ title: 'Example Domain' }] }],
    stats: { stepCount: 2 },
  })
  assert(okish.structured?.content_trust === 'untrusted', 'success path still untrusted')
  assert(okish.structured?.content_trust_source === 'gui', 'gui source')
  assert(okish.needs_clarify === false, 'handoff ≠ clarify')
}

{
  const captcha = buildGuiAgentResult({
    task: '登录后台',
    status: 'error',
    failureType: 'captcha',
    error_code: 'captcha',
    finalUrl: 'https://example.com/login',
    answer: '需要验证码',
  })
  assert(captcha.ok === false, 'captcha not ok')
  assert(captcha.error_code === 'captcha' || captcha.structured?.failureType === 'captcha', 'captcha code')
  assert(captcha.needs_clarify === false, 'captcha is HITL handoff not clarify')
  assert(captcha.structured?.content_trust === 'untrusted', 'captcha obs untrusted')
}

{
  const network = buildGuiAgentResult({
    task: '打开坏站',
    status: 'error',
    failureType: 'network',
    error_code: 'network',
    answer: 'net::ERR_NAME_NOT_RESOLVED',
  })
  assert(network.ok === false, 'network not ok')
  assert(
    network.error_code === 'network' || String(network.structured?.failureType || '') === 'network',
    'network taxonomy',
  )
  assert(network.structured?.content_trust === 'untrusted', 'network obs untrusted')
}

{
  const empty = buildGuiAgentResult({
    task: '抽取列表',
    status: 'done',
    data: [],
    stats: { stepCount: 0 },
  })
  assert(empty.ok === false, 'empty payload not ok')
  assert(empty.error_code, 'empty must have error_code')
  assert(empty.structured?.content_trust === 'untrusted', 'empty still untrusted')
}

console.log('smoke-agent-result-trust: OK')
