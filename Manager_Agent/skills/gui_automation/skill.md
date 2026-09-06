---
name: gui_automation
description: Manager 总管 GUI（Lobster_Agent / Stagehand·MCP·classic）浏览器自动化规划与路由——含「手」操作（填表/登录）
version: 1.5.0
stage: route,planner
owner: manager_agent
compatible_agents:
  - Manager_Agent
---

## Route

### 操作 vs 检索（operate vs observe）

| 模式 | 判定 | 路由 |
|------|------|------|
| **操作（手）** | 填表、登录、提交、选下拉、勾选、点同意、站内搜索后点击、截图当前页 | `webExecutionMode=gui` → Lobster_Agent；载荷写 `task_kind` |
| **检索（眼）** | 「怎么学 / 有哪些 / 是什么」资讯问答 | `search_chat`，**禁止** gui |
| **静态抽** | 给定 URL 抓正文、无交互 | crawler，**禁止** gui |

- 填表/登录/提交**必须** gui，禁止用 search_chat「教用户怎么填」。
- Extractor 返回 `route_suggestion=gui`（登录墙/SPA）且 Lobster 已部署 → allowedAgents 须含 gui。

### 何时不用 gui
- 公网资料抽取 → 总管 **web_search（强制）+ crawler（爬虫）**。
- 天气 / 地图 / 日程 / 邮件 / 联系人 / 待办 / 飞书消息 → **admin**（见 admin_capabilities）。
- 复合 `db + 公网参考` → db ∥ crawler，**禁止 gui**。

详见：[矩阵总表](../../../docs/Agent矩阵升级总路线图.md) · [`crawler_web`](../crawler_web/skill.md) · [`Lobster_Agent`](../../../Lobster_Agent/)。

### 字段真源（`ManagerGuiTaskPayload`）

| 字段 | 说明 |
|------|------|
| `task` / `startUrl` | 任务文与起始 URL（camel） |
| **`task_kind`** | 真源：`form_fill` \| `login` \| `search` \| `extract` \| …；网页由 Lobster `auto` 选型（stagehand / mcp / classic） |
| `needs_login` | 是否需要登录态 |
| `intent_hint` | 兼容镜像，等于 `task_kind` |
| `engineHint` | 可选：`classic` \| `mcp` \| `stagehand` \| `desktop`（用户显式 `引擎:xxx`） |
| `browser_profile` | `managed` \| `user` |
| `workflow_id` | 宏（`Lobster_Agent/workflows/*`）：`w3school-form-*`、`httpbin-form-*`、`oa-multifield-form-fill`、`runoob-click-extract`、**`bilibili-guest-search`**（必填 `keyword`） |
| `workflow_args` | 宏参数；B站游客须 `keyword`；互动可选 `engagement_ops` / `bili_tools` |
| `success_criteria` | `form_fill`/`login` 默认 `filledMin≥1`；失败不得假成功 |
| `storage_profile` / `登录态:` | Playwright storageState 复用 |
| `lobster.*` | recipe 元数据（soft） |

### hint 语法（用户可在原话中附带；显式 overlay，非意图主路径）
- `工作流:w3school-form-fill` / `工作流:oa-multifield-form-fill` / `工作流:bilibili-guest-search` — 显式指定 Workflow Macro
- `引擎:stagehand` / `引擎:mcp` / `引擎:classic` / `引擎:desktop`
- `登录态:profile_name` — 复用 Playwright storageState
- 起始 URL 写在任务中 → 组装为 `startUrl`

### 示例句（日常测试用国内站；勿默认 httpbin）
- 填表：`打开 https://www.w3school.com.cn/html/html_forms.asp ，First name 填张三，Last name 填李四，不要点 Submit。`
- 填表+宏：`工作流:w3school-form-fill first_name=张三 last_name=李四 打开 https://www.w3school.com.cn/html/html_forms.asp`
- 多字段：`工作流:oa-multifield-form-fill customer_name=王五 email=w@ex.com phone=13800000000 打开 https://httpbin.org/forms/post`
- 搜索点开：`打开 https://www.runoob.com/，点击第一个教程链接并提取标题`
- **B站游客**：`打开 B站搜索 Python 教程，打开第一条详情，提取标题和 UP（不要播放、不要点赞）`
- **B站宏**：`工作流:bilibili-guest-search keyword=LangGraph 打开 https://search.bilibili.com/all?keyword=LangGraph`
- **B站播放宏**：`工作流:bilibili-video-play 打开 https://www.bilibili.com/video/BV1GJ411x7h7`
- **B站播放**：`打开 https://www.bilibili.com/video/BVxxxx 并播放` → `task_kind=video_play`
- **B站互动**：`给这个B站视频点赞` → `social_engagement` + HITL + 登录态
- 勿走 gui：`Python 教程怎么学比较好？` / `B站有哪些好课推荐？` → search_chat

### B站分流（P4）
| 语义 | task_kind | 引擎 / 宏 |
|------|-----------|-----------|
| 搜词+开首条+抽标题/UP（勿播勿互动） | search / extract | Stagehand；可绑 `bilibili-guest-search`（缺 startUrl 按 keyword 补全） |
| 播放/观看 | video_play | classic；可绑 `bilibili-video-play` |
| 点赞/投币/收藏/关注 | social_engagement | classic + **事前 HITL**；须登录 |
| 发弹幕 | — | 本阶段不自动；人工在播放器 |

### multi 组合
- 「crawler 发现入口 + gui 登录操作」→ multi：gui dependsOn crawler。
- **同一子目标禁止 crawler 与 gui 混用**。

### 部署
- 须配置 `LOBSTER_AGENT_WS_URL`（Lobster_Agent `:13108`）；Docker 依赖 `lobster_agent` + `playwright_mcp`。
- health=down 时仍可在 allowedAgents 列出 gui，执行阶段会跳过并说明。

## Planner

### gui 步骤 query 边界
- query 只写**浏览器交互子任务**（打开哪站、搜什么、点哪条、填哪些字段）。
- 填表/OA 通常单步 gui；需先发现 URL 再操作 → crawler → gui。
- 合成结果：`form_fill`/`login` 用操作短结论（做了什么/成功或 HITL），禁止资讯长文。
- 字段映射失败 → 结构化缺参追问，禁止空成功。

### 超时与确认
- 默认交互 240s；填表/OA 360s；视频 480s。
- 高风险（提交/支付/删除）与验证码/登录墙须 HITL（Lobster 发 `confirm`，总管回 `confirm_response`）；提交前带**字段摘要**（可加截图）。

### 失败恢复
- 登录墙 → 导入 cookie（`登录态:xxx`）或 noVNC 6080。
- 验证码 HITL 后改走 **有头 classic**（可 noVNC）；引擎失败时可 `MANAGER_GUI_RETRY_ON_ENGINE_FAIL=1` 换引擎（mcp → stagehand → classic）。
- 同站同 `task_kind` 成功轨迹可经 playbook 复用（非静默换引擎）。
