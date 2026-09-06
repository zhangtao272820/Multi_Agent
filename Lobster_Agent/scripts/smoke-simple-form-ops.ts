/**
 * SimpleOps form_fill：fill+value 校验 + verify 不打 navigation_unverified（无浏览器）
 */
import assert from 'node:assert/strict'
import { playwrightFillFormFields } from '../server/services/stagehandPlaywrightBridge'
import { assembleDefaultSuccessCriteria, evaluateSuccessCriteria } from '../server/services/lobsterSuccessCriteria'
import { extractFormFieldsHeuristic } from '../server/services/lobsterFormFill'
import {
  collectFormFilledEvidence,
  isFormFillBrowseTask,
  verifyLobsterRunResult,
} from '../../shared/lobsterRunVerifyLite'

function makeMockPage(store: Record<string, string>) {
  const makeLoc = (sel: string) => {
    const key =
      sel.includes('fname') || /First name/i.test(sel) || sel === 'first_name'
        ? 'fname'
        : sel.includes('lname') || /Last name/i.test(sel) || sel === 'last_name'
          ? 'lname'
          : sel
    return {
      first() {
        return this
      },
      async fill(v: string) {
        store[key] = v
      },
      async inputValue() {
        return store[key] || ''
      },
      async getAttribute(name: string) {
        return name === 'value' ? store[key] || '' : null
      },
    }
  }
  return {
    locator(sel: string) {
      return makeLoc(sel)
    },
    getByLabel(label: string) {
      return makeLoc(label)
    },
    getByRole(_role: string, opts?: { name?: string }) {
      return makeLoc(String(opts?.name || ''))
    },
  }
}

const store: Record<string, string> = {}
const stagehand = { page: makeMockPage(store) }
const filled = await playwrightFillFormFields(stagehand, {
  fields: [
    { key: 'first_name', value: '张三' },
    { key: 'last_name', value: '李四' },
  ],
  recipeFields: [
    { key: 'first_name', selectors: ['input#fname'], aliases: ['First name'] },
    { key: 'last_name', selectors: ['input#lname'], aliases: ['Last name'] },
  ],
})
assert.equal(filled.ok, true, 'mock fill ok')
assert.equal(store.fname, '张三')
assert.equal(store.lname, '李四')
assert.equal(filled.filled.length, 2)

const criteria = assembleDefaultSuccessCriteria({ taskKind: 'form_fill' })
assert.equal(criteria.filledMin, 1)
assert.equal(criteria.extractMin, undefined)
const evalOk = evaluateSuccessCriteria({
  url: 'https://www.w3school.com.cn/html/html_forms.asp',
  filledCount: 2,
  extractCount: 0,
  criteria,
})
assert.equal(evalOk.ok, true, 'filledMin met')
const evalFail = evaluateSuccessCriteria({
  url: 'https://www.w3school.com.cn/html/html_forms.asp',
  filledCount: 0,
  extractCount: 1,
  criteria,
})
assert.equal(evalFail.ok, false, 'title alone must not pass form_fill')

const task =
  '打开 https://www.w3school.com.cn/html/html_forms.asp ，First name 填张三，Last name 填李四，不要点 Submit。'
assert.equal(isFormFillBrowseTask(task), true)
const heur = extractFormFieldsHeuristic(task)
assert.equal(heur.find((f) => f.key === 'first_name')?.value, '张三')

// login 字段启发式 + 密码脱敏 + password fill（mock）
import {
  isSensitiveFormKey,
  redactFormFieldsForLog,
} from '../server/services/lobsterFormFill'
const loginTask =
  '打开 https://the-internet.herokuapp.com/login ，用户名填 tomsmith，密码填 SuperSecretPassword!，提交登录。'
const loginHeur = extractFormFieldsHeuristic(loginTask)
assert.equal(loginHeur.find((f) => f.key === 'username')?.value, 'tomsmith')
assert.equal(loginHeur.find((f) => f.key === 'password')?.value, 'SuperSecretPassword!')
assert.equal(isSensitiveFormKey('password'), true)
const redacted = redactFormFieldsForLog(loginHeur)
assert.equal(redacted.find((f) => f.key === 'password')?.value, '***')

const loginStore: Record<string, string> = {}
const loginPage = {
  locator(sel: string) {
    const key =
      /password|type="password"|current-password/i.test(sel)
        ? 'password'
        : /username|user|autocomplete="username"/i.test(sel)
          ? 'username'
          : sel
    return {
      first() {
        return this
      },
      async fill(v: string) {
        loginStore[key] = v
      },
      async inputValue() {
        // 模拟部分站点 password 不可读
        return key === 'password' ? '' : loginStore[key] || ''
      },
      async getAttribute(name: string) {
        return name === 'value' ? (key === 'password' ? '' : loginStore[key] || '') : null
      },
    }
  },
  getByLabel(label: string) {
    return this.locator(label)
  },
  getByRole(_role: string, opts?: { name?: string }) {
    return this.locator(String(opts?.name || ''))
  },
  getByPlaceholder(ph: string) {
    return this.locator(ph)
  },
}
const loginFilled = await playwrightFillFormFields(
  { page: loginPage },
  {
    fields: [
      { key: 'username', value: 'tomsmith' },
      { key: 'password', value: 'SuperSecretPassword!' },
    ],
    recipeFields: [],
  },
)
assert.equal(loginFilled.ok, true, 'login mock fill ok')
assert.equal(loginStore.username, 'tomsmith')
assert.equal(loginStore.password, 'SuperSecretPassword!')

const okResult = {
  answer: '已填 first_name=张三；last_name=李四（未提交）',
  finalUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
  task_kind: 'form_fill',
  filled: [
    { key: 'first_name', value: '张三' },
    { key: 'last_name', value: '李四' },
  ],
  stats: { enginePath: 'playwright_form' },
  data: [{ filled: [{ key: 'first_name', value: '张三' }], items: [] }],
}
assert.equal(collectFormFilledEvidence(okResult).length, 2)
const vOk = verifyLobsterRunResult({ task, status: 'done', result: okResult })
assert.equal(vOk.ok, true, `form with filled must pass: ${vOk.reason}`)

const fakeNav = verifyLobsterRunResult({
  task,
  status: 'done',
  result: {
    ...okResult,
    failureType: 'navigation_unverified',
  },
})
assert.equal(fakeNav.ok, true, 'form_fill + filled must override false navigation_unverified')

const noFill = verifyLobsterRunResult({
  task,
  status: 'done',
  result: {
    answer: '标题：HTML 表单',
    finalUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
    task_kind: 'form_fill',
    items: [{ title: 'HTML 表单' }],
    stats: { enginePath: 'playwright_form' },
  },
})
assert.equal(noFill.ok, false, 'title-only form_fill must fail')
assert.notEqual(noFill.reason, 'navigation_unverified', 'must not use navigation_unverified for form')

import { buildFormFillClarifyMessage } from '../server/services/stagehandPlaywrightBridge'
const clarifyEmpty = buildFormFillClarifyMessage({
  reason: 'no_fields',
  requestedKeys: [],
  filledKeys: [],
  pageUrl: 'https://httpbin.org/forms/post',
})
assert.match(clarifyEmpty, /没有可映射的字段|补充要填的字段/)
const clarifyPartial = buildFormFillClarifyMessage({
  reason: 'element_not_found:email',
  requestedKeys: ['customer_name', 'email'],
  filledKeys: ['customer_name'],
  pageUrl: 'https://httpbin.org/forms/post',
})
assert.match(clarifyPartial, /未写入字段：email/)
assert.match(clarifyPartial, /element_not_found/)

import { playbookCacheKey, savePlaybook, lookupPlaybook } from '../server/services/lobsterPlaybookCache'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lob-pb-form-'))
process.env.LOBSTER_PLAYBOOK_DIR = pbDir
process.env.LOBSTER_PLAYBOOK_CACHE = '1'
const formKey = playbookCacheKey({
  startUrl: 'https://httpbin.org/forms/post',
  taskKind: 'form_fill',
  goals: { must_submit: false, must_leave_start: false },
})
const formKey2 = playbookCacheKey({
  startUrl: 'https://www.httpbin.org/forms/post',
  taskKind: 'form_fill',
  goals: { must_submit: false, must_leave_start: false },
})
assert.equal(formKey, formKey2, 'same host+kind+goals → same playbook key')
savePlaybook({
  startUrl: 'https://httpbin.org/forms/post',
  taskKind: 'form_fill',
  goals: { must_submit: false, must_leave_start: false },
  plan_steps: [
    { op: 'goto', target: 'https://httpbin.org/forms/post' },
    { op: 'type', target: 'custname' },
  ] as any,
})
const hit = lookupPlaybook({
  startUrl: 'https://httpbin.org/forms/post',
  taskKind: 'form_fill',
  goals: { must_submit: false, must_leave_start: false },
})
assert.ok(hit, 'form_fill playbook replay hit')
assert.equal(hit?.taskKind, 'form_fill')

console.log('smoke-simple-form-ops: PASS')
