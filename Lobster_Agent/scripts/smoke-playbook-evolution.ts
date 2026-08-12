/**
 * Lobster playbook 门禁：shadow → verify → promote → rollback；默认不自动晋级。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LOBSTER_PLAYBOOK_EVOLUTION = '1'
process.env.LOBSTER_PLAYBOOK_AUTO_PROMOTE = '0'
process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE = '0'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lob-pb-evo-'))
process.env.LOBSTER_PLAYBOOK_DIR = dir

const {
  savePlaybookEvolved,
  listPlaybookShadows,
  promotePlaybookShadow,
  rollbackPlaybookActive,
  lookupEvolvedOrCache,
  verifyLobsterPlaybookStructure,
} = await import('../server/services/lobsterPlaybookEvolution')

const steps = [
  { op: 'goto', target: 'https://example.com' },
  { op: 'act', target: 'click export', done_when: 'download started' },
  { op: 'extract', target: 'result table' },
]

const gate = verifyLobsterPlaybookStructure({ host: 'example.com', plan_steps: steps as any })
assert.equal(gate.ok, true)

const shadow = savePlaybookEvolved({
  startUrl: 'https://example.com/app',
  taskKind: 'export',
  plan_steps: steps as any,
})
assert.ok(shadow)
assert.equal(shadow!.status, 'shadow')
assert.equal(listPlaybookShadows('shadow').length, 1)
assert.equal(listPlaybookShadows('active').length, 0)

// 未晋级时 lookup 应走 legacy（此处返回 null）
const before = lookupEvolvedOrCache({
  startUrl: 'https://example.com/app',
  taskKind: 'export',
  legacyLookup: () => null,
})
assert.equal(before, null)

const promoted = await promotePlaybookShadow(shadow!.key)
assert.equal(promoted.ok, true, promoted.reason || 'promote failed')
assert.ok(promoted.verify?.ok !== false)
assert.equal(listPlaybookShadows('active').length, 1)

const after = lookupEvolvedOrCache({
  startUrl: 'https://example.com/app',
  taskKind: 'export',
  legacyLookup: () => null,
})
assert.ok(after)
assert.equal(after!.key, shadow!.key)

const rb = rollbackPlaybookActive(shadow!.key)
assert.equal(rb.ok, true)
assert.ok(listPlaybookShadows('shadow').some((r) => r.key === shadow!.key))

fs.rmSync(dir, { recursive: true, force: true })
console.log('smoke-playbook-evolution: ok')
