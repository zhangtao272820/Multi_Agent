import { agentTitle } from "../agentDisplayNames";

function statusClass(status) {
  if (status === "healthy" || status === "online" || status === "reachable") return "online";
  if (status === "degraded" || status === "unknown") return "degraded";
  return "offline";
}

function infraChecks(checks) {
  return (checks || []).filter((c) => c.name === "PostgreSQL" || c.name === "Redis");
}

function agentChecks(checks) {
  return (checks || []).filter((c) => c.name !== "PostgreSQL" && c.name !== "Redis");
}

export default function OpsOverview({
  healthOverview,
  managerCluster,
  monitorSummary,
  envSnapshot,
  promSnapshot,
  platformError,
  loading,
  onRefresh,
}) {
  const agents = agentChecks(healthOverview?.checks);
  const infra = infraChecks(healthOverview?.checks);
  const healthyAgents = agents.filter((c) => c.status === "healthy").length;
  const phases = managerCluster?.metrics?.data?.phases || monitorSummary?.manager_phases || {};
  const tokenSummary =
    managerCluster?.metrics?.data?.tokenSummary || monitorSummary?.manager_token_summary || {};
  const phaseRows = Object.entries(phases)
    .sort((a, b) => (b[1]?.avgMs || 0) - (a[1]?.avgMs || 0))
    .slice(0, 8);
  const registryEntries =
    managerCluster?.registry?.data?.registry?.entries ||
    managerCluster?.registry?.data?.entries ||
    [];

  return (
    <section className="panel ops-panel">
      <div className="ops-header">
        <div>
          <p className="panel-eyebrow">运维总览</p>
          <h2 className="ops-title">Control Plane Health</h2>
          <p className="panel-desc">健康探活 · Manager 集群 · 编排指标</p>
        </div>
        <div className="ops-header__right">
          <div className={`health-ring health-ring--${statusClass(healthOverview?.overall_status)}`} title={healthOverview?.overall_status || ""}>
            <span>{healthyAgents}/{agents.length || 0}</span>
          </div>
          <button type="button" className="btn-secondary" disabled={loading} onClick={onRefresh}>
            刷新全部
          </button>
        </div>
      </div>

      <div className="status-band">
        <span className={`status-band__item ${statusClass(healthOverview?.overall_status)}`}>
          平台 {healthOverview?.overall_status || "—"}
        </span>
        <span className={`status-band__item ${managerCluster?.ok ? "online" : "degraded"}`}>
          Manager {managerCluster?.ok ? "可达" : "不可达"}
        </span>
        <span className="status-band__item muted">
          Agent {healthyAgents}/{agents.length || "—"} 正常
        </span>
      </div>

      <div className="kpi-grid kpi-grid--6">
        <div className="kpi-tile">
          <span className="kpi-label">平台健康</span>
          <span className={`status ${statusClass(healthOverview?.overall_status)}`}>
            {healthOverview?.overall_status || "—"}
          </span>
          <span className="kpi-meta">
            Agent {healthyAgents}/{agents.length || "—"} 正常
          </span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Manager</span>
          <span className={`status ${managerCluster?.ok ? "online" : "degraded"}`}>
            {managerCluster?.ok ? "可达" : "不可达"}
          </span>
          <span className="kpi-meta">
            runs {managerCluster?.metrics?.data?.runs ?? monitorSummary?.manager_runs ?? "—"}
          </span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Token（窗口）</span>
          <span className="kpi-value">{tokenSummary?.totalTokens ?? "—"}</span>
          <span className="kpi-meta">Manager metrics.jsonl</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Prometheus Token</span>
          <span className="kpi-value">{promSnapshot?.managerTokens ?? "—"}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">异常 Agent</span>
          <span
            className={`status ${
              (monitorSummary?.down_agents?.length || 0) +
                agents.filter((c) => c.status !== "healthy").length >
              0
                ? "degraded"
                : "online"
            }`}
          >
            {Math.max(
              monitorSummary?.down_agents?.length || 0,
              agents.filter((c) => c.status !== "healthy").length
            )}
          </span>
          <span className="kpi-meta">探活未通过</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">注册表</span>
          <span className="kpi-value">{registryEntries.length || monitorSummary?.registry_count || "—"}</span>
          <span className="kpi-meta">Manager 能力条目</span>
        </div>
      </div>

      {infra.length ? (
        <div className="ops-section">
          <h3 className="card-section-title">基础依赖</h3>
          <div className="chip-row">
            {infra.map((c) => (
              <span key={c.name} className={`health-chip ${statusClass(c.status)}`} title={c.target}>
                {c.name} · {c.latency_ms}ms
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="ops-section">
        <h3 className="card-section-title">子 Agent 探活</h3>
        {!agents.length ? <p className="muted">暂无探活数据</p> : null}
        <div className="chip-row chip-row--scroll">
          {agents.map((c) => (
            <span
              key={c.name}
              className={`health-chip ${statusClass(c.status)}`}
              title={`${c.target}${c.probe_path ? ` · ${c.probe_path}` : ""}`}
            >
              {agentTitle(c.name)} {c.latency_ms}ms
            </span>
          ))}
        </div>
      </div>

      {managerCluster?.ok && phaseRows.length ? (
        <div className="ops-section">
          <h3 className="card-section-title">Manager 阶段耗时（均值 ms）</h3>
          <div className="phase-bars">
            {phaseRows.map(([name, v]) => (
              <div className="phase-bar" key={name}>
                <span className="phase-bar__label">{name}</span>
                <div className="phase-bar__track">
                  <div
                    className="phase-bar__fill"
                    style={{ width: `${Math.min(100, (v.avgMs || 0) / 120)}%` }}
                  />
                </div>
                <span className="phase-bar__val">{v.avgMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {platformError ? (
        <p className="control-message control-message--warn">{platformError}</p>
      ) : null}

      {managerCluster && !managerCluster.ok ? (
        <p className="control-message">
          Manager 不可达：{managerCluster.error || managerCluster.metrics?.error || monitorSummary?.manager_error || "请执行 docker compose up -d manager_agent"}
        </p>
      ) : null}

      {(monitorSummary?.down_agents || []).length ? (
        <div className="ops-section">
          <h3 className="card-section-title">不可用登记</h3>
          <div className="chip-row">
            {monitorSummary.down_agents.map((a) => (
              <span key={a.name} className="health-chip offline" title={a.target}>
                {agentTitle(a.name)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <details className="ops-details">
        <summary>环境登记（只读）· {envSnapshot?.agents?.length || 0} 项</summary>
        {envSnapshot?.agents?.length ? (
          <div className="compact-table">
            {envSnapshot.agents.map((a) => (
              <div className="compact-table__row" key={a.name}>
                <span>{a.name}</span>
                <span className="muted">{a.endpoint}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">点击「刷新全部」加载 env-snapshot</p>
        )}
      </details>
    </section>
  );
}
