import { useEffect, useMemo, useState } from "react";
import { fetchJsonSafe } from "../utils/api";
import { agentListLabel, agentTitle, getAgentDisplay } from "../agentDisplayNames";
import CapabilityModelsPanel from "./CapabilityModelsPanel";
import ConvergenceModesPanel from "./ConvergenceModesPanel";
import AgentsLanPanel from "./AgentsLanPanel";

const emptyForm = {
  port: "",
  endpoint: "",
};

export default function AgentConfigPanel({ apiBase, token, role, onMessage, onNavigate }) {
  const [agents, setAgents] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [localEnv, setLocalEnv] = useState(null);
  const [localForm, setLocalForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const canEdit = role === "operator" || role === "admin";

  const syncByAgent = useMemo(() => {
    const map = {};
    for (const a of syncStatus?.agents || []) {
      map[a.agent_name] = a;
    }
    return map;
  }, [syncStatus]);

  const load = async () => {
    setLoading(true);
    const [cfgRes, syncRes] = await Promise.all([
      fetchJsonSafe(`${apiBase}/api/agents/config`, { headers: { Authorization: `Bearer ${token}` } }),
      fetchJsonSafe(`${apiBase}/api/agents/config/sync-status`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    setLoading(false);
    if (!cfgRes.ok) {
      onMessage?.(cfgRes.error || "加载 Agent 配置失败");
      return;
    }
    const rows = Array.isArray(cfgRes.data?.agents) ? cfgRes.data.agents : [];
    setAgents(rows);
    if (syncRes.ok) setSyncStatus(syncRes.data);
    if (!selected && rows.length) {
      setSelected(rows[0].agent_name || rows[0].name);
    }
  };

  const loadLocal = async (name) => {
    if (!name) {
      setLocalEnv(null);
      setLocalForm({});
      return;
    }
    const { ok, data } = await fetchJsonSafe(
      `${apiBase}/api/agents/config/${encodeURIComponent(name)}/local-env`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (ok) {
      setLocalEnv(data);
      setLocalForm({ ...(data.editable || {}) });
    } else {
      setLocalEnv(null);
      setLocalForm({});
    }
  };

  useEffect(() => {
    if (token) void load();
  }, [token]);

  useEffect(() => {
    const row = agents.find((a) => (a.agent_name || a.name) === selected);
    if (!row) {
      setForm(emptyForm);
      return;
    }
    setForm({
      port: row.port || "",
      endpoint: row.endpoint || "",
    });
    void loadLocal(selected);
  }, [selected, agents]);

  const restartAgent = async (forceRecreate = false) => {
    if (!canEdit || !selected) return;
    setRestarting(true);
    const q = forceRecreate ? "?force_recreate=true" : "";
    const { ok, error } = await fetchJsonSafe(
      `${apiBase}/api/agents/${encodeURIComponent(selected)}/restart${q}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    setRestarting(false);
    if (!ok) {
      onMessage?.(error || "Docker 重启失败");
      return;
    }
    onMessage?.(`已重启 Docker 服务：${selected}`);
  };

  const restartManagerStack = async () => {
    if (!canEdit) return;
    setRestarting(true);
    const { ok, error } = await fetchJsonSafe(`${apiBase}/api/agents/actions/restart-manager-stack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setRestarting(false);
    if (!ok) {
      onMessage?.(error || "Manager 全家桶重启失败");
      return;
    }
    onMessage?.("已重启 Manager 协作链");
  };

  const save = async () => {
    if (!canEdit || !selected) return;
    setSaving(true);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/agents/config/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        port: form.port,
        endpoint: form.endpoint,
      }),
    });
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "保存失败");
      return;
    }
    const agent = data?.agent;
    onMessage?.(
      agent?.requires_restart
        ? `已保存 ${selected}；端口/端点变更请重启容器`
        : `已保存 ${selected}`
    );
    await load();
  };

  const saveLocal = async () => {
    if (!canEdit || !selected) return;
    setSaving(true);
    const { ok, error } = await fetchJsonSafe(
      `${apiBase}/api/agents/config/${encodeURIComponent(selected)}/local-env`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: localForm }),
      }
    );
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "本地 .env 保存失败");
      return;
    }
    onMessage?.(`已写入 ${selected} 本地键；需重启才对未接 runtime sync 的键生效`);
    await loadLocal(selected);
  };

  const current = agents.find((a) => (a.agent_name || a.name) === selected);
  const currentSync = syncByAgent[selected];
  const summary = syncStatus?.summary;

  return (
    <div className="page-stack page-stack--fill config-page">
      <CapabilityModelsPanel apiBase={apiBase} token={token} role={role} onMessage={onMessage} />
      <ConvergenceModesPanel apiBase={apiBase} token={token} role={role} onMessage={onMessage} />
      <AgentsLanPanel
        apiBase={apiBase}
        token={token}
        role={role}
        onMessage={onMessage}
        onGotoSettings={onNavigate ? () => onNavigate("settings") : undefined}
      />

      <div className="config-strip animate-in">
        {summary ? (
          <div className="config-stats config-stats--inline">
            <div className="config-stat">
              <span className="config-stat__label">Agent</span>
              <span className="config-stat__value">{summary.total}</span>
            </div>
            <div className="config-stat">
              <span className="config-stat__label">Sync</span>
              <span className="config-stat__value">{summary.runtime_sync_count}</span>
            </div>
            <div className={`config-stat ${summary.model_drift_count ? "config-stat--warn" : ""}`}>
              <span className="config-stat__label">模型↑</span>
              <span className="config-stat__value">{summary.model_drift_count ?? 0}</span>
            </div>
            <div className={`config-stat ${summary.mode_drift_count ? "config-stat--warn" : ""}`}>
              <span className="config-stat__label">MODE↑</span>
              <span className="config-stat__value">{summary.mode_drift_count ?? 0}</span>
            </div>
          </div>
        ) : null}

        <div className="config-strip__group config-strip__group--end">
          <button type="button" className="btn-secondary btn-sm" disabled={loading} onClick={load}>
            {loading ? "加载中…" : "刷新"}
          </button>
          {canEdit ? (
            <>
              <button type="button" className="btn-secondary btn-sm" disabled={restarting || !selected} onClick={() => restartAgent(false)}>
                {restarting ? "重启中…" : "重启 Agent"}
              </button>
              <button type="button" className="btn-secondary btn-sm" disabled={restarting || !selected} onClick={() => restartAgent(true)}>
                强制重建
              </button>
              <button type="button" className="btn-secondary btn-sm" disabled={restarting} onClick={restartManagerStack}>
                重启 Manager
              </button>
            </>
          ) : null}
        </div>
      </div>

      <details className="config-hierarchy-fold">
        <summary>配置层级 · 四层 SSOT</summary>
        <ol>
          <li>
            <strong>能力层模型</strong> — `.env.capability-models` / 控制台能力层面板
          </li>
          <li>
            <strong>收敛 MODE</strong> — `.env.convergence-modes`
          </li>
          <li>
            <strong>集群基建</strong> — `.env.agents-lan`（密钥走治理 Vault）
          </li>
          <li>
            <strong>Agent 本地白名单</strong> — 各 Agent `.env` 业务键；端口/Endpoint 见 agent_configs
          </li>
        </ol>
      </details>

      <div className="config-layout animate-in animate-in--delay">
        <div className="config-list">
          {agents.map((a) => {
            const name = a.agent_name || a.name;
            const st = syncByAgent[name];
            return (
              <button
                key={name}
                type="button"
                className={`config-list__item ${selected === name ? "config-list__item--active" : ""}`}
                onClick={() => setSelected(name)}
              >
                <strong>{agentTitle(name)}</strong>
                <span>{getAgentDisplay(name)?.role || a.category}</span>
                <small>
                  {name} · {a.port ? `:${a.port}` : "—"} · {a.endpoint || "—"}
                </small>
                <div className="config-list__badges">
                  {st?.runtime_sync ? <span className="config-badge config-badge--sync">SYNC</span> : null}
                  {st?.model_drift ? <span className="config-badge config-badge--drift">模型↑</span> : null}
                  {st?.mode_drift ? <span className="config-badge config-badge--drift">MODE↑</span> : null}
                  {!st?.runtime_sync ? <span className="config-badge config-badge--env">ENV</span> : null}
                </div>
              </button>
            );
          })}
        </div>

        <div className="config-editor">
          {!selected ? (
            <p className="muted">请选择左侧 Agent</p>
          ) : (
            <>
              <div className="config-editor__head">
                <div>
                  <h3>{agentTitle(selected)}</h3>
                  <p className="config-editor__meta">
                    {agentListLabel(selected)} · <code>{selected}</code>
                    {current?.docker_service ? (
                      <>
                        {" · "}Docker <code>{current.docker_service}</code>
                      </>
                    ) : null}
                    {currentSync?.env_file ? (
                      <>
                        {" · "}Env <code>{currentSync.env_file}</code>
                      </>
                    ) : null}
                  </p>
                </div>
                {currentSync?.runtime_sync ? (
                  <span className="config-badge config-badge--sync">Runtime Sync 已接入</span>
                ) : (
                  <span className="config-badge config-badge--env">仅 .env / 需重启</span>
                )}
              </div>

              <p className="config-drift-box config-drift-box--ok">
                模型 / MODE 由上方 SSOT 统一下发。
                {currentSync?.mode_drift
                  ? ` MODE 漂移键：${(currentSync.mode_drift_keys || []).join(", ") || "有"}。`
                  : null}
                {currentSync?.env_file_model_mismatch && currentSync?.runtime_sync
                  ? " 本地 .env 模型键与平台三槽不一致时，runtime 仍以平台 pull 为准。"
                  : null}
              </p>

              <div className="config-form-grid">
                <label>
                  端口
                  <input value={form.port} disabled={!canEdit} onChange={(e) => setForm({ ...form, port: e.target.value })} />
                </label>
                <label className="label--full">
                  Endpoint
                  <input
                    value={form.endpoint}
                    disabled={!canEdit}
                    onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                  />
                </label>
              </div>

              <div className="config-editor__actions">
                {canEdit ? (
                  <button type="button" className="btn-primary" disabled={saving} onClick={save}>
                    {saving ? "保存中…" : "保存端口/端点"}
                  </button>
                ) : (
                  <p className="muted">当前角色只读；需 operator / admin</p>
                )}
              </div>

              <h4 style={{ marginTop: 20 }}>本地环境变量（白名单）</h4>
              {localEnv?.secrets?.length ? (
                <p className="muted">
                  密钥 {localEnv.secrets.filter((s) => s.configured).length}/{localEnv.secrets.length} 已配置（不明文展示）
                </p>
              ) : null}
              {(localEnv?.editable_keys || []).length === 0 ? (
                <p className="muted">该 Agent 暂无额外本地可编辑键（模型/MODE 由 SSOT 管理）</p>
              ) : (
                <div className="config-form-grid">
                  {(localEnv.editable_keys || []).map((k) => (
                    <label key={k}>
                      {k}
                      <input
                        value={localForm[k] || ""}
                        disabled={!canEdit}
                        onChange={(e) => setLocalForm({ ...localForm, [k]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
              )}
              {canEdit && (localEnv?.editable_keys || []).length > 0 ? (
                <div className="config-editor__actions">
                  <button type="button" className="btn-primary" disabled={saving} onClick={saveLocal}>
                    保存本地 .env
                  </button>
                </div>
              ) : null}

              {(localEnv?.readonly_from_ssot || []).length > 0 ? (
                <details style={{ marginTop: 12 }}>
                  <summary>只读（来自能力层 / MODE）</summary>
                  <ul className="muted">
                    {localEnv.readonly_from_ssot.slice(0, 40).map((r) => (
                      <li key={r.key}>
                        <code>{r.key}</code>={r.value || "—"} <small>({r.source})</small>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
