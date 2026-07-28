import { useMemo, useState } from "react";
import { agentListLabel, agentTitle, getAgentDisplay } from "../agentDisplayNames";

export default function AgentControlPanel({
  controlMode,
  controlMessage,
  loading,
  sortedAgents,
  runtime,
  runtimeMeta,
  agentForm,
  setAgentForm,
  onRefresh,
  onStartAll,
  onStopAll,
  onStart,
  onStop,
  onDrain,
  onRollingRestart,
  onSubmitRegister,
}) {
  const [selected, setSelected] = useState(() => new Set());
  const byName = runtimeMeta?.byName || {};
  const configVersion = runtimeMeta?.config_package?.version || "";

  const rows = useMemo(
    () =>
      sortedAgents.map((agent) => {
        const meta = byName[agent.name] || {};
        const actual = meta.actual_state || (runtime[agent.name] ? "running" : "stopped");
        const desired = meta.desired_state || "running";
        const controllable = meta.controllable !== false;
        const aligned = desired === actual;
        return { agent, meta, actual, desired, controllable, aligned };
      }),
    [sortedAgents, byName, runtime]
  );

  const running = rows.filter((r) => r.actual === "running").length;
  const drift = rows.filter((r) => !r.aligned).length;

  const toggle = (name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === rows.length) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(rows.map((r) => r.agent.name)));
  };

  return (
    <div className="page-stack page-stack--fill fleet-panel">
      <div className="fleet-hero">
        <div>
          <p className="panel-eyebrow">舰队管控</p>
          <h2 className="fleet-hero__title">Agent 矩阵</h2>
          <p className="panel-desc">期望态 / 实际态 · Drain · 滚动重启 · 批量选择</p>
        </div>
        <div className="fleet-hero__stats">
          <div className="fleet-stat">
            <span className="fleet-stat__label">模式</span>
            <code>{controlMode}</code>
          </div>
          <div className="fleet-stat">
            <span className="fleet-stat__label">运行</span>
            <strong>
              {running}/{rows.length}
            </strong>
          </div>
          <div className={`fleet-stat ${drift ? "fleet-stat--warn" : ""}`}>
            <span className="fleet-stat__label">漂移</span>
            <strong>{drift}</strong>
          </div>
          <div className="fleet-stat fleet-stat--mono">
            <span className="fleet-stat__label">config</span>
            <code>{configVersion ? String(configVersion).slice(0, 8) : "—"}</code>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__meta">
          <span className="muted">已选 {selected.size}</span>
        </div>
        <div className="toolbar__actions">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={onRefresh}>
            刷新
          </button>
          <button type="button" className="btn-sm" disabled={loading} onClick={onStartAll}>
            启动全部
          </button>
          <button type="button" className="btn-ghost btn-sm" disabled={loading} onClick={onStopAll}>
            停止全部
          </button>
        </div>
      </div>

      {controlMessage ? <p className="inline-notice">{controlMessage}</p> : null}

      <div className="data-table-wrap fleet-matrix-wrap">
        <table className="data-table fleet-matrix">
          <thead>
            <tr>
              <th className="fleet-matrix__check">
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                />
              </th>
              <th>Agent</th>
              <th>类别</th>
              <th>期望</th>
              <th>实际</th>
              <th>一致性</th>
              <th>版本</th>
              <th className="data-table__actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted data-table__empty">
                  暂无 Agent
                </td>
              </tr>
            ) : (
              rows.map(({ agent, meta, actual, desired, controllable, aligned }) => (
                <tr
                  key={agent.agent_id}
                  className={[
                    !controllable ? "fleet-row--disabled" : "",
                    !aligned ? "fleet-row--drift" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <td className="fleet-matrix__check">
                    <input
                      type="checkbox"
                      checked={selected.has(agent.name)}
                      onChange={() => toggle(agent.name)}
                      aria-label={`选择 ${agentListLabel(agent.name)}`}
                    />
                  </td>
                  <td>
                    <strong>{agentTitle(agent.name)}</strong>
                    <div className="muted truncate">
                      {getAgentDisplay(agent.name)?.role || agent.category}
                    </div>
                    <div className="muted truncate code-inline">{agent.name} · {agent.endpoint}</div>
                  </td>
                  <td className="muted">{agent.category}</td>
                  <td>
                    <span className={`status-pill ${desired === "running" ? "online" : "offline"}`}>
                      {desired}
                    </span>
                  </td>
                  <td>
                    <span className={`status-pill ${actual === "running" ? "online" : "offline"}`}>
                      {actual}
                    </span>
                  </td>
                  <td>
                    <span className={`align-dot ${aligned ? "align-dot--ok" : "align-dot--drift"}`} title={aligned ? "一致" : "漂移"} />
                    <span className="muted">{aligned ? "一致" : "漂移"}</span>
                  </td>
                  <td className="muted">
                    <code className="code-inline">{meta.image_version || runtimeMeta?.image_version || "—"}</code>
                  </td>
                  <td className="data-table__actions-col">
                    <div className="table-actions table-actions--dense">
                      <button type="button" className="btn-ghost btn-xs" disabled={!controllable || loading} onClick={() => onStart(agent.name)}>
                        启动
                      </button>
                      <button type="button" className="btn-ghost btn-xs" disabled={!controllable || loading} onClick={() => onStop(agent.name)}>
                        停止
                      </button>
                      <button type="button" className="btn-ghost btn-xs" disabled={!controllable || loading} onClick={() => onDrain?.(agent.name)}>
                        Drain
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-xs"
                        disabled={!controllable || loading}
                        onClick={() => onRollingRestart?.(agent.name)}
                      >
                        滚动重启
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <details className="panel-fold">
        <summary>手动注册 Agent</summary>
        <form onSubmit={onSubmitRegister} className="form form--inline-grid">
          <input
            placeholder="Agent 名称"
            value={agentForm.name}
            onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
            required
          />
          <input
            placeholder="Endpoint，例如 http://localhost:13101"
            value={agentForm.endpoint}
            onChange={(e) => setAgentForm({ ...agentForm, endpoint: e.target.value })}
            required
          />
          <select
            value={agentForm.category}
            onChange={(e) => setAgentForm({ ...agentForm, category: e.target.value })}
          >
            <option value="general">general</option>
            <option value="manager">manager</option>
            <option value="crawler">crawler</option>
            <option value="data">data</option>
            <option value="rag">rag</option>
            <option value="code">code</option>
          </select>
          <select
            value={agentForm.status}
            onChange={(e) => setAgentForm({ ...agentForm, status: e.target.value })}
          >
            <option value="online">online</option>
            <option value="offline">offline</option>
          </select>
          <button disabled={loading} type="submit" className="btn-sm">
            {loading ? "提交中…" : "注册"}
          </button>
        </form>
      </details>
    </div>
  );
}
