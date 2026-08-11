# BGM 曲库

把音频放到本目录，文件名与 [`../bgm_catalog.json`](../bgm_catalog.json) 的 `tracks[].id` 一致。

支持 `.ogg` / `.mp3` / `.wav`。缺失时游戏静默跳过，不报错。前端按 `crossfade_ms` 交叉淡入淡出。

## 已收录（CC0 · 人类作曲 · 非 AI · 一槽一曲）

来源：[OpenGameArt.org](https://opengameart.org/)（TAD lofi、Geomancer、Cynic Project、Ted Kerr、migfus20、Alex McCulloch 等）。详见 [`ATTRIBUTION.md`](./ATTRIBUTION.md)。

v2 共 25 槽：含 `loc_store` / `loc_festival` / `loc_forest`；标题 `playlists.title` 约 8 首轮换。

建议：循环友好的 60–120s 片段；响度大致统一（-14 LUFS 左右）。
