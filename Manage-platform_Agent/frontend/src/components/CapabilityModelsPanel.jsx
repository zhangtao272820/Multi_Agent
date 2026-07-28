import { useEffect, useMemo, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

const LAYER_ORDER = ["route", "reason", "coder", "vision", "asr", "rerank", "embedding", "embedding_rag", "ocr", "vision_music", "omni"];

export default function CapabilityModelsPanel({ apiBase, token, role, onMessage }) {
  const [layers, setLayers] = useState([]);
  const [models, setModels] = useState({});
  const [defaults, setDefaults] = useState({});
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const canEdit = role === "operator" || role === "admin";

  const layerById = useMemo(() => {
    const m = {};
    for (const l of layers) m[l.id] = l;
    return m;
  }, [layers]);

  const load = async () => {
    setLoading(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/capability-models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setLoading(false);
    if (!ok) {
      onMessage?.(error || "加载能力层模型失败");
      return;
    }
    setLayers(Array.isArray(data?.layers) ? data.layers : []);
    setModels(data?.models && typeof data.models === "object" ? data.models : {});
    setDefaults(data?.defaults && typeof data.defaults === "object" ? data.defaults : {});
    setConfigured(Boolean(data?.capability_configured));
  };

  useEffect(() => {
    if (token) void load();
  }, [token]);

  const setModel = (id, value) => {
    setModels((prev) => ({ ...prev, [id]: value }));
  };

  const resetDefaults = () => {
    setModels({ ...defaults });
  };

  const save = async (syncEnvFiles = false) => {
    if (!canEdit) return;
    setSaving(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/capability-models`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        models,
        sync_agent_configs: true,
        sync_env_files: syncEnvFiles,
      }),
    });
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "保存能力层失败");
      return;
    }
    const n = (data?.synced_agents || []).length;
    const envN = (data?.env_synced || []).length;
    onMessage?.(
      `能力层已保存并下发到 ${n} 个 Agent${envN ? `，${envN} 个 .env 已同步` : ""}；runtime sync 约 60s 内生效`
    );
    setConfigured(true);
    await load();
  };

  const reapply = async (syncEnvFiles = false) => {
    if (!canEdit) return;
    setSaving(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/capability-models/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sync_env_files: syncEnvFiles }),
    });
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "重新下发失败");
      return;
    }
    onMessage?.(`已重新下发到 ${(data?.synced_agents || []).length} 个 Agent`);
    await load();
  };

  const sortedLayers = [...layers].sort(
    (a, b) => LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id) || a.id.localeCompare(b.id)
  );

  return (
    <section className="config-capability card animate-in">
      <header className="config-capability__head">
        <div>
          <h3>能力层模型（全集群 SSOT）</h3>
          <p className="muted">
            修改一处，自动映射到各 Agent 环境变量；已接入 runtime sync 的子 Agent 约 60s 内生效。
            {configured ? " · 已由控制台配置" : " · 当前为默认种子值"}
          </p>
        </div>
        <div className="config-capability__actions">
          <button type="button" className="btn btn-ghost" disabled={loading || saving} onClick={() => load()}>
            刷新
          </button>
          <button type="button" className="btn btn-ghost" disabled={!canEdit || saving} onClick={resetDefaults}>
            恢复默认
          </button>
          <button type="button" className="btn btn-ghost" disabled={!canEdit || saving} onClick={() => reapply(true)}>
            重新下发
          </button>
          <button type="button" className="btn btn-ghost" disabled={!canEdit || saving} onClick={() => save(false)}>
            仅保存 DB
          </button>
          <button type="button" className="btn btn-primary" disabled={!canEdit || saving} onClick={() => save(true)}>
            {saving ? "保存中…" : "保存并下发"}
          </button>
        </div>
      </header>

      {loading ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="config-capability__grid">
          {sortedLayers.map((layer) => (
            <label key={layer.id} className="config-capability__field">
              <span className="config-capability__label">
                {layer.label}
                <small>{layer.env}</small>
              </span>
              <input
                type="text"
                disabled={!canEdit}
                value={models[layer.id] ?? ""}
                placeholder={defaults[layer.id] || layerById[layer.id]?.description}
                onChange={(e) => setModel(layer.id, e.target.value)}
              />
              <small className="muted">{layer.description}</small>
            </label>
          ))}
        </div>
      )}

      <footer className="config-capability__foot muted">
        T0 路由 · T1 推理 · T2 代码 · T3 视觉 · T4 语音 · T5 重排 · E0 向量。详见 docs/企业级能力层模型方案.md
      </footer>
    </section>
  );
}
