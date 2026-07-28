/**
 * GUI 失败 repair 不得改道 db：终态停住 + 可恢复钉 gui + 空 plan fallback
 */
import assert from 'node:assert/strict'
import {
  detectGuiTerminalFailure,
  hasFailedGuiEvidenceInRun
} from '../../../server/graph/core/runtime/guiTerminal'
import { resolveEmptyPlanFallbackAgent } from '../../../server/graph/core/runtime/emptyPlanFallback'
import { createOptimizerNode } from '../../../server/graph/nodes/optimizer/createOptimizerNode'

function mockOpts() {
  const thoughts: string[] = []
  return {
    thoughts,
    opts: {
      sendEvent: (e: { event?: string; data?: unknown }) => {
        if (e?.event === 'thinking' && typeof e.data === 'string') thoughts.push(e.data)
      }
    }
  }
}

// --- 1) lobster_workflow_not_found → terminal ---
{
  const state = {
    intent: 'gui',
    results: {
      gui: 'GUI 自动化失败: lobster_workflow_not_found: navigate-and-extract-title'
    },
    evidence: [
      {
        kind: 'gui',
        agent: 'gui',
        failed: true,
        error: 'lobster_workflow_not_found: navigate-and-extract-title',
        agentResult: { ok: false, error_code: 'lobster_workflow_not_found' }
      }
    ],
    evaluation: {
      score: 0.48,
      recommendation: 'retry_if_possible',
      hasAnswer: true,
      hasDataEvidence: false,
      hasImplicitDataEvidence: false,
      visualizeIntegrityOk: true
    },
    fixQuery: '请按审计建议重试：补证据',
    fixIntent: 'multi',
    final: '',
    retryCount: 0,
    meta: {}
  }
  const hit = detectGuiTerminalFailure(state)
  assert.equal(hit.terminal, true, 'workflow_not_found must be terminal')
  assert.equal(hit.code, 'lobster_workflow_not_found')

  const { opts, thoughts } = mockOpts()
  const node = createOptimizerNode({ opts } as any)
  const out = await node(state)
  assert.equal(out.optimizer?.action, 'verifier', 'terminal must not fix')
  assert.notEqual(out.optimizer?.action, 'fix')
  assert.equal(out.optimizer?.reason, 'gui_terminal_no_repair')
  assert.equal(out.fixIntent, undefined)
  assert.equal(out.fixQuery, '')
  assert.equal((out.meta as any)?.guiTerminal, true)
  assert.ok(
    thoughts.some((t) => t.includes('gui_terminal_no_repair') || t.includes('优化决策')),
    'optimizer emits decision'
  )
  // 即使 sticky fixIntent=multi，终态后也不得再带着 multi 出去
  assert.notEqual(out.fixIntent, 'multi')
}

// --- 2) 可恢复 GUI 失败：preferredFixIntent / invent-fix 钉 gui ---
{
  const state = {
    intent: 'gui',
    results: { gui: '页面超时，请重试' },
    evidence: [
      {
        kind: 'gui',
        agent: 'gui',
        failed: true,
        error: 'timeout',
        agentResult: { ok: false }
      }
    ],
    evaluation: {
      score: 0.48,
      recommendation: 'retry_if_possible',
      hasAnswer: false,
      hasDataEvidence: false,
      hasImplicitDataEvidence: false,
      visualizeIntegrityOk: true
    },
    final: '',
    retryCount: 0,
    meta: {}
  }
  assert.equal(detectGuiTerminalFailure(state).terminal, false)
  assert.equal(hasFailedGuiEvidenceInRun(state), true)

  const { opts } = mockOpts()
  const node = createOptimizerNode({ opts } as any)
  const out = await node(state)
  assert.equal(out.optimizer?.action, 'fix', 'recoverable gui may repair')
  assert.equal(out.fixIntent, 'gui', 'invent-fix must pin gui, not multi/db')
  assert.notEqual(out.fixIntent, 'db')
  assert.notEqual(out.fixIntent, 'multi')
}

// --- 3) 空 plan + intent=gui → fallback gui，不是 db ---
{
  assert.equal(
    resolveEmptyPlanFallbackAgent({ intent: 'gui', evidence: [] }),
    'gui'
  )
  assert.equal(
    resolveEmptyPlanFallbackAgent({
      intent: 'multi',
      evidence: [{ kind: 'gui', agent: 'gui', failed: true }]
    }),
    'gui'
  )
  assert.equal(
    resolveEmptyPlanFallbackAgent({ intent: 'multi', evidence: [] }),
    'db',
    'unknown still defaults db'
  )
}

console.log('smoke: gui repair no-db ok')
