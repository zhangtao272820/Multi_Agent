/**
 * B站互动闸门契约（无浏览器、无 LLM）
 */
import {
  BILI_MAX_WRITE_PER_RUN,
  declaredBiliToolsFromArgs,
  detectBilibiliLoggedIn,
  gateBilibiliEngagement,
  isAllowedBiliTool,
  isBilibiliEngagementHost,
  planBilibiliEngagementFromSpec,
} from '../server/services/bilibiliEngagement'
import { shouldRunBilibiliEngagementAgent } from '../server/services/bilibiliEngagementAgent'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(isBilibiliEngagementHost('https://www.bilibili.com/video/BV1xx'), 'host video')
assert(isBilibiliEngagementHost('https://search.bilibili.com/all?keyword=x'), 'host search')
assert(isBilibiliEngagementHost('https://b23.tv/abc'), 'host b23')
assert(!isBilibiliEngagementHost('https://www.runoob.com/'), 'not runoob')

assert(isAllowedBiliTool('bili_like'), 'like allowed')
assert(isAllowedBiliTool('bili_play'), 'play allowed')
assert(!isAllowedBiliTool('bili_danmaku'), 'danmaku not allowed as executable')
assert(!isAllowedBiliTool('bili_upload'), 'upload not allowed')

const hitlBlock = gateBilibiliEngagement({
  tool: 'bili_like',
  loggedIn: true,
  hitlApproved: false,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(!hitlBlock.ok && hitlBlock.code === 'bili_hitl_required', 'HITL required')

const loginBlock = gateBilibiliEngagement({
  tool: 'bili_coin',
  loggedIn: false,
  hitlApproved: true,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(!loginBlock.ok && loginBlock.code === 'bili_login_required', 'login required')

const okWrite = gateBilibiliEngagement({
  tool: 'bili_favorite',
  loggedIn: true,
  hitlApproved: true,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(okWrite.ok, 'write ok when hitl+login')

const playOk = gateBilibiliEngagement({
  tool: 'bili_play',
  loggedIn: false,
  hitlApproved: false,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(playOk.ok, 'play does not require hitl/login')

const danmaku = gateBilibiliEngagement({
  tool: 'bili_danmaku',
  loggedIn: true,
  hitlApproved: true,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(!danmaku.ok && danmaku.code === 'bili_danmaku_deferred', 'danmaku deferred')

const forbidden = gateBilibiliEngagement({
  tool: 'bili_pay',
  loggedIn: true,
  hitlApproved: true,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(!forbidden.ok && forbidden.code === 'bili_forbidden', 'pay forbidden')

const batch = gateBilibiliEngagement({
  tool: 'bili_like',
  loggedIn: true,
  hitlApproved: true,
  writeCountInRun: BILI_MAX_WRITE_PER_RUN,
  hostOrUrl: 'https://www.bilibili.com/video/BV1',
})
assert(!batch.ok && batch.code === 'bili_batch_blocked', 'batch blocked')

const wrongHost = gateBilibiliEngagement({
  tool: 'bili_like',
  loggedIn: true,
  hitlApproved: true,
  hostOrUrl: 'https://www.runoob.com/',
})
assert(!wrongHost.ok && wrongHost.code === 'bili_host_mismatch', 'host mismatch')

assert(detectBilibiliLoggedIn({ loggedInUi: true }) === true, 'ui logged in')
assert(detectBilibiliLoggedIn({ hasStorageProfile: true }) === true, 'storage logged in')
assert(detectBilibiliLoggedIn({ loginWallVisible: true, loggedInUi: false }) === false, 'wall')

const playPlan = planBilibiliEngagementFromSpec({ taskKind: 'video_play' })
assert(playPlan.tools.includes('bili_play'), 'default play tool')
assert(playPlan.needsHitl === false, 'play no hitl')

const socialPlan = planBilibiliEngagementFromSpec({ taskKind: 'social_engagement' })
assert(socialPlan.needsHitl && socialPlan.needsLogin, 'social needs hitl+login')
assert(socialPlan.tools.includes('bili_like'), 'default like')

const declared = planBilibiliEngagementFromSpec({
  taskKind: 'social_engagement',
  declaredTools: ['bili_coin', 'bili_follow'],
})
assert(declared.tools.join(',') === 'bili_coin,bili_follow', 'declared tools')

assert(
  declaredBiliToolsFromArgs({ engagement_ops: 'bili_like,bili_coin' }).includes('bili_like'),
  'args parse',
)

assert(
  shouldRunBilibiliEngagementAgent({
    taskKind: 'social_engagement',
    task: '点赞',
    startUrl: 'https://www.bilibili.com/video/BV1',
  }),
  'should run social',
)
assert(
  shouldRunBilibiliEngagementAgent({
    taskKind: 'video_play',
    task: '播放',
    startUrl: 'https://www.bilibili.com/video/BV1',
  }),
  'should run play',
)
assert(
  !shouldRunBilibiliEngagementAgent({
    taskKind: 'search',
    task: 'B站搜索',
    startUrl: 'https://search.bilibili.com/all?keyword=x',
  }),
  'guest search not engagement agent',
)

console.log('smoke-bilibili-engagement-gate: PASS')
