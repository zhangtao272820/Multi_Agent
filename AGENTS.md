# AGENTS.md — 本仓库 Cursor / Agent 协作 SSOT

任何在本仓编码的 Agent **先读本文件**，再动代码。细则在 `.cursor/rules/` 与 `.cursor/skills/`；踩坑后**当会话入库**，勿只写在聊天里。

## 1. 必读入口

| 优先级 | 路径 | 何时 |
|--------|------|------|
| P0 | 本文件 `AGENTS.md` | 每次非平凡任务开场 |
| P0 | `.cursor/rules/*.mdc`（`alwaysApply: true`） | 自动注入；仍须遵守 |
| P0 | `.cursor/skills/follow-project-conventions/SKILL.md` | 改代码 / 修 bug / 加能力前 |
| P1 | 匹配当前文件的 `globs` 规则 | 打开或编辑对应路径时 |
| P1 | 目标 Agent 的 `*/skills/**/skill.md` 与 `*/doc/**` | 改该专家时 |
| P2 | `.cursor/skills/extract-project-rules/SKILL.md` | 发现新约定、用户纠偏、连续踩坑时 |

## 2. Always-apply 规则（全会话）

| 文件 | 一句话 |
|------|--------|
| `root-cause-fixing.mdc` | 修 bug 找根因，禁症状补丁 / 原话 regex |
| `smoke-cheap-no-side-effects.mdc` | Smoke 省 token，禁改生产默认过测试 |
| `docker-no-volume-wipe.mdc` | 重启禁 `down -v`，保命名卷 |
| `complex-task-planning.mdc` | 跨 Agent / 语义重构先 Plan 再写 |
| `cursor-governance.mdc` | 遵守并及时提取 rules/skills |
| `experience-useful-only.mdc` | 全专家经验只认「有用」；RAG 向量亦仅有用索引；撤回重生无用不回灌 |
| `feedback-hydrate-after-docker.mdc` | Docker 重建后有用/无用须退避重试回灌，禁依赖重登 |
| `agent-auth-control-plane-decouple.mdc` | Agent 登录/反馈与控制端解耦；禁任意 401 清 JWT；Compose 等 backend healthy |

企业档 Docker（LAN 默认不变，显式 `-Enterprise`）：[`Manage-platform_Agent/doc/enterprise-docker.md`](Manage-platform_Agent/doc/enterprise-docker.md) · 验收 `.\Manage-platform_Agent\scripts\verify-enterprise-docker.ps1` · 详版 [`docs/企业化.md`](docs/企业化.md)。

## 3. 按路径生效的规则

| 文件 | Globs / 范围 |
|------|----------------|
| `agent-llm-first.mdc` | `**/*Agent/**/*` — 禁正则做意图/抽参；LLM + Zod |
| `shared-agent-contracts.mdc` | `shared/**/*` — 契约层同样 LLM-first |
| `manager-routing-playbook.mdc` | Manager 路由 / smoke / eval — 改路由必读手册；优化阶段见 `Manager_Agent/doc/路由成熟化优化方案.md`；企业生产/企业档/P1·P2 见 `docs/企业化.md` |
| `manager-cursor-reply-only.mdc` | Manager 只借鉴 Cursor **回复呈现**（含 provisional synth 真流）；禁做成改代码 / Composer |
| `experience-useful-only.mdc` | Vanna/RAG/GUI/Admin/shared/Manager — 仅「有用」可召回 |
| `feedback-hydrate-after-docker.mdc` | `*Agent*` 反馈 UI — Docker 暖机后 hydrate 须重试 |
| `agent-auth-control-plane-decouple.mdc` | 登录/反馈/compose — 与控制端解耦；本地 validate；禁假登录 |

DB/Code 写闸：Vanna `skills/write_gate.md`（T2 pending）；CodePy 改码事前 HITL + 沙箱终端；总管 `db_write`→T2、`MANAGER_CODE_EDIT_HITL` 默认开。

动手类（Admin / GUI / Vanna / Code）：[`docs/动手Agent.md`](docs/动手Agent.md)。自进化：[`docs/自进化.md`](docs/自进化.md)。docs 索引：[`docs/README.md`](docs/README.md)。

## 4. 项目 Skills（入库，可共享）

| Skill | 触发 |
|-------|------|
| `follow-project-conventions` | 编码、修路由、加 LLM 能力、跑 smoke/Docker |
| `extract-project-rules` | 用户说「记下来 / 写成规则」、纠偏、同类坑第二次出现 |

各专家运行时 skill（`Manager_Agent/skills/`、`RAG_Agent/skills/` 等）是**产品能力**文档，与 Cursor 治理 skill 分开；改专家逻辑时两者都要看。

## 5. 硬红线（摘要）

1. **LLM-first**：用户意图 / 路由 / 业务抽参 → 模型 + schema；禁关键词表当主路径。
2. **根因修复**：禁 catch 吞错硬编码、禁只改 smoke 期望、禁上层特判掩盖下层。
3. **Smoke**：默认不调真 LLM / 不发副作用；禁为过测开 `AUTO_PROMOTE`、关 HITL。
4. **Docker**：禁 `down -v` / `volume rm`（除非用户书面要求清库）。
5. **复杂改动**：跨 Agent、语义层、两次补丁仍不稳 → 先 Plan 对齐。
6. **进化**：shadow → 门禁 → **人工 promote**；禁无人值守改线上 Prompt。

## 6. 踩坑 → 入库（强制）

满足任一条件，**本会话内**写入 `.cursor/rules/` 或 `.cursor/skills/`（见 `extract-project-rules`）：

- 用户纠正「以后别这样」/「记成规则」
- 同一类失败修了两次仍复发
- 新约定只存在于聊天、下一会话会丢
- 发现与现有 `.mdc` 冲突的做法

**规则** = 短约束（<50 行，一事一条）；**Skill** = 可执行工作流 / checklist。写完后在本文件 §2–§4 补一行索引。
