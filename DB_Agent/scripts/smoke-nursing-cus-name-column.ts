/**
 * 慢病/护理表明细姓名列：schema 含 cus_name 时须选中，不得误选不存在的 user_name。
 */
import { pickDetailNameColumn } from '../utils/schema_relations'
import type { TableSchemaMeta } from '../utils/schema_relations'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const nursingMeta = {
  name: 'remote_nursing_chronic',
  comment: '老年护理慢性病检测',
  columns: [
    { name: 'id', comment: '主键', dataType: 'int' },
    { name: 'cus_name', comment: '客户姓名', dataType: 'varchar' },
    { name: 'systolic_bp', comment: '收缩压', dataType: 'decimal' },
    { name: 'user_id', comment: '用户ID', dataType: 'int' },
  ],
} as TableSchemaMeta

assert(pickDetailNameColumn(nursingMeta) === 'cus_name', 'nursing table must pick cus_name')

const bothMeta = {
  name: 'mixed_person_log',
  comment: '',
  columns: [
    { name: 'cus_name', comment: '', dataType: 'varchar' },
    { name: 'user_name', comment: '', dataType: 'varchar' },
    { name: 'name', comment: '', dataType: 'varchar' },
  ],
} as TableSchemaMeta

assert(pickDetailNameColumn(bothMeta) === 'name', 'prefer generic name when present')

const onlyUser = {
  name: 'legacy_log',
  comment: '',
  columns: [{ name: 'user_name', comment: '姓名', dataType: 'varchar' }],
} as TableSchemaMeta

assert(pickDetailNameColumn(onlyUser) === 'user_name', 'fallback to user_name when only option')

console.log('smoke: nursing cus_name column ok')
