/**
 * 平面隔离：独立端召回排除 manager_orchestrated 联邦源。
 * CI：npm run smoke:experience-plane-isolation
 */
import assert from 'node:assert/strict'
import {
  experienceSyncSource,
  experienceSyncSourcePlane,
  mayRecallExperienceRow
} from '#agent-shared/experienceBridgeContract'
import {
  resolveExperienceSourcePlane,
  shouldRecallExperienceForPlane
} from '#agent-shared/experienceRecallPolicy'

function main() {
  const fedSource = experienceSyncSource({ force: true })
  const fedPlane = experienceSyncSourcePlane()
  assert.equal(fedPlane, 'manager_orchestrated')
  assert.ok(fedSource.includes('manager_feedback') || fedSource.includes('manager_finalize'))

  const fedRow = { source: fedSource, source_plane: fedPlane, userConfirmed: true, status: 'confirmed' }
  const localRow = { source: 'db_local_success', source_plane: 'standalone', userConfirmed: true, status: 'confirmed' }
  const legacyLocal = { hint: 'old row without source' } as { source?: string }

  assert.equal(resolveExperienceSourcePlane(fedRow), 'manager_orchestrated')
  assert.equal(resolveExperienceSourcePlane(localRow), 'standalone')

  assert.equal(shouldRecallExperienceForPlane('standalone', fedRow), false)
  assert.equal(shouldRecallExperienceForPlane('standalone', localRow), true)
  assert.equal(shouldRecallExperienceForPlane('orchestrated', fedRow), true)
  assert.equal(shouldRecallExperienceForPlane('any', fedRow), true)

  assert.equal(mayRecallExperienceRow(fedRow, process.env, 'standalone'), false)
  assert.equal(mayRecallExperienceRow(localRow, process.env, 'standalone'), true)
  assert.equal(mayRecallExperienceRow(fedRow, process.env, 'orchestrated'), true)

  assert.equal(shouldRecallExperienceForPlane('standalone', legacyLocal), true)

  console.log('smoke-experience-plane-isolation: OK')
}

main()
