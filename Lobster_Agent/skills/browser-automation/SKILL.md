# browser-automation Skill（OpenClaw 类 · P2-C1）

> 浏览器自动化工作流包：双 Profile + 验证码/登录墙 + stale-ref 恢复

## 何时加载

- `task_kind` 为 search / navigate / extract / form_fill / login
- 站点触发验证码（wappass / captcha）
- Manager HITL 后 classic 有头重试

## 通用站 vs B 站专属

| 范围 | 本 skill / 主路径 | 下一阶段（待建） |
|------|-------------------|------------------|
| 通用网页 | Stagehand + Playwright DOM：搜索、抽取、填表、账号密码登录 demo | — |
| 登录态复用 | `browser_profile=user`（CDP）或 `storageProfile` + `POST /api/lobster/session/import` | — |
| B 站游客 | 直达 `search.bilibili.com`；不播放、不登录；workflow `bilibili-guest-search` | — |
| B 站互动 | 当前 hard_guard → classic HITL | `skills/bilibili-engagement/` + MCP：`bili_play` / `bili_danmaku` / `bili_coin` |

**禁止**：把 B 站弹幕/投币/播放做成通用站 regex 主路径；专属能力进独立 skill/MCP。

## 浏览器 Profile

| Profile | 说明 | 环境变量 |
|---------|------|----------|
| **managed** | 隔离 userDataDir，默认 | `LOBSTER_BROWSER_PROFILE=managed` |
| **user** | 附着用户已登录 Chrome | `LOBSTER_BROWSER_PROFILE=user` + `LOBSTER_BROWSER_CDP_URL` |

百度等强风控站点：优先 **user profile**（已登录 Chrome）或 Lobster Workbench noVNC 手动过验证码。

## 执行规则

1. 先 `browser_navigate` / 打开起始 URL，再 `browser_snapshot` 观察
2. snapshot 无变化：PageDown 滚动 → Escape 关弹窗 → wait 后重试
3. 检测到验证码 URL（wappass/captcha）：**停止自动化**，报告 `task_blocked` / `captcha`，等待人工
4. 填表/OA/公开登录 demo：优先 **stagehand** DOM fill；有 storage 时 stagehand 优先于 mcp
5. 视频播放 / B站互动（点赞投币弹幕）：强制 **classic** 有头（后续切专属 MCP）
6. 仅「B站/bilibili」站名或游客搜索：**不**强制 classic，走 Stagehand

## 完成标准（completion_criteria）

- search：返回搜索结果摘要或打开首条 URL
- extract：返回结构化字段或列表
- navigate：到达目标 URL 且页面可访问
- form_fill：字段已填写（未提交除非用户明确要求）
- login：账号密码已填并提交；URL 离开登录页或人工完成验证码

## 禁止

- 在总管界面代点验证码
- 无确认时执行支付/删除/投稿
- 编造未访问过的页面内容
- 自动过扫码/短信登录
