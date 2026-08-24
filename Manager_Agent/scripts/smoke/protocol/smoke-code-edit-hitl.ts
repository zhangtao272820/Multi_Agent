/**
 * P2-B4 / C2-3c / S2：总管 Code edit HITL + 动态工具契约（离线）
 */
import {
  extractCodeEditPreview,
  isCodeEditHitlEnabled,
  buildCodeEditConfirmMessage,
} from '../../../server/utils/code/codeHumanConfirm'
import { isCodeMcpFirstEnabled } from '../../../server/graph/core/executors/codeExecutor'
import {
  buildPlanPreviewPayload,
  isCodeWriteSideStep,
  planHasWriteSideEffects,
} from '../../../server/graph/core/plan/planPreview'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(!isCodeEditHitlEnabled({ MANAGER_CODE_EDIT_HITL: '0' }), 'HITL off by default')
assert(isCodeEditHitlEnabled({ MANAGER_CODE_EDIT_HITL: '1' }), 'HITL on when env=1')
assert(
  isCodeEditHitlEnabled({ CODE_WRITE_REQUIRE_CONFIRM: '1' }),
  'HITL on via CODE_WRITE_REQUIRE_CONFIRM fallback',
)

const preview = extractCodeEditPreview({
  meta: {
    task_kind: 'edit',
    files_touched: ['server/utils/foo.ts'],
    edit_preview: {
      files: ['server/utils/foo.ts'],
      unified_diff: '--- a/foo\n+++ b/foo',
      diff_stat: '1 file changed',
    },
  },
  raw: {
    artifacts: {
      files_changed: ['server/utils/foo.ts'],
      validate_ok: true,
    },
  },
})
assert(preview?.files?.length === 1, 'preview files')
assert(preview?.unified_diff?.includes('foo'), 'preview diff')

const msg = buildCodeEditConfirmMessage(preview!, '改 foo.ts')
assert(msg.title.includes('确认'), 'confirm title')
assert(msg.message.includes('foo.ts'), 'confirm lists files')

// 黄金路径：edit → diff → confirmMode hitl → write 侧计划
assert(
  isCodeWriteSideStep({ agent: 'code', taskForm: 'edit', task_kind: 'edit' }),
  'code edit is write-side',
)
assert(!isCodeWriteSideStep({ agent: 'code', task_kind: 'inspect' }), 'inspect not write-side')
assert(
  planHasWriteSideEffects([{ id: '1', agent: 'code', query: '改文件', taskForm: 'edit' } as any]),
  'plan write side includes code edit',
)

const planPayload = buildPlanPreviewPayload(
  [{ id: 'c1', agent: 'code', query: '给 foo 加注释', taskForm: 'edit' } as any],
  'run_smoke',
  'prev_smoke',
  { meta: {}, intent: 'multi' },
)
const codeStep = planPayload.steps.find((s) => s.agent === 'code')
assert(codeStep?.confirmMode === 'hitl', 'code edit confirmMode hitl in plan preview')
assert(String(codeStep?.confirmReason || '').includes('code_edit'), 'code confirmReason')

process.env.MANAGER_CODE_MCP_FIRST = '1'
assert(isCodeMcpFirstEnabled(), 'MCP first flag')

console.log('smoke-code-edit-hitl: PASS')
