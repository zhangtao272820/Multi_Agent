# CodePy_Agent 后续能力清单

## 动手安全提效（P0–P2）

统一链路：`pending patch → HITL confirm_token → apply`（T1 dry-run 再人批）。升级方向是**结构分级 + 可回滚 + 少打断**，不关 HITL、不开静默写盘。

### 已落地 / 本波契约

| 项 | 说明 |
|----|------|
| 路径白名单 | 任务级 `allowed_paths`：写盘/预览不得越出列表（空=仅工程根沙箱） |
| 落盘回滚 | apply 前快照 → `rollback_ref`；验失败 / 显式 restore 可回退 |
| 终端 profile | 默认窄白名单；`verify` 仅 pytest / `npm test` |
| 批量 pending | 同轮多 `propose_patch` 合并为一个 `pending_patch_id` |
| 确认后验证 | decide 可选 `verify_after_apply`：失败自动 rollback |

### P1+ 体验（按需）

- 确认卡侧栏全量 Diff、blast 标签
- 本会话操作时间线（拟改 / 已确认 / 已回滚）

### 明确不做

- 不为提效默认关 `MANAGER_CODE_EDIT_HITL`
- 不把总管做成 IDE Composer（见仓内 `manager-cursor-reply-only`）
- 终端不放行 `rm` / `curl` / 管道改写

## Smoke

```bash
python scripts/smoke_protocol.py
python scripts/smoke_fs.py
python scripts/smoke_shell_sandbox.py
python scripts/smoke_edit_pending.py
python scripts/smoke_hands_safety.py
```
