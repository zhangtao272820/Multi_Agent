/**
 * 契约 smoke：撤回/重生作废学习信号与反馈 shadow patch（不调 LLM、不检索）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function main() {
  const prevCwd = process.cwd()
  const prevBackend = process.env.RAG_AGENT_STORAGE_BACKEND
  const root = mkdtempSync(join(tmpdir(), 'rag-supersede-'))
  process.chdir(root)
  process.env.RAG_AGENT_STORAGE_BACKEND = 'file'
  mkdirSync(join(root, '.data'), { recursive: true })

  try {
    const {
      persistRagLearningSignal,
      readRagLearningSignalsSync,
      supersedeRagLearningSignalsForRevision
    } = await import('../utils/learning_signal_store.ts')
    const {
      appendRagPromptPatch,
      listPromotablePatches,
      supersedeRagPromptPatchesForRevision
    } = await import('../server/utils/prompt_evolution.ts')

    const sid = 'sess_smoke_1'
    await persistRagLearningSignal({
      question: '公司年假怎么休',
      score: 1,
      at: new Date().toISOString(),
      path: 'document_query',
      sessionId: sid,
      userMessageIndex: 0,
      learnEligible: true
    })
    await persistRagLearningSignal({
      question: '加班怎么算',
      score: -1,
      at: new Date().toISOString(),
      path: 'document_query',
      sessionId: sid,
      userMessageIndex: 1,
      learnEligible: true
    })

    appendRagPromptPatch({
      stage: 'expansion',
      text: '类似「加班怎么算」的问法需生成更多同义检索词以提高召回。',
      source: 'feedback',
      sessionId: sid,
      userMessageIndex: 1
    })

    const before = readRagLearningSignalsSync(50)
    assert(before.length >= 2, 'active signals before supersede')

    const r1 = await supersedeRagLearningSignalsForRevision({
      sessionId: sid,
      userMessageIndex: 1,
      reason: 'regenerate'
    })
    assert(r1.superseded >= 1, 'regen supersedes same turn')
    const afterRegen = readRagLearningSignalsSync(50)
    assert(
      afterRegen.every((s) => !(s.sessionId === sid && s.userMessageIndex === 1)),
      'umidx 1 not in active prefs'
    )
    assert(
      afterRegen.some((s) => s.sessionId === sid && s.userMessageIndex === 0),
      'umidx 0 still active'
    )

    const pvoid = supersedeRagPromptPatchesForRevision({
      sessionId: sid,
      userMessageIndex: 1,
      reason: 'regenerate'
    })
    assert(pvoid.voided >= 1, 'feedback patches voided')
    assert(
      !listPromotablePatches(1).some((p) => p.sessionId === sid && p.userMessageIndex === 1 && !p.voided),
      'voided patch not promotable'
    )

    await persistRagLearningSignal({
      question: '新一轮问句',
      score: 1,
      at: new Date().toISOString(),
      sessionId: sid,
      userMessageIndex: 2
    })
    const w = await supersedeRagLearningSignalsForRevision({
      sessionId: sid,
      userMessageIndex: 0,
      fromUserMessageIndex: 0,
      reason: 'withdraw'
    })
    assert(w.superseded >= 1, 'withdraw supersedes from index')
    const left = readRagLearningSignalsSync(50).filter((s) => s.sessionId === sid)
    assert(left.length === 0, 'no active session signals after withdraw from 0')

    console.log('smoke-rag-learning-supersede: ok')
  } finally {
    process.chdir(prevCwd)
    if (prevBackend === undefined) delete process.env.RAG_AGENT_STORAGE_BACKEND
    else process.env.RAG_AGENT_STORAGE_BACKEND = prevBackend
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
