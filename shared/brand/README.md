# shared/brand — 生产 Agent 前端品牌层

统一 **高对比、可区分、可读优先** 的生产控制台风格。机甲立绘仅用于 `avatars/` 占位。

## 主题合同（现行 SSOT）

**节气 / 节日大图已废除为视觉身份。** 现行氛围为 `backgrounds/theme/` 下**生成主题底图** + CSS 遮罩/面板分层。

| 层 | 文件 | 职责 |
|----|------|------|
| Token | `tokens.css` | 全局对比度、阴影、字体、表面变量 |
| Agent | `agents.css` | 每站 accent + bg/border/sidebar/text 全套 |
| Surfaces | `surfaces.css` | 隐藏节气装饰、通用氛围 fallback |
| Theme BG | `backgrounds/theme/*.png` | 登录 / 工作区生成底图（非节气）：manager / platform / rag / admin / lobster / db |
| Shell | `shell.css` | topbar / panel / 渐变主按钮 / glass 原语 / 登录卡 / 深色壳体 |
| Chat | `chat.css` | 对话气泡、Think、composer、markdown |
| Hide | `comfort-hide-decor.css` | 强制隐藏 `*-season-bg` / motif / storm |

## 分站气质

| data-agent | 气质 | 主色 | 底图 |
|------------|------|------|------|
| manager | 编排台 · 冷蓝 | `#1d4ed8` | `theme/manager-workbench.png` |
| platform | 管控台 · 墨金 | `#b8862f` | `theme/platform-login.png` / `platform-workspace.png` |
| admin | 行政 · 暖金褐 | `#b8860b` | `theme/admin-workbench.png` |
| rag | 知识 · 靛青 | `#4f6fd4` | `theme/rag-workbench.png` |
| lobster | GUI · 玫红 | `#c24155` | `theme/lobster-workbench.png` |
| db | 问数 · 青绿 | `#0d9488` | `theme/db-workbench.png` |

## 接入

```js
resolve: { alias: { '@brand': path.resolve(__dirname, '../../shared/brand') } }
import '@brand/index.css'
```

根节点挂 `class="brand-shell"` + `data-agent="manager|platform|…"`。

## 历史文档

`docs/节气主题前端重设计/` 与 `backgrounds/{season}/` 仅作历史参考，**不再作为实现规范**。
