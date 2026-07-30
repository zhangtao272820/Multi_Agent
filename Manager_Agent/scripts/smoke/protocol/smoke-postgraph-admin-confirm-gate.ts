/**
 * GUI 成功后不得误弹 Admin「个人事务」确认；确认续跑须带 resumeAdminConfirm 通道。
 */
import assert from 'node:assert/strict'
import {
  shouldPauseForPostGraphAdminConfirm,
  extractKnownAdminPendingOps,
  isHumanConfirmClarification,
} from '../../../server/api/manager-ws/wsSessionHelpers'

// GUI 成功文案含任意 ident[n]（如 item[1]）不得触发
const guiFinal = `已打开菜鸟教程并进入第一篇。
标题：Python3 教程
链接：https://www.runoob.com/python3/python3-tutorial.html
条目 item[1] 已抽取。`
assert.equal(
  shouldPauseForPostGraphAdminConfirm({
    intent: 'gui',
    plan: [{ agent: 'gui' }],
    finalText: guiFinal,
    results: { gui: guiFinal },
    evaluation: { recommendation: 'accept' },
  }),
  false,
  'gui-only success must not pause for admin confirm',
)

assert.equal(
  extractKnownAdminPendingOps('条目 item[1] 与 step[2]').length,
  0,
  'non-admin tool[id] ignored',
)
assert.deepEqual(extractKnownAdminPendingOps('【待确认】add_event[1]'), ['add_event[1]'])

assert.equal(
  shouldPauseForPostGraphAdminConfirm({
    intent: 'admin',
    plan: [{ agent: 'admin' }],
    finalText: '需要确认',
    results: { admin: '【待确认】将添加会议提醒 add_event[1]' },
  }),
  true,
  'admin pending text must pause',
)

assert.equal(
  shouldPauseForPostGraphAdminConfirm({
    meta: {
      agentResult: {
        agent: 'admin',
        structured: { needs_human_confirm: true, pending_actions: [{ id: 1, tool: 'add_event' }] },
      },
    },
    results: { admin: '【待确认】' },
  }),
  true,
  'structural admin pending must pause',
)

assert.equal(
  shouldPauseForPostGraphAdminConfirm({
    meta: {
      agentResult: {
        agent: 'gui',
        structured: { pending_actions: [{ id: 1 }] },
      },
    },
    intent: 'gui',
    results: { gui: guiFinal },
  }),
  false,
  'gui agentResult pending_actions must not count as admin',
)

// 兼容旧 API
assert.equal(
  isHumanConfirmClarification({ results: { gui: guiFinal } }, guiFinal),
  false,
  'legacy isHumanConfirmClarification gui-safe',
)

console.log('smoke: post-graph admin confirm gate ok')
