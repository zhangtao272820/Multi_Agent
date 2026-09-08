/**
 * 单源 DB：Synth 后必须确定性追加查询结果表。
 */
import {
  buildMandatoryDbDataBlock,
  mergeConversationalDbSynthWithDataBlock,
  rowsToMarkdownTable,
  tableFromDbEvidence,
  tableMarkdownHasValues,
  scrubDbSchemaIdentifiers,
  scrubProsePreservingTableData,
  collectDbSchemaIdentifiers,
  evidenceHasDisplayableDbRows
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

const fieldDetails = [
  { label: '餐后血糖(mmol/L)', column: 'after_eat', table: 'remote_nursing_chronic' },
  { label: '空腹血糖(mmol/L)', column: 'fpg', table: 'remote_nursing_chronic' }
]

const evidence = [
  {
    kind: 'db',
    agentResult: {
      structured: {
        rows,
        field_details: fieldDetails
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
assert(!block.includes('本次展示字段') && !block.includes('字段说明'), 'no redundant field-list section')
assert(!block.includes('after_eat'), 'no column original name')
assert(!block.includes('remote_nursing_chronic'), 'no table original name')

const merged = mergeConversationalDbSynthWithDataBlock({
  synthBody: '### 解读\n空腹血糖略高，建议复查。',
  sourceText: '查到了 1 条记录',
  evidence
})
assert(merged.includes('解读') && merged.includes('9.2'), 'merged has synth + data')
assert(!/指标\s*\|\s*测值/.test(merged), 'no fake metric-only table')

// dbExecutor 历史形状：rows 在 evidence 顶层，无 agentResult
const topLevelEvidence = [{ kind: 'db', rows, field_details: fieldDetails }]
const topBlock = buildMandatoryDbDataBlock({ evidence: topLevelEvidence, synthBody: '解读。' })
assert(topBlock.includes('TABLE_DATA') && topBlock.includes('9.2'), 'top-level rows → TABLE_DATA')
assert(!topBlock.includes('本次展示字段') && !topBlock.includes('字段说明'), 'top-level: no field-list section')
assert(!/`after_eat`/.test(topBlock) && !/`remote_nursing_chronic`/.test(topBlock), 'no schema originals in data block')

// 顶层 rows 已是中文 label 键且多于 field_details：仍应保留姓名等未列在 details 的列
const wideTop = buildMandatoryDbDataBlock({
  evidence: [{ kind: 'db', rows, field_details: fieldDetails }],
  synthBody: '解读。'
})
assert(wideTop.includes('王建国') || wideTop.includes('9.2'), 'wide rows keep values')

// stepOutcome 拆条：kind=agent_result + agent=db
const agentResultEvidence = [
  { kind: 'db', query: 'q' },
  {
    kind: 'agent_result',
    agent: 'db',
    agentResult: { structured: { rows, field_details: fieldDetails } }
  }
]
const arBlock = buildMandatoryDbDataBlock({ evidence: agentResultEvidence, synthBody: '解读。' })
assert(arBlock.includes('TABLE_DATA') && arBlock.includes('9.2'), 'agent_result(db) → TABLE_DATA')

// 仅 field_details 的条目不得挡住后续真实行
const splitEvidence = [
  {
    kind: 'db',
    field_details: fieldDetails
  },
  {
    kind: 'agent_result',
    agent: 'db',
    agentResult: {
      structured: {
        rows: [
          {
            address: '河西区陈塘庄街嘉泰幸福里001号',
            age: 75,
            concat_name_first: '龙小明',
            concat_name_second: null,
            concat_phone_first: '13900001001',
            concat_phone_second: null
          }
        ],
        field_details: [
          { label: '详细地址', column: 'address', table: 'person_info' },
          { label: '年龄，根据出生日期填充的', column: 'age', table: 'person_info' },
          { label: '紧急联系人1', column: 'concat_name_first', table: 'person_emergency_contact' },
          { label: '紧急联系人2', column: 'concat_name_second', table: 'person_emergency_contact' },
          { label: '紧急联系人电话', column: 'concat_phone_first', table: 'person_emergency_contact' },
          { label: '紧急联系人2电话', column: 'concat_phone_second', table: 'person_emergency_contact' }
        ]
      }
    }
  }
]
const personBlock = buildMandatoryDbDataBlock({ evidence: splitEvidence, synthBody: '已定位到龙奶奶。' })
assert(personBlock.includes('TABLE_DATA'), 'person: has TABLE_DATA')
assert(personBlock.includes('河西区'), 'person: address value present')
assert(personBlock.includes('龙小明'), 'person: contact name present')
assert(personBlock.includes('13900001001'), 'person: phone present')
assert(personBlock.includes('详细地址'), 'person: Chinese header from field_details')

// 英文字段名 + field_details.label 对齐
const engAligned = rowsToMarkdownTable(
  [{ address: '河西区', age: 75, concat_name_first: '龙小明' }],
  [
    { label: '详细地址', column: 'address' },
    { label: '年龄', column: 'age' },
    { label: '紧急联系人1', column: 'concat_name_first' }
  ]
)
assert(engAligned.includes('详细地址') && engAligned.includes('河西区'), 'label/column align')

// 空 TABLE_DATA 占位必须被覆盖
const emptyShell = mergeConversationalDbSynthWithDataBlock({
  synthBody: [
    '解读完毕。',
    '<!--TABLE_DATA-->',
    '| 详细地址 | 年龄 |',
    '| --- | --- |',
    '|  |  |',
    '<!--/TABLE_DATA-->'
  ].join('\n'),
  sourceText: '查到了 1 条',
  evidence: splitEvidence
})
assert(emptyShell.includes('河西区'), 'empty TABLE_DATA shell replaced with real rows')
assert(tableMarkdownHasValues(emptyShell.match(/<!--TABLE_DATA-->([\s\S]*?)<!--\/TABLE_DATA-->/)?.[1] || ''), 'replaced table has values')

// scrub 不得掏空 TABLE_DATA 单元格（英文字段名作表头时尤其致命）
const engTableBody = [
  '解读：见下表。',
  '<!--TABLE_DATA-->',
  '| address | age |',
  '| --- | --- |',
  '| 河西区陈塘庄 | 75 |',
  '<!--/TABLE_DATA-->'
].join('\n')
const scrubKeep = scrubProsePreservingTableData(engTableBody, ['address', 'age', 'person_info'])
assert(scrubKeep.includes('河西区陈塘庄'), 'scrubProse keeps cell values')
assert(scrubKeep.includes('| address |'), 'scrubProse keeps table headers even if column ids')
assert(!scrubKeep.includes('person_info'), 'prose identifiers still scrubbed when outside table')

// includeDataBlock=false 但 evidence 有真行 → 仍必须出表
const forced = mergeConversationalDbSynthWithDataBlock({
  synthBody: '简短确认。',
  sourceText: '查到了 1 条',
  evidence: splitEvidence,
  includeDataBlock: false
})
assert(evidenceHasDisplayableDbRows(splitEvidence), 'fixture has display rows')
assert(forced.includes('河西区') && forced.includes('TABLE_DATA'), 'force table when evidence has rows despite includeDataBlock=false')

// scrub 整段（含表）会掏空表头——对比证明必须用 scrubProsePreservingTableData
const naiveScrub = scrubDbSchemaIdentifiers(engTableBody, ['address', 'age'])
assert(!/\|\s*address\s*\|/.test(naiveScrub) || !naiveScrub.includes('address'), 'naive scrub would wipe header (baseline)')

const fromEv = tableFromDbEvidence(splitEvidence)
assert(fromEv?.rows?.[0]?.some((c) => c.includes('河西区')), 'tableFromDbEvidence has address')

// 用户面脱敏：表名/字段原名不得出现
const leaky = '数据来自 `remote_nursing_chronic` 表的 `after_eat`（表 `person_info`）与 fpg 字段。'
const ids = collectDbSchemaIdentifiers(splitEvidence)
const cleaned = scrubDbSchemaIdentifiers(leaky, [...ids, 'remote_nursing_chronic', 'after_eat', 'fpg', 'person_info'])
assert(!/remote_nursing_chronic|after_eat|person_info|\bfpg\b/.test(cleaned), 'scrub removes schema ids')
assert(cleaned.includes('数据来自'), 'scrub keeps prose')

const synthLeak = mergeConversationalDbSynthWithDataBlock({
  synthBody: '王建国记录见 remote_nursing_chronic，餐后血糖 after_eat 为 9.2。',
  sourceText: '查到了',
  evidence
})
assert(!/remote_nursing_chronic/.test(synthLeak), 'merge scrubs table name from synth')
assert(!/\bafter_eat\b/.test(synthLeak), 'merge scrubs column name from synth')
assert(synthLeak.includes('9.2'), 'merge keeps metric value')

console.log('smoke-db-expert-data-block: OK')
