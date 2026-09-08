# shared/brand — 生产 Agent 前端品牌层

统一 **Harness 壳层 + 分站 accent**。机甲立绘仅用于 `avatars/` 占位。

## 主题合同（现行 SSOT）

**聊天工作区默认 Harness 平铺**（主区白 / 侧栏 `#f8f9fa` / 细分割线）。登录页仍可用 `backgrounds/theme/` 生成底图；工作区主题底图不再作为壳层主身份。

| 层 | 文件 | 职责 |
|----|------|------|
| Fonts | `fonts.css` | 真加载 Manrope / Noto Sans SC / JetBrains Mono |
| Token | `tokens.css` | 对比度、阴影、字体、`--harness-*` 表面 |
| Agent | `agents.css` | 每站 accent + bg/border/sidebar/text |
| Surfaces | `surfaces.css` | 隐藏节气装饰、通用氛围 fallback |
| Theme BG | `backgrounds/theme/*.png` | 登录页气质底图（可选） |
| Shell | `shell.css` | topbar / pill / send-fab / nav-item / 登录卡 |
| Chat | `chat.css` | 对话气泡、Think、composer 一体壳、markdown |
| Hide | `comfort-hide-decor.css` | 强制隐藏 `*-season-bg` / motif / storm |

## Harness 壳层合同

| 原语 | 类名 | 规格 |
|------|------|------|
| 新会话 | `.brand-btn--pill` | 全宽 pill、浅灰底细边 |
| 发送 | `.brand-send-fab` / `.ch-send-fab` | 36px 圆、accent 实心、↑；`.is-cancel` 红 |
| 导航激活 | `.brand-nav-item.is-active` | 浅蓝底 + 左侧 accent 条 |
| Composer | `.ch-composer` | 16px 圆角一体壳 + 底栏指标 |

## 分站气质

| data-agent | 气质 | 主色 |
|------------|------|------|
| manager | 编排台 · 冷蓝 | `#1d4ed8` |
| platform | 管控台 · 墨金 | `#b8862f` |
| admin | 行政 · 暖金褐 | `#b8860b` |
| rag | 知识 · 靛青 | `#4f6fd4` |
| lobster | GUI · 玫红 | `#c24155` |
| db | 问数 · 青绿 | `#0d9488` |

## 接入

```js
resolve: { alias: { '@brand': path.resolve(__dirname, '../../shared/brand') } }
import '@brand/index.css'
```

根节点挂 `class="brand-shell"` + `data-agent="manager|platform|…"`.

## 历史文档

`docs/节气主题前端重设计/` 与 `backgrounds/{season}/` 仅作历史参考，**不再作为实现规范**。
