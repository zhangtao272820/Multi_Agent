/**
 * pickRicher：有数 TABLE_DATA 不得被空壳盖掉（定稿闪烁根因）。
 */
import {
  pickRicherNarrativeWithAuxBlocks,
  pickRicherTableDataBlock,
  tableDataBlockHasValues
} from '../../../agent-repo-shared/auxBlocks'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const valued = [
  '<!--TABLE_DATA-->',
  '| 姓名 | 年龄 |',
  '| --- | --- |',
  '| 王建国 | 72 |',
  '<!--/TABLE_DATA-->'
].join('\n')

const emptyShell = [
  '<!--TABLE_DATA-->',
  '| 姓名 | 年龄 |',
  '| --- | --- |',
  '|  |  |',
  '<!--/TABLE_DATA-->'
].join('\n')

assert(tableDataBlockHasValues(valued), 'valued has cells')
assert(!tableDataBlockHasValues(emptyShell), 'empty shell has no cells')

const picked = pickRicherTableDataBlock(valued, emptyShell)
assert(picked && picked.includes('王建国'), 'prefer valued over empty shell')

const picked2 = pickRicherTableDataBlock(emptyShell, valued)
assert(picked2 && picked2.includes('王建国'), 'prefer valued even when secondary')

const streamed = `流式解读。\n\n${valued}`
const finalEmpty = `定稿解读更长一些用于抢叙事。\n\n${emptyShell}`
const merged = pickRicherNarrativeWithAuxBlocks(streamed, finalEmpty)
assert(merged.includes('王建国'), 'pickRicher keeps valued TABLE_DATA')
assert(!/\|\s*\|\s*\|/.test(merged.match(/<!--TABLE_DATA-->([\s\S]*?)<!--\/TABLE_DATA-->/)?.[1] || '') || merged.includes('72'), 'merged table has values')

console.log('smoke-pick-richer-table-data: OK')
