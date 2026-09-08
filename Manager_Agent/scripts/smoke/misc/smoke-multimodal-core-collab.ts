/**
 * multimodal 升核心：registry + attachment orchestrator hint + caption 接地（无网络）
 */
import {
  EXTENDED_PROFILE_AGENTS,
  reconcileExtendedAgentAvailability
} from '../../../server/graph/core/agent/agentRegistry'
import { formatAttachmentHintForOrchestrator } from '../../../server/graph/orchestrate/unifiedRouting'
import {
  formatCaptionUpstreamBlock,
  mergeCaptionIntoAttachment,
  normalizeRouteCaptionResult,
  shouldFetchRouteImageCaption,
  shouldReuseRouteCaptionForMultimodal
} from '../../../server/graph/orchestrate/routeImageCaption'
import { buildActionExecEffectiveQuery } from '../../../server/graph/core/stepIsolation/exec'
import {
  classifyStepObservationFailure,
  shouldConsiderLocalReplan,
  shouldForcePlanRollback
} from '../../../server/graph/core/plan/localReplan'
import { resolveContinuationRouteBypass } from '../../../server/graph/core/routing/continuationRouteBypass'
import { applyCascadeSelfCheckSkip, isRouteCascadeEnabled } from '../../../server/graph/core/routing/routeSkipCascade'
import { clipRouteCaption } from '../../../server/utils/media/mediaAttachment'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(!EXTENDED_PROFILE_AGENTS.includes('multimodal'), 'multimodal must not be extended-only')
assert(EXTENDED_PROFILE_AGENTS.includes('music'), 'music remains extended')
assert(EXTENDED_PROFILE_AGENTS.includes('video'), 'video remains extended')
assert(EXTENDED_PROFILE_AGENTS.includes('gui'), 'gui remains extended')

const mmOnlyDown = reconcileExtendedAgentAvailability('multimodal', ['multimodal'], {
  agents: [{ agent: 'multimodal', status: 'down' }]
})
assert(mmOnlyDown.blocked.length === 0, 'down multimodal is core; not blocked as extended')

const musicDown = reconcileExtendedAgentAvailability('music', ['music'], {
  agents: [{ agent: 'music', status: 'down' }]
})
assert(musicDown.blocked.includes('music'), 'down music remains extended-blocked')
assert(
  musicDown.clarifyQuestions.some((q) => q.includes('Multimodal')),
  'clarify should mention Multimodal in standard stack'
)

const hint = formatAttachmentHintForOrchestrator({ filePath: '/tmp/x.png', mediaType: 'image' })
assert(hint.includes('问题描述'), 'attachment hint mentions problem description')
assert(hint.includes('dependsOn multimodal'), 'attachment hint requires dependsOn multimodal')
assert(hint.includes('intent=multi'), 'attachment + business → multi')

const captionedHint = formatAttachmentHintForOrchestrator({
  filePath: '/tmp/x.png',
  mediaType: 'image',
  caption: '证件照，姓名林婉清'
})
assert(captionedHint.includes('画面摘要'), 'caption injected into orchestrator hint')
assert(captionedHint.includes('林婉清'), 'caption entity in hint')

assert(shouldFetchRouteImageCaption({ filePath: '/a.png', mediaType: 'image' }), 'fetch when no caption')
assert(
  !shouldFetchRouteImageCaption({ filePath: '/a.png', mediaType: 'image', caption: '已有' }),
  'skip fetch when caption present'
)
assert(!shouldFetchRouteImageCaption({ filePath: '/a.mp3', mediaType: 'audio' }), 'no caption for audio')

const norm = normalizeRouteCaptionResult({ caption: 'a'.repeat(120), ocr_snippet: 'OCR' })
assert(norm.caption.length <= 80, 'caption clipped to 80')
assert(norm.ocrSnippet === 'OCR', 'ocr kept')

const merged = mergeCaptionIntoAttachment(
  { filePath: '/a.png', mediaType: 'image' },
  { caption: '图中为林婉清', captionSource: 'vl', captionMs: 120 }
)
assert(merged.caption === '图中为林婉清', 'merge caption')
assert(clipRouteCaption('  hello  ').length === 5, 'clip trims')

assert(shouldReuseRouteCaptionForMultimodal('请分析附件并回答。', '图中为林婉清'), 'reuse on generic')
assert(!shouldReuseRouteCaptionForMultimodal('图中人物的职位是什么？请结合工牌详细说明', '短'), 'no reuse on specific Q')

const block = formatCaptionUpstreamBlock({ caption: '林婉清', ocrSnippet: '工牌' })
assert(block.includes('林婉清') && block.includes('工牌'), 'upstream block')

const eff = buildActionExecEffectiveQuery(
  { id: 's2', agent: 'db', query: '按实体查记录', dependsOn: ['s1'] } as any,
  '结合图中信息查记录',
  '图中人物名为林婉清'
)
assert(eff.includes('林婉清'), 'upstream multimodal context injects into db query')
assert(eff.includes('已知信息'), 'upstream label present')

const effCap = buildActionExecEffectiveQuery(
  { id: 's2', agent: 'db', query: '查此人档案', dependsOn: [] } as any,
  '查图中人物',
  '',
  false,
  { routeImageCaption: '林婉清，工牌照片' }
)
assert(effCap.includes('林婉清'), 'route caption grounds db without upstream step')

const emptyKind = classifyStepObservationFailure({
  status: 'ok',
  output: '{"rows":[],"row_count":0}',
  agent: 'db'
})
assert(emptyKind === 'empty_evidence', 'empty rows → empty_evidence')
assert(
  shouldConsiderLocalReplan({ status: 'ok', output: '{"rows":[]}', agent: 'db' }),
  'empty evidence triggers replan consider'
)
assert(
  shouldForcePlanRollback({ localReplanCount: 3, wouldConsiderReplan: true }),
  'replan cap forces plan'
)

const attBlock = resolveContinuationRouteBypass({
  turnScope: {
    mode: 'continuation',
    turnKind: 'continuation',
    lastOnly: '只要前3',
    routingContext: '只要前3',
    confidence: 0.9,
    clarifyKind: 'none',
    suppressSessionAnchor: false,
    suppressMultiTurnMerge: false,
    directChitchatSynth: false,
    refreshSessionAnchor: false
  } as any,
  sessionAnchor: {
    primaryIntent: 'db',
    primaryPlane: 'db',
    planShortcut: 'db_only',
    isDbAnchored: true,
    isMulti: false,
    coalescedTask: '查销售',
    lastExecutedAgents: ['db'],
    updatedAt: new Date().toISOString()
  },
  lastUser: '只要前3',
  attachment: { filePath: '/x.png' }
})
assert(!attBlock.ok && attBlock.reasons.includes('new_attachment'), 'attachment blocks continuation bypass')

const cascadeOff = applyCascadeSelfCheckSkip(
  { skipAlign: false, skipPlane: false, skipWebAlign: false, reasons: [] },
  { selfCheck: { needsSecondPass: false } }
)
assert(!cascadeOff.reasons.includes('cascade_no_second_pass') || !isRouteCascadeEnabled(), 'cascade gated by env')

console.log('smoke-multimodal-core-collab ok')
