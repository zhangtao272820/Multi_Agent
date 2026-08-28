/**
 * 单源 DB：Synth 后必须确定性追加查询结果表。
 */
import {
  buildMandatoryDbDataBlock,
  mergeConversationalDbSynthWithDataBlock,
  rowsToMarkdownTable
} from '../../../server/graph/core/output/dbExpertDataBlock'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const rows = [
  {
    '餐后血糖(mmol/L)': 9.2,
    客户姓名: '王建国',
    '舒张压(mmhg)': 85,
    '空腹血糖(mmol/L)': 6.8,
    '糖化血红蛋白(%)': 6.2,
    '心率(次/分钟)': 72
  }
]

const evidence = [
  {
    kind: 'db',
    agentResult: {
      structured: {
        rows,
        field_details: [
          { label: '餐后血糖(mmol/L)', column: 'after_eat', table: 'remote_nursing_chronic' },
          { label: '空腹血糖(mmol/L)', column: 'fpg', table: 'remote_nursing_chronic' }
        ]
      }
    }
  }
]

const tableMd = rowsToMarkdownTable(rows)
assert(tableMd.includes('王建国'), 'table has name')
assert(tableMd.includes('9.2'), 'table has glucose')

const block = buildMandatoryDbDataBlock({ evidence, synthBody: '解读：血糖偏高。' })
assert(block.includes('TABLE_DATA'), 'block has TABLE_DATA')
assert(block.includes('9.2') && block.includes('6.8'), 'block has all metrics')
assert(block.includes('字段说明'), 'block has field mapping')

const merged = mergeConversationalDbSynthWithDataBlock({
  synthBody: '### 解读\n空腹血糖略高，建议复查。',
  sourceText: '查到了 1 条记录',
  evidence
})
assert(merged.includes('解读') && merged.includes('9.2'), 'merged has synth + data')
assert(!/指标\s*\|\s*测值/.test(merged), 'no fake metric-only table')

console.log('smoke-db-expert-data-block: OK')
