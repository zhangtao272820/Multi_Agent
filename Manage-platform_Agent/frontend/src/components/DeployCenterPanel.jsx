import { useEffect, useState } from "react";
import { fetchJsonSafe } from "../utils/api";
import { agentListLabel, agentTitle } from "../agentDisplayNames";

export default function DeployCenterPanel({ apiBase, token, role, onMessage }) {
  const [status, setStatus] = useState(null);
  const [rollbackTag, setRollbackTag] = useState("");
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastJob, setLastJob] = useState(null);
  const canEdit = role === "operator" || role === "admin";

  const load = async () => {
    setLoading(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/ops/deploy/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setLoading(false);
    if (!ok) {
      onMessage?.(error || "加载部署状态失败");
      return;
    }
    setStatus(data);
    if (!rollbackTag && data?.image_tag) setRollbackTag(data.image_tag);
  };

  useEffect(() => {
    if (token) void load();
  }, [token]);

  const toggleAgent = (name) => {
    setSelectedAgents((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  };

  const recreate = async (payload) => {
    if (!canEdit) return;
    setBusy(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/ops/deploy/recreate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    setLastJob(data || { ok: false, stderr: error });
    onMessage?.(ok && data?.ok ? "force-recreate 完成" : error || (data?.errors || []).join("; ") || "recreate 失败");
    await load();
  };

  const rollback = async () => {
    if (!canEdit || !rollbackTag.trim()) return;
    if (!window.confirm(`确认回滚到镜像 tag：${rollbackTag}？将 force-recreate 全家桶。`)) return;
    setBusy(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/ops/deploy/rollback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_tag: rollbackTag.trim() }),
    });
    setBusy(false);
    setLastJob(data || { ok: false, stderr: error });
    onMessage?.(ok && data?.ok ? `回滚完成：${rollbackTag}` : error || data?.stderr || "回滚失败");
    await load();
  };

  const health = status?.health || {};
  const offline = status?.offline || {};
  const checks = Array.isArray(health.checks) ? health.checks : [];

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="ops-header">
          <div>
            <p className="panel-eyebrow">部署中心</p>
            <h2 className="ops-title">镜像 · recreate · 回滚 · 离线包</h2>
            <p className="panel-desc">
              封装 compose force-recreate / rollback-agents / 健康门禁。
              镜像 tag 为<strong>全局</strong> <code>CLAWHIVE_IMAGE_TAG</code>
              {status?.image_tag_note ? ` — ${status.image_tag_note}` : "（非 per-service canary）"}
            </p>
          </div>
          <button type="button" className="btn-secondary" disabled={loading} onClick={load}>
            刷新
          </button>
        </div>
        <div className="kpi-grid kpi-grid--4">
          <div className="kpi-tile">
            <span className="kpi-label">CLAWHIVE_IMAGE_TAG</span>
            <span className="kpi-value" style={{ fontSize: "1.1rem" }}>
              {status?.image_tag || "—"}
            </span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-label">控制模式</span>
            <span className="kpi-value" style={{ fontSize: "1.1rem" }}>
              {status?.control_mode || "—"}
            </span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-label">健康</span>
            <span className="kpi-value" style={{ fontSize: "1.1rem" }}>
              {health.overall_status || "—"}
            </span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-label">离线包</span>
            <span className="kpi-value" style={{ fontSize: "1.1rem" }}>
              {offline.images_tar_exists ? "images.tar ✓" : "无"}
            </span>
          </div>
        </div>

        {canEdit ? (
          <div style={{ marginTop: 16, displayAlign: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                recreate({ services: ["clawhive_backend", "clawhive_frontend"], build: true })
              }
            >
              重建平台前后端
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || selectedAgents.length === 0}
              onClick={() => recreate({ agent_names: selectedAgents, build: false })}
            >
              强制重建所选 Agent（{selectedAgents.length}）
            </button>
          </div>
        ) : null}

        {canEdit ? (
          <div className="form" style={{ marginTop: 16, displayAlign: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              style={{ flex: 1, minWidth: 180 }}
              placeholder="回滚目标 tag"
              value={rollbackTag}
              onChange={(e) => setRollbackTag(e.target.value)}
            />
            <button type="button" className="btn-primary" disabled={busy} onClick={rollback}>
              {busy ? "执行中…" : "执行回滚"}
            </button>
          </div>
        ) : (
          <p className="muted">只读角色不可回滚 / recreate</p>
        )}

        {checks.length ? (
          <details style={{ marginTop: 12 }}>
            <summary>健康检查摘要（{checks.length}）</summary>
            <ul className="muted">
              {checks.slice(0, 30).map((c) => (
                <li key={c.name || c.target}>
                  <strong>{c.name || c.target}</strong> · {c.status}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {offline.sha256sums_preview ? (
          <details style={{ marginTop: 12 }}>
            <summary>SHA256SUMS 预览</summary>
            <pre>{offline.sha256sums_preview}</pre>
          </details>
        ) : null}
        {lastJob ? (
          <details open style={{ marginTop: 12 }}>
            <summary>最近 Job 输出</summary>
            <pre>{JSON.stringify(lastJob, null, 2)}</pre>
          </details>
        ) : null}
      </section>
      <section className="panel panel--scroll">
        <p className="panel-eyebrow">托管 Agent（勾选后可强制重建）</p>
        <ul>
          {(status?.agents || []).map((a) => {
            const name = a.agent_name;
            return (
              <li key={name || a.docker_service}>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={selectedAgents.includes(name)}
                    onChange={() => toggleAgent(name)}
                  />
                  <strong>{agentTitle(name)}</strong>
                  <span className="muted">
                    · {agentListLabel(name)} · {a.docker_service || "—"} · {a.category}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
