import { BRAND_AVATARS, BRAND_LOGOS } from "@brand/react/assetMap.js";

const NAV_GROUPS = [
  {
    id: "ops",
    label: "运维",
    items: [
      { id: "overview", label: "总览", desc: "健康探活 · 集群状态 · 编排指标" },
      { id: "manager", label: "总管 & 子 Agent", desc: "Token · 进化审阅 · 用户记忆审核" },
      { id: "tasks", label: "任务编排", desc: "Manager WebSocket 转发执行" },
    ],
  },
  {
    id: "config",
    label: "配置",
    items: [
      { id: "config", label: "Agent 配置", desc: "模型 · MODE · 基建 · 本地 .env" },
      { id: "skills", label: "技能中心", desc: "发布 · 安装 · 执行技能" },
    ],
  },
  {
    id: "control",
    label: "管控",
    items: [{ id: "agents", label: "Agent 管控", desc: "舰队启停 · Drain · 滚动重启" }],
  },
  {
    id: "obs",
    label: "可观测",
    items: [{ id: "monitor", label: "监控与日志", desc: "Prometheus · 告警 · Loki/Tempo/Langfuse" }],
  },
  {
    id: "deploy",
    label: "部署",
    items: [{ id: "deploy", label: "部署中心", desc: "镜像 tag · 回滚 · 离线包状态" }],
  },
  {
    id: "maintain",
    label: "维护",
    items: [{ id: "maintain", label: "备份恢复", desc: "PostgreSQL 备份 · 恢复演练" }],
  },
  {
    id: "gov",
    label: "治理",
    items: [
      { id: "users", label: "用户与角色", desc: "账号 · 三角色 · RBAC 矩阵" },
      { id: "tenants", label: "租户与配额", desc: "租户实体 · Token 硬配额" },
      { id: "audit", label: "审计", desc: "敏感清单 · 筛选导出" },
      { id: "evolution", label: "记忆与进化审阅", desc: "用户记忆 · 技能草稿 · 组织规则人审" },
      { id: "secrets", label: "密钥与通知", desc: "Vault · webhook · Fernet 写回" },
      { id: "settings", label: "系统设置", desc: "环境快照 · 治理入口（进化审阅见「总管 & 子 Agent」）" },
    ],
  },
];

const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items);

const WS_LABEL = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "已断开",
  error: "异常",
};

const GROUP_BY_ROUTE = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items.map((item) => [item.id, g.label]))
);

const WIDE_ROUTES = new Set(["monitor"]);
const FILL_ROUTES = new Set(["monitor", "config", "agents", "deploy", "maintain", "users", "tenants", "audit", "evolution", "secrets"]);

export default function AdminShell({
  route,
  onNavigate,
  wsState,
  role,
  onLogout,
  children,
  clusterSummary,
}) {
  const current = NAV_FLAT.find((n) => n.id === route) || NAV_FLAT[0];
  const isWide = WIDE_ROUTES.has(route);
  const isFill = FILL_ROUTES.has(route);
  const summary = clusterSummary || {};
  const groupLabel = GROUP_BY_ROUTE[current.id] || "紫微";

  const frameMods = [
    isWide ? "admin-content__frame--wide" : "",
    isFill ? "admin-content__frame--fill" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const topbarFrameMods = isWide ? "admin-topbar__frame--wide" : "";

  return (
    <div className="admin-app brand-shell" data-agent="platform">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <img className="admin-brand__logo" src={BRAND_LOGOS.platform} alt="" width={36} height={36} />
          <div className="admin-brand__text">
            <strong>紫微</strong>
            <span className="admin-brand__tag">Agent 控制面</span>
          </div>
        </div>
        <nav className="admin-nav" aria-label="主导航">
          {NAV_GROUPS.map((group) => (
            <div className="admin-nav__group" key={group.id}>
              <div className="admin-nav__group-label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`admin-nav__item ${route === item.id ? "admin-nav__item--active" : ""}`}
                  onClick={() => onNavigate(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="admin-sidebar__foot">
          <span className={`badge badge--ws ${wsState}`}>{WS_LABEL[wsState] || wsState}</span>
          <span className="admin-role">{role || "—"}</span>
        </div>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <div className={`admin-topbar__frame ${topbarFrameMods}`}>
            <div className="admin-topbar__text">
              <p className="admin-topbar__kicker">{groupLabel}</p>
              <h1 className="admin-topbar__title">{current.label}</h1>
              <p className="admin-topbar__sub">{current.desc}</p>
            </div>
            <div className="admin-topbar__chips" aria-label="集群摘要">
              <span className="shell-chip">
                运行 <strong>{summary.running ?? "—"}</strong>
                <span className="shell-chip__muted">/{summary.total ?? "—"}</span>
              </span>
              <span className={`shell-chip ${summary.alerts ? "shell-chip--warn" : ""}`}>
                告警 <strong>{summary.alerts ?? 0}</strong>
              </span>
              <span className="shell-chip shell-chip--mono" title={summary.configVersion || ""}>
                cfg <strong>{summary.configVersion ? String(summary.configVersion).slice(0, 8) : "—"}</strong>
              </span>
            </div>
            <div className="admin-topbar__actions">
              {route !== "monitor" ? (
                <button type="button" className="btn-ghost" onClick={() => onNavigate("monitor")}>
                  监控与日志
                </button>
              ) : null}
              <button type="button" className="btn-ghost btn-ghost--muted" onClick={onLogout}>
                退出
              </button>
              <img
                className="brand-topbar__avatar"
                src={BRAND_AVATARS.platform}
                alt=""
                width={44}
                height={44}
                title="紫微 · 虚拟形象"
              />
            </div>
          </div>
        </header>
        <div className={`admin-content ${isFill ? "admin-content--fill" : ""}`}>
          <div className={`admin-content__frame ${frameMods}`}>{children}</div>
        </div>
      </div>
    </div>
  );
}
