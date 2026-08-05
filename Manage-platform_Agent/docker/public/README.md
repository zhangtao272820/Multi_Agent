# 公网入口模板

| 文件 | 用途 |
|------|------|
| [`Caddyfile.example`](Caddyfile.example) | 推荐：`chat` → Manager `:13106`，`ops` → 紫微 `:18073`，自动 HTTPS |
| [`nginx.conf.example`](nginx.conf.example) | 备选 Nginx + Let’s Encrypt 路径示意 |
| [`env.public.snippet`](env.public.snippet) | 公网相关 env 键片段，合并进 `.env.agents-lan` |

操作步骤与安全组清单：[docs/公网演示部署.md](../../../docs/公网演示部署.md)。
