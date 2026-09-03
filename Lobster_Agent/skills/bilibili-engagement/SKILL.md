# Bilibili Engagement Skill（P4 · 待建）

> **状态**：文档占位，**未实现** MCP / 运行时代码。  
> 通用浏览器能力见 [`../browser-automation/SKILL.md`](../browser-automation/SKILL.md)。

## 目标（下一阶段）

面向 bilibili.com 的专属互动，与通用 Stagehand 填表/搜索分离：

| Tool 草案 | 能力 |
|-----------|------|
| `bili_play` | 播放/暂停/进度（需登录态时先 Cookie/CDP） |
| `bili_danmaku` | 发送弹幕（人工确认） |
| `bili_coin` | 投币 |
| `bili_like` / `bili_favorite` | 点赞 / 收藏（可选） |

## 路由约定

- Manager / Lobster `task_kind`：`video_play` · `social_engagement`
- 当前：`engineSelector` hard_guard → classic
- 未来：上述 tools 优先；失败再 HITL

## 非目标

- 扫码/短信自动登录
- 投稿、支付、批量刷互动
- 用用户原话关键词表替代 LLM `task_kind`

## 启用条件（实现时）

1. 本目录补齐 `handlers` / MCP schema
2. 在 `skills/manifest.json` 注册
3. SSOT §7.2 状态改为 ✅
