# Bilibili Engagement Skill（P4 MVP）

> **状态**：✅ MVP（点赞/投币/收藏/关注 + 播放）；发弹幕 📝 后置。  
> 通用浏览器能力见 [`../browser-automation/SKILL.md`](../browser-automation/SKILL.md)。  
> 实现：`server/services/bilibiliEngagement.ts` · `bilibiliEngagementAgent.ts`（Router 在 bilibili host + task_kind 时进入）。

## 目标

面向 bilibili.com 的专属互动，与通用 Stagehand 填表/游客搜索分离：

| Tool | 能力 | 闸门 |
|------|------|------|
| `bili_play` / `bili_pause` | 播放/暂停（有头 classic） | 可选 HITL；校验播放器/`video` |
| `bili_like` / `bili_coin` / `bili_favorite` / `bili_follow` | 点赞 / 投币 / 收藏 / 关注 | **须 HITL** + 登录态 |
| `bili_danmaku` | 发送弹幕 | 📝 本阶段硬拒（人工在播放器发） |

游客搜索/抽标题：宏 `bilibili-guest-search`（Stagehand/workflow），**不是**本 skill。

## 路由约定

- Manager / Lobster `task_kind`：`video_play` · `social_engagement`
- Router：`shouldRunBilibiliEngagementAgent` → `runBilibiliEngagementAgent`
- 引擎：classic（有头优先）；`engineSelector` hard_guard 与 `resolveEngineFromTaskSpec` 一致
- 可选声明：`workflow_args.engagement_ops` / `bili_tools`（如 `bili_like,bili_coin`）；缺省 social → `bili_like`，video → `bili_play`

## 非目标

- 扫码/短信自动登录（Cookie import / user CDP / noVNC）
- 投稿、支付、批量刷互动（`gateBilibiliEngagement` 硬拒）
- 用用户原话关键词表替代 LLM `task_kind`

## 登录态

1. `storageProfile` / `POST /api/lobster/session/import`
2. `browser_profile=user`（CDP）
3. 未登录写互动 → `need_login`，提示有头接手

## 风控

- 单次 run 写互动 ≤ `BILI_MAX_WRITE_PER_RUN`（默认 3）
- 总管 `social_engagement` 事前 HITL；Lobster 写互动二次 confirm
