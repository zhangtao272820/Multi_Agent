# Companion_Agent / scripts

日常工具在本目录；已完成的一次性迁移脚本在 [`_archive/`](./_archive/)（勿日常运行）。

## 现行

| 脚本 | 用途 |
|------|------|
| `build_sprite_gen_manifest.py` | 扫分档立绘目录重建 `sprite_gen_manifest.json` |
| `build_sprite_inventory.py` | 全员立绘缺口 → `doc/立绘资源缺口.md` + `data/sprite_inventory.json` |
| `build_story_routes.py` | 生成 `story_routes.json` / 结局合并 |
| `build_china_calendar_2026.py` | 重建 `china_calendar_2026.json` |
| `emit_story_events.py` | 从 story_routes 写出 `data/events/story_*.yaml` |
| `gen-sprites-from-manifest.py` | 仅 dry-run / `--promote`（禁止 `--generate`） |
| `organize_background_extras.py` | 重建 `_background/` 与 `background_extras.json` |
| `body_catalog_lib.py` | 身材目录 helpers |
| `sync_relationship_web.py` | 中立改版后关系网同步 |
| `pregen_tts_cache.py` | TTS 预生成 |
| `smoke-ensemble-dialogue.py` | 双人同场 speaker / 季节场景冒烟 |
| `fill_ending_pages.py` | secret/good 结局补 `presentation_catalog.pages`（≥2） |
| `smoke-story-beats.py` | 故事节拍注入 / story 场次 8 轮 / 摘要截断 / 序章页数 |
| `enrich_story_beats.py` | 将 story YAML 写成 ≥3 拍（默认跳过已有；`--force` 覆盖） |
| `expand_opening_slides.py` | 序章扩到约 11 页 |
| `smoke-*.py` | 回归冒烟 |

## 归档

见 [`_archive/README.md`](./_archive/README.md)。历史命令需加 `_archive/` 前缀，例如：

```powershell
python scripts/_archive/separate_sprite_cast_dirs.py
```
