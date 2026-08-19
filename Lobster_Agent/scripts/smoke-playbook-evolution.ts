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
  supersedePlaybooksForRun,
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
  runId: 'run-smoke-1',
  sessionId: 'sess-smoke-1',
})
assert.ok(shadow)
assert.equal(shadow!.status, 'shadow')
assert.equal(shadow!.runId, 'run-smoke-1')
assert.equal(listPlaybookShadows('shadow').length, 1)
assert.equal(listPlaybookShadows('active').length, 0)

const voided = supersedePlaybooksForRun({ runId: 'run-smoke-1', reason: 'cancel' })
assert.equal(voided.voided >= 1, true)
assert.equal(listPlaybookShadows('shadow').length, 0, 'voided shadow excluded from list')

const shadow2 = savePlaybookEvolved({
  startUrl: 'https://example.com/app',
  taskKind: 'export',
  plan_steps: steps as any,
  runId: 'run-smoke-2',
})
assert.ok(shadow2)

// 未晋级时 lookup 应走 legacy（此处返回 null）
const before = lookupEvolvedOrCache({
  startUrl: 'https://example.com/app',
  taskKind: 'export',
  legacyLookup: () => null,
})
assert.equal(before, null)

const promoted = await promotePlaybookShadow(shadow2!.key)
assert.equal(promoted.ok, true, promoted.reason || 'promote failed')
assert.ok(promoted.verify?.ok !== false)
assert.equal(listPlaybookShadows('active').length, 1)

const after = lookupEvolvedOrCache({
  startUrl: 'https://example.com/app',
  taskKind: 'export',
  legacyLookup: () => null,
})
assert.ok(after)
assert.equal(after!.key, shadow2!.key)

const rb = rollbackPlaybookActive(shadow2!.key)
assert.equal(rb.ok, true)
assert.ok(listPlaybookShadows('shadow').some((r) => r.key === shadow2!.key))

fs.rmSync(dir, { recursive: true, force: true })
console.log('smoke-playbook-evolution: ok')
