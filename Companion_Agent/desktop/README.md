# Desktop 打包（Windows）

在 `Companion_Agent` 根目录：

```powershell
powershell -ExecutionPolicy Bypass -File desktop/build_exe.ps1
```

产物：`desktop_dist/CompanionAgent/CompanionAgent.exe`（onedir，含前端 dist 与 data）。

首次运行：

- 存档与密钥：`%LOCALAPPDATA%\CompanionAgent\`（`.env` 写 `DASHSCOPE_API_KEY=...`）
- 无密钥仍可逛 Hub / 地点 / 立绘；对话需模型密钥
