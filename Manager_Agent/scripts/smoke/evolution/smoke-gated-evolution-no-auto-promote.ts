/**
 * 门禁进化：禁止无人值守自动晋级 + skill 可发现索引闭环 + batch/verify 契约。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  isExpertAutoPromoteAllowed,
  isUnverifiedPromoteAllowed,
  resolveCurateAutoPromote,
} from '../../../agent-repo-shared/evolutionPromotePolicy'
import { verifyBeforePromote } from '../../../agent-repo-shared/evolutionVerify'
import {
  formatLearnedSkillHints,
  normalizePromotableSkillId,
  recallLearnedSkills,
  upsertLearnedSkillIndex,
} from '../../../server/utils/skills/skillDiscoverIndex'
import {
  canSkipSkillBatchVerify,
  isSkillBatchPromoteEnabled,
} from '../../../server/utils/skills/skillDraftBatchPromote'
import { promoteSkillDraftContent } from '../../../server/utils/skills/skillDraftFromSuccess'

async function main() {
  // 1) 默认禁止专家自动晋级
  delete process.env.EVO_ALLOW_EXPERT_AUTO_PROMOTE
  delete process.env.EVO_ALLOW_UNVERIFIED_PROMOTE
  delete process.env.MGR_SKILL_BATCH_PROMOTE
  assert.equal(isExpertAutoPromoteAllowed({}), false)
  assert.equal(isUnverifiedPromoteAllowed({}), false)
  assert.equal(resolveCurateAutoPromote(true, {}), false)
  assert.equal(resolveCurateAutoPromote(false, {}), false)
  assert.equal(resolveCurateAutoPromote(undefined, {}), false)
  assert.equal(
    resolveCurateAutoPromote(true, { EVO_ALLOW_EXPERT_AUTO_PROMOTE: '1' } as NodeJS.ProcessEnv),
    true
  )

  // 1b) batch 默认关闭；skipVerify 须双开
  assert.equal(isSkillBatchPromoteEnabled({}), false)
  assert.equal(isSkillBatchPromoteEnabled({ MGR_SKILL_BATCH_PROMOTE: '1' } as NodeJS.ProcessEnv), true)
  assert.equal(canSkipSkillBatchVerify(true, {}), false)
  assert.equal(
    canSkipSkillBatchVerify(true, {
      EVO_ALLOW_EXPERT_AUTO_PROMOTE: '1',
      EVO_ALLOW_UNVERIFIED_PROMOTE: '1',
    } as NodeJS.ProcessEnv),
    true
  )

  // 1c) manager verify 结构门（关 online eval，避免依赖 PG 回归集）
  process.env.EVO_ONLINE_EVAL_GATE = '0'
  process.env.EVO_VERIFY_BEFORE_PROMOTE = '1'
  const mgrVerify = await verifyBeforePromote('manager', process.env)
  assert.equal(mgrVerify.ok, true, mgrVerify.reason || 'manager verify should pass structure gate')
  assert.ok(
    mgrVerify.checks.some((c) => c.id === 'skill_discover_index' && c.ok),
    'skill discover index check present'
  )

  // 2) skill id 归一：脏 slug → learned_<hash>
  const dirty = normalizePromotableSkillId('manager_很长的用户问句slug_不应该直接进热目录')
  assert.match(dirty, /^learned_[a-f0-9]{12}$/)
  assert.equal(normalizePromotableSkillId('intent_rag_nurse_ratio'), 'intent_rag_nurse_ratio')

  // 3) promote → 索引 → recall
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-skill-evo-'))
  const skillsDir = path.join(tmp, 'skills')
  const cwdPrev = process.cwd()
  try {
    process.chdir(tmp)
    const md = `# skill
> 从知识库查探视制度开放时间是几点

执行路径：\`rag\`
`
    const out = await promoteSkillDraftContent('manager_脏slug_测试问句', md, {
      skillsDir,
      sourceDraftId: 'draft_test',
    })
    assert.match(out.skillId, /^learned_/)
    const hits = await recallLearnedSkills('探视制度开放时间', { topK: 3, cwd: tmp })
    assert.ok(hits.length >= 1, 'promoted skill should be discoverable')
    assert.ok(formatLearnedSkillHints(hits).includes('已晋级技能提示'))
    await upsertLearnedSkillIndex(
      {
        skillId: 'learned_manual',
        question: '河西区老人数量',
        pathAgents: ['db'],
        playbookPath: path.join(skillsDir, 'learned_manual', 'skill.md'),
        promotedAt: new Date().toISOString(),
      },
      tmp
    )
    const hits2 = await recallLearnedSkills('河西区老人有多少', { cwd: tmp })
    assert.ok(hits2.some((h) => h.skillId === 'learned_manual'))
  } finally {
    process.chdir(cwdPrev)
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log('smoke-gated-evolution-no-auto-promote: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
