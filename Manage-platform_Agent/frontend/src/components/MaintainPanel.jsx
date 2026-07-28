import { useEffect, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

export default function MaintainPanel({ apiBase, token, role, onMessage }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastJob, setLastJob] = useState(null);
  const [health, setHealth] = useState(null);
  const canBackup = role === "operator" || role === "admin";
  const canRestore = role === "admin";

  const load = async () => {
    setLoading(true);
    const [listRes, deployRes] = await Promise.all([
      fetchJsonSafe(`${apiBase}/api/ops/backup/list`, { headers: { Authorization: `Bearer ${token}` } }),
      fetchJsonSafe(`${apiBase}/api/ops/deploy/status`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    setLoading(false);
    if (listRes.ok) setItems(Array.isArray(listRes.data?.items) ? listRes.data.items : []);
    if (deployRes.ok) setHealth(deployRes.data?.health || null);
    if (!listRes.ok) onMessage?.(listRes.error || "加载备份列表失败");
  };

  useEffect(() => {
    if (token) void load();
  }, [token]);

  const backup = async () => {
    if (!canBackup) return;
    setBusy(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/ops/backup/postgres`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setBusy(false);
    setLastJob(data || { ok: false, stderr: error });
    onMessage?.(ok && data?.ok ? "备份完成" : error || data?.stderr || "备份失败");
    await load();
  };

  const restore = async (name) => {
    if (!canRestore) return;
    if (!window.confirm(`确认用 ${name} 覆盖 PostgreSQL？仅 admin，且需二次确认。`)) return;
    setBusy(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/ops/backup/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filename: name, confirm: true }),
    });
    setBusy(false);
    setLastJob(data || { ok: false, stderr: error });
    onMessage?.(ok && data?.ok ? `已恢复 ${name}` : error || data?.stderr || "恢复失败");
    await load();
  };

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="ops-header">
          <div>
            <p className="panel-eyebrow">维护</p>
            <h2 className="ops-title">PostgreSQL 备份 / 恢复</h2>
            <p className="panel-desc">
              封装 backup-postgres / restore-postgres；健康门禁：{health?.overall_status || "—"}。
              手册见 Manage-platform_Agent/README.md「备份 / 恢复」。
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-secondary" disabled={loading} onClick={load}>
              刷新
            </button>
            {canBackup ? (
              <button type="button" className="btn-primary" disabled={busy} onClick={backup}>
                {busy ? "执行中…" : "立即备份"}
              </button>
            ) : null}
          </div>
        </div>
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>文件</th>
              <th>大小</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  暂无备份
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.name}>
                  <td>
                    <code>{it.name}</code>
                  </td>
                  <td>{Math.round((it.size || 0) / 1024)} KB</td>
                  <td>{String(it.mtime || "").slice(0, 19)}</td>
                  <td>
                    {canRestore ? (
                      <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => restore(it.name)}>
                        恢复
                      </button>
                    ) : (
                      <span className="muted">需 admin</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {lastJob ? (
          <details style={{ marginTop: 12 }}>
            <summary>最近 Job</summary>
            <pre>{JSON.stringify(lastJob, null, 2)}</pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}
