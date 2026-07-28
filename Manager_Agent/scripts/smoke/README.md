# scripts/smoke — 按域分层的 smoke 用例

> C7-2 迁入。`package.json` 中 `smoke:*` 别名路径已同步更新。

## 子目录

| 目录 | 数量 | 说明 |
|------|------|------|
| `gate/` | 14 | CI 门禁主集：graph · env-modes · p0～p3 · golden · batch 编排 |
| `route/` | 17 | 路由矩阵 · convergence · orchestrate · `route-matrix-cases.ts` |
| `plan/` | 9 | 计划 · clause · step-query · pro-understand |
| `batch/` | 5 | batch-a～e（`batch-e` 在 `ci:gate` 内） |
| `db/` | 4 | DB 预取 · admin 协议 |
| `rag/` | 4 | RAG 预取 · intent-rag |
| `orchestrate/` | 5 | 统一编排 · pipeline |
| `evolution/` | 4 | 演化 · skill-draft |
| `gui/` | 4 | GUI 路由与白名单 |
| `search/` | 3 | SearXNG · web-search |
| `misc/` | 10 | 杂项结构 smoke（`smoke-ws-auth` · `smoke-preflight` S3 联调预检） |

## 常用命令

```bash
cd Manager_Agent
npm run smoke:graph          # gate/
npm run smoke:env-modes      # gate/
npm run smoke:batch-e        # batch/（需 tsconfig.smoke.json）
npm run smoke:route-convergence  # route/
npm run ci:gate              # 聚合门禁
```

未注册别名（42）仍可直接跑：`npx tsx scripts/smoke/route/smoke-route-matrix.ts`
