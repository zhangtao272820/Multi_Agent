/**
 * form_fill 提交前字段摘要 HITL（动手 P3），不调 LLM / 不点网页。
 */
import assert from 'node:assert/strict'
import { buildFormFillSubmitHitlSummary } from '../server/services/formFillSubmitHitl'

const hitl = buildFormFillSubmitHitlSummary({
  fields: [
    { name: 'firstname', value: '张三', label: 'First name' },
    { name: 'lastname', value: '李四', label: 'Last name' }
  ],
  url: 'https://www.w3school.com.cn/html/html_forms.asp',
  defaultSubmit: false
})
assert.equal(hitl.needsHitl, true)
assert.equal(hitl.allowSubmit, true)
assert.ok(hitl.message.includes('张三'))
assert.ok(hitl.message.includes('确认'))

const empty = buildFormFillSubmitHitlSummary({ fields: [], defaultSubmit: false })
assert.equal(empty.allowSubmit, false)
assert.equal(empty.needsHitl, true)

const auto = buildFormFillSubmitHitlSummary({
  fields: [{ name: 'a', value: '1' }],
  defaultSubmit: true
})
assert.equal(auto.needsHitl, false)

console.log('smoke-form-fill-submit-hitl OK')
