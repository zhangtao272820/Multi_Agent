# shared/brand — 生产 Agent 前端品牌层

统一 **生产控制台风格**（非机甲 UI）。机甲仅用于 `avatars/` 虚拟形象占位。

## UI 重设计规范（主文档）

完整并行规范与总管专章见：

- [`docs/节气主题前端重设计/00-总览与并行规范.md`](../../docs/节气主题前端重设计/00-总览与并行规范.md)
- [`docs/节气主题前端重设计/01-总管.md`](../../docs/节气主题前端重设计/01-总管.md)
- [`docs/节气主题前端重设计/02-并行清单.md`](../../docs/节气主题前端重设计/02-并行清单.md)

## 点缀分配（按季）

| 季节 | motif | agents |
|------|-------|--------|
| 春 | rain | db, extractor, rag |
| 夏 | thunder | code, multimodal |
| 秋 | leaves | platform, admin |
| 冬 | snow | manager, lobster, video, music |

Music 仅保留 snow 点缀，**不参与**节气背景主题。

## 二十四节气背景

路径：`backgrounds/{season}/{term}-{agent}.png`（资源仍放 shared，**样式按 Agent 本地接入**）

- 参与：10 个 Agent（Music 不参与）。春 3 / 夏 2 / 秋 2 / 冬 3。
- `solarTerms[0]` → 登录；`solarTerms[1]` → 工作区。
- 生图必须高清锐利，禁止浅景深虚化（见总览文档第 3 节）。
- 勿把节气背景/玻璃 CSS 挂进全局 `index.css`。

## 接入

```js
resolve: { alias: { '@brand': path.resolve(__dirname, '../../shared/brand') } }
import '@brand/index.css'
```

后补立绘：在 `avatars/{key}.png` 放置即可，组件侧优先 PNG。
