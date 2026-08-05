# Campus backgrounds

真场景基线已就位（非纯色占位）。解析逻辑：`backend/app/sprites.py` → `resolve_bg(location_id, weather_id)`。

## 命名

| 模式 | 示例 |
|------|------|
| 基线 | `classroom.png`、`hallway.png`、`dorm_f1.png` |
| 天气变体 | `{location}_{weather}.png`，如 `classroom_rainy.png` |
| 校区地图 | `campus_map.png`（前端地图底图） |
| 兜底 | `default.png` |

天气 id 与 `data/weather_catalog.json` 对齐（常用：`sunny` / `rainy` / `cold` / `cloudy` 等）。

## 再生

```powershell
# 天气变体 + 宿舍区分色（基于现有基线调色，可再换真图）
python scripts/gen_weather_bgs.py

# 旧占位（仅无图时）
python scripts/gen_placeholder_bgs.py
```

## 优先级

1. `classroom` / `hallway` / `playground` / `rooftop` × rainy/sunny/cold  
2. 宿舍 `dorm_f*` / `dorm_m*` 视觉区分（勿再复制同一哈希）  
3. 其余地点天气变体按需补  

配额与清单见 `data/sprite_budget.json` 的 `bg_priority`。
