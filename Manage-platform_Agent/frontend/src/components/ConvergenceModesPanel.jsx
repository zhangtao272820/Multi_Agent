import { useEffect, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

export default function ConvergenceModesPanel({ apiBase, token, role, onMessage }) {
  const [modes, setModes] = useState({});
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const canEdit = role === "operator" || role === "admin";

  const load = async () => {
    setLoading(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/convergence-modes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setLoading(false);
    if (!ok) {
      onMessage?.(error || "加载 MODE 失败");
      return;
    }
    setModes(data?.modes || {});
    setFields(Array.isArray(data?.fields) ? data.fields : []);
  };

  useEffect(() => {
    if (token) void load();
  }, [token]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/convergence-modes`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ modes, sync_env_files: true }),
    });
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "保存 MODE 失败");
      return;
    }
    const n = (data?.env_synced || []).length;
    onMessage?.(`MODE 已保存并下发到 ${n} 处`);
    await load();
  };

  const groups = {};
  for (const f of fields) {
    const g = f.group || "other";
    if (!groups[g]) groups[g] = [];
    groups[g].push(f);
  }

  return (
    <section className="config-capability card animate-in">
      <header className="config-capability__head">
        <div>
          <h2>收敛 MODE（全集群 SSOT）</h2>
          <p className="muted">对应 `.env.convergence-modes`；保存并下发写入各 Agent `.env`</p>
        </div>
        <div className="config-capability__actions">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={load}>
            刷新
          </button>
          {canEdit ? (
            <button type="button" className="btn-primary btn-sm" disabled={saving} onClick={save}>
              {saving ? "保存中…" : "保存并下发"}
            </button>
          ) : null}
        </div>
      </header>
      {Object.entries(groups).map(([group, list]) => (
        <div key={group} className="config-capability__grid" style={{ marginBottom: 12 }}>
          {list.map((f) => (
            <label key={f.key} className="config-capability__field">
              <span className="config-capability__label">{f.label || f.key}</span>
              <input
                value={modes[f.key] || ""}
                disabled={!canEdit}
                onChange={(e) => setModes({ ...modes, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
      ))}
    </section>
  );
}
