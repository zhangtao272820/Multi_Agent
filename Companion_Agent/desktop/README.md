# Desktop 打包（Windows）

在 `Companion_Agent` 根目录：

```powershell
powershell -ExecutionPolicy Bypass -File desktop/build_exe.ps1
```

产物：`desktop_dist/CompanionAgent/CompanionAgent.exe`（onedir，含前端 dist 与 data）。

首次运行：

- 存档与密钥：`%LOCALAPPDATA%\CompanionAgent\`（`.env` 写 `DASHSCOPE_API_KEY=...`）
- 无密钥仍可逛 Hub / 地点 / 立绘；对话需模型密钥

## 闪退排查

若双击 exe 立刻闪退，用命令行启动看报错：

```powershell
cd desktop_dist\CompanionAgent
.\CompanionAgent.exe
```

常见根因：`_internal\python313.dll` 或 `.pyd` 缺失/损坏（杀软误删、旧包 UPX 压坏）。完整目录须整夹拷贝，不可只拷单个 exe。重新打包：

```powershell
powershell -ExecutionPolicy Bypass -File desktop/build_exe.ps1
```

构建脚本会校验 `python3xx.dll` 与 `.pyd` 是否齐全；`companion.spec` 已关闭 UPX。
