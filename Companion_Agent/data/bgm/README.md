# BGM 曲库

把音频放到本目录，文件名与 [`../bgm_catalog.json`](../bgm_catalog.json) 的 `tracks[].id` 一致。

支持 `.ogg` / `.mp3` / `.wav`。缺失时游戏静默跳过，不报错。前端按 `crossfade_ms` 交叉淡入淡出。

## 已收录

- **CC0（OpenGameArt）**：Hub / 地点 / 对话 / 结局等槽位；详见 [`ATTRIBUTION.md`](./ATTRIBUTION.md)。
- **本地覆盖（不可再发行）**：`title_theme`←芒种、`date_soft`←相许、`date_night`←stay with me；CC0 备份在 `_backup_cc0/`。

建议：循环友好的 60–120s 片段；响度大致统一（-14 LUFS 左右）。
