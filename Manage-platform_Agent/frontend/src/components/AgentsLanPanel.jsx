import { useEffect, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

export default function AgentsLanPanel({ apiBase, token, role, onMessage, onGotoSettings }) {
  const [values, setValues] = useState({});
  const [fields, setFields] = useState([]);
  const [secrets, setSecrets] = useState([]);
  const [hint, setHint] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const canEdit = role === "operator" || role === "admin";

  const load = async () => {
    setLoading(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/agents-lan`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setLoading(false);
    if (!ok) {
      onMessage?.(error || "加载 agents-lan 失败");
      return;
    }
    setValues(data?.values || {});
    setFields(Array.isArray(data?.fields) ? data.fields : []);
    setSecrets(Array.isArray(data?.secrets) ? data.secrets : []);
    setHint(Array.isArray(data?.recreate_hint) ? data.recreate_hint : []);
  };

  useEffect(() => {
    if (token) void load();
  }, [token]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    const { ok, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/agents-lan`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "保存失败");
      return;
    }
    onMessage?.(`已写入 .env.agents-lan；建议 recreate：${hint.join(", ") || "相关服务"}`);
    await load();
  };

  const recreateHint = async () => {
    if (!canEdit || !hint.length) return;
    setSaving(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/ops/deploy/recreate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ services: hint, build: false }),
    });
    setSaving(false);
    onMessage?.(ok && data?.ok ? `已 recreate：${hint.join(", ")}` : error || "recreate 失败");
  };

  return (
    <section className="config-capability card animate-in">
      <header className="config-capability__head">
        <div>
          <h2>集群基建（.env.agents-lan）</h2>
          <p className="muted">端口 / 超时 / 搜索基础设施；密钥请到系统设置 Vault</p>
        </div>
        <div className="config-capability__actions">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={load}>
            刷新
          </button>
          {canEdit ? (
            <>
              <button type="button" className="btn-primary btn-sm" disabled={saving} onClick={save}>
                {saving ? "保存中…" : "保存"}
              </button>
              {hint.length ? (
                <button type="button" className="btn-secondary btn-sm" disabled={saving} onClick={recreateHint}>
                  recreate 建议服务
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <div className="config-capability__grid">
        {fields.map((f) => (
          <label key={f.key} className="config-capability__field">
            <span className="config-capability__label">{f.label || f.key}</span>
            <input
              value={values[f.key] || ""}
              disabled={!canEdit}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {secrets.length ? (
        <footer className="config-capability__foot muted">
          密钥键 {secrets.filter((s) => s.configured).length}/{secrets.length} 已配置（不在此展示明文）。
          {onGotoSettings ? (
            <button type="button" className="btn-ghost btn-sm" onClick={onGotoSettings}>
              去治理页
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
