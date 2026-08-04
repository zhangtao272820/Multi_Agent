# 情绪 / 动作素材

同机位、同服装、同光照。文件名即 action / emotion id。

## 情绪（idle 循环或短片）

| id | 文件示例 |
|----|----------|
| neutral | `emotion_neutral.mp4` |
| smile | `emotion_smile.mp4` |
| serious | `emotion_serious.mp4` |
| surprised | `emotion_surprised.mp4` |

## 动作（插入片，不绑定产品坐标）

| id | 文件示例 |
|----|----------|
| idle_loop | `action_idle_loop.mp4` |
| nod | `action_nod.mp4` |
| wave | `action_wave.mp4` |
| present | `action_present.mp4` |
| think | `action_think.mp4` |

放置后设置 `AVATAR_ACTIONS_DIR=assets/avatar_actions`。

动作名 → LiveTalking `audiotype` 整数映射见 [`action_audiotype_map.json`](action_audiotype_map.json)，需与 LiveTalking `data/custom_config.json` 中的素材目录一致。
