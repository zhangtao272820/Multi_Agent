# 公网入口模板

| 文件 | 用途 |
|------|------|
| [`Caddyfile.example`](Caddyfile.example) | 推荐：`chat` → Manager `:13106`，`ops` → 紫微 `:18073`，自动 HTTPS |
| [`nginx.conf.example`](nginx.conf.example) | 备选 Nginx + Let’s Encrypt 路径示意 |
| [`env.public.snippet`](env.public.snippet) | 公网相关 env 键片段，合并进 `.env.agents-lan` |

操作步骤与安全组清单：[docs/公网演示部署.md](../../../docs/公网演示部署.md)。

## 前置条件

- **域名**：`chat.` / `ops.` A 记录指向 ECS 公网 IP（Let’s Encrypt 需要域名；纯 IP 无法自动证书）
- **Compose**：`-Public` overlay 把 `13106`/`18073`/`18000` 等绑到 `127.0.0.1`，安全组只放 **80/443**
- **企业档**：`-Enterprise`（`AGENT_SERVICE_AUTH=require`、限流、token 顶）
- **弱机**：`--core --no-monitor`（不启 Lobster / 监控栈）

## 本地验收后再上云

```powershell
# Windows 开发机
cd Manage-platform_Agent
.\scripts\restart-core-stack.ps1 -Enterprise -NoMonitor -Public
.\scripts\verify-enterprise-docker.ps1 -Public -NoMonitor -SkipRecreate
```

```bash
# ECS
bash scripts/install-linux.sh --core --enterprise --public --no-monitor
sudo cp docker/public/Caddyfile.example /etc/caddy/Caddyfile
# 改域名与 email 后：
sudo systemctl reload caddy
```
