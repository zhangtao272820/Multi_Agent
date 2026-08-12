# Lobster Hands 侧车（桌面手 POC）

> Docker Lobster = 网页手；本目录 = Windows 宿主桌面手。总管用 `LOBSTER_HANDS_WS_URL` 分流。

## 一分钟启动（开发）

```powershell
cd E:\Agent\Lobster_Agent
powershell -ExecutionPolicy Bypass -File hands/start-hands.ps1
```

默认：

| 项 | 值 |
|----|-----|
| 模式 | `LOBSTER_HANDS_ONLY=1` + `LOBSTER_DESKTOP_MCP_ENABLED=1` |
| HTTP | `http://127.0.0.1:13109` |
| WS | `ws://127.0.0.1:13109/_ws` |
| ready | `GET /api/ready` → `engines.desktop.ok` |

总管 `.env`（本机 Manager）：

```env
LOBSTER_AGENT_WS_URL=ws://127.0.0.1:13108/_ws
LOBSTER_HANDS_WS_URL=ws://127.0.0.1:13109/_ws
# 可选：LOBSTER_HANDS_HTTP_URL=http://127.0.0.1:13109
```

**Docker 总管**（`Manage-platform_Agent/.env.agents-lan` 已默认）：

```env
LOBSTER_HANDS_WS_URL=ws://host.docker.internal:13109/_ws
LOBSTER_HANDS_HTTP_URL=http://host.docker.internal:13109
```

网页仍走容器 `lobster_agent:13108`；桌面走宿主 Hands `:13109`。侧车保持运行时，在总管发桌面句即可。

桌面未起时，总管会澄清「请启动宿主 Hands」，**不会假成功**。

## 前置

1. Windows 宿主机（非 Linux 容器）
2. Node 20+、本仓 `npm install`
3. `uv` / `uvx` 可用（`uvx windows-mcp serve`；需能列出桌面工具）
4. 可选：`LOBSTER_ADMIN_TOKEN` 与总管内网 token 一致（默认 loopback）

> **注意**：不必安装 Hands.exe。开发态用 `start-hands.ps1` 即可。`no_tools` 通常是 `windows-mcp` 启动参数过旧（须 `serve`），不是缺 exe。

## 验收

```powershell
# ready
curl http://127.0.0.1:13109/api/ready

# 记事本黄金路径（需 Hands 已起）
cd E:\Agent\Lobster_Agent
$env:LOBSTER_BASE_URL='http://127.0.0.1:13109'
$env:LOBSTER_DESKTOP_MCP_ENABLED='1'
npx tsx scripts/e2e-golden-g4-desktop.ts
```

无 UIA / 未起 Hands 时脚本应 SKIP 或失败码清晰，禁止 ok=true。

## 打包 onedir（POC）

```powershell
cd E:\Agent\Lobster_Agent
powershell -ExecutionPolicy Bypass -File hands/build_exe.ps1
```

产物：`hands_dist/LobsterHands/`（含 `LobsterHands.cmd` 双击入口）。  
**不**把 Manager 整包打进 exe。密钥/token 写 `%LOCALAPPDATA%\LobsterHands\.env`。

## 安全

- 默认仅监听 `127.0.0.1`
- 删除/支付类仍走 HITL
- exe/cmd 只换分发形态，不提高权限
