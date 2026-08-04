import { useEffect, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

function pct(util) {
  if (util == null || Number.isNaN(Number(util))) return "—";
  return `${Math.round(Number(util) * 100)}%`;
}

/** @param {{ section?: 'tenants' | 'audit' | 'secrets' | 'all' }} props */
export default function SettingsGovernance({ apiBase, token, role, onMessage, section = "all" }) {
  const [secrets, setSecrets] = useState([]);
  const [usage, setUsage] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [promAlerts, setPromAlerts] = useState(null);
  const [notify, setNotify] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [quotaTenant, setQuotaTenant] = useState("default");
  const [quotaValue, setQuotaValue] = useState("");
  const [newTenantId, setNewTenantId] = useState("");
  const [newTenantName, setNewTenantName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [audits, setAudits] = useState([]);
  const [auditAction, setAuditAction] = useState("");
  const [auditActor, setAuditActor] = useState("");
  const [rotating, setRotating] = useState("");

  const showTenants = section === "all" || section === "tenants";
  const showSecrets = section === "all" || section === "secrets";
  const showAudit = section === "all" || section === "audit";

  const canManageQuota = role === "admin";
  const canViewSecrets = role === "operator" || role === "admin";
  const canAudit = role === "admin";

  const load = async () => {
    if (!token) return;
    setLoading(true);
    const reqs = [];
    const keys = [];
    if (showSecrets && canViewSecrets) {
      keys.push("sec");
      reqs.push(fetchJsonSafe(`${apiBase}/api/secrets/refs`, { headers: { Authorization: `Bearer ${token}` } }));
      keys.push("notify");
      reqs.push(
        fetchJsonSafe(`${apiBase}/api/governance/notify-status`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
    }
    if (showTenants || showSecrets) {
      keys.push("use");
      reqs.push(fetchJsonSafe(`${apiBase}/api/tenants/usage`, { headers: { Authorization: `Bearer ${token}` } }));
      keys.push("ten");
      reqs.push(fetchJsonSafe(`${apiBase}/api/tenants`, { headers: { Authorization: `Bearer ${token}` } }));
      keys.push("alert");
      reqs.push(
        fetchJsonSafe(`${apiBase}/api/monitor/prometheus/alerts`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
    }
    if (showAudit && canAudit) {
      const q = new URLSearchParams({ limit: "50" });
      if (auditAction.trim()) q.set("action", auditAction.trim());
      if (auditActor.trim()) q.set("actor", auditActor.trim());
      keys.push("audit");
      reqs.push(
        fetchJsonSafe(`${apiBase}/api/audit-logs?${q}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      keys.push("check");
      reqs.push(
        fetchJsonSafe(`${apiBase}/api/governance/audit-checklist?lookback_days=90`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
    }
    const results = await Promise.all(reqs);
    setLoading(false);
    const byKey = Object.fromEntries(keys.map((k, i) => [k, results[i]]));
    if (byKey.sec?.ok) setSecrets(Array.isArray(byKey.sec.data?.refs) ? byKey.sec.data.refs : []);
    if (byKey.notify?.ok) setNotify(byKey.notify.data);
    if (byKey.use?.ok) setUsage(byKey.use.data);
    if (byKey.ten?.ok) setTenants(Array.isArray(byKey.ten.data?.tenants) ? byKey.ten.data.tenants : []);
    if (byKey.alert?.ok) setPromAlerts(byKey.alert.data);
    if (byKey.audit?.ok) setAudits(Array.isArray(byKey.audit.data) ? byKey.audit.data : []);
    if (byKey.check?.ok) setChecklist(byKey.check.data);
  };

  useEffect(() => {
    void load();
  }, [token, role, section]);

  const saveQuota = async (e) => {
    e.preventDefault();
    if (!canManageQuota) return;
    setSaving(true);
    const raw = String(quotaValue || "").trim();
    const quota_tokens = raw === "" || raw === "0" ? null : Number(raw);
    const { ok, error } = await fetchJsonSafe(
      `${apiBase}/api/tenants/${encodeURIComponent(quotaTenant)}/quota`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ quota_tokens: Number.isFinite(quota_tokens) ? quota_tokens : null }),
      }
    );
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "配额保存失败");
      return;
    }
    onMessage?.(`已更新租户 ${quotaTenant} 月度配额（空=不限）`);
    await load();
  };

  const createTenant = async (e) => {
    e.preventDefault();
    if (!canManageQuota) return;
    const tid = String(newTenantId || "").trim();
    if (!tid) {
      onMessage?.("请填写租户 ID");
      return;
    }
    setSaving(true);
    const { ok, error } = await fetchJsonSafe(`${apiBase}/api/tenants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: tid,
        name: String(newTenantName || tid).trim() || tid,
        status: "active",
      }),
    });
    setSaving(false);
    if (!ok) {
      onMessage?.(error || "创建租户失败");
      return;
    }
    setNewTenantId("");
    setNewTenantName("");
    onMessage?.(`已创建租户 ${tid}`);
    await load();
  };

  const toggleTenantStatus = async (tenantId, status) => {
    if (!canManageQuota) return;
    const next = status === "active" ? "disabled" : "active";
    const { ok, error } = await fetchJsonSafe(`${apiBase}/api/tenants/${encodeURIComponent(tenantId)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (!ok) {
      onMessage?.(error || "更新租户状态失败");
      return;
    }
    onMessage?.(`租户 ${tenantId} → ${next}`);
    await load();
  };

  const rotateSecret = async (refId) => {
    if (!canManageQuota) return;
    const next = window.prompt(`轮换 ${refId}：填入新值可写回进程 env + Vault（留空仅标记 rotated_at）`);
    if (next === null) return;
    setRotating(refId);
    const { ok, data, error } = await fetchJsonSafe(`${apiBase}/api/secrets/${encodeURIComponent(refId)}/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_value: next.trim() ? next.trim() : null }),
    });
    setRotating("");
    if (!ok) {
      onMessage?.(error || data?.detail || "轮换失败");
      return;
    }
    const bits = [];
    if (data?.applied_env) bits.push("已写进程 env");
    if (data?.sealed_stored) bits.push("已 Fernet 落库");
    onMessage?.(`已轮换 ${refId}${bits.length ? `（${bits.join(" · ")}）` : ""}`);
    await load();
  };

  const exportAudits = async () => {
    const q = new URLSearchParams({ format: "csv", limit: "1000" });
    if (auditAction.trim()) q.set("action", auditAction.trim());
    if (auditActor.trim()) q.set("actor", auditActor.trim());
    try {
      const resp = await fetch(`${apiBase}/api/audit-logs/export?${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        onMessage?.(`导出失败：HTTP ${resp.status}`);
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "audit-logs.csv";
      a.click();
      URL.revokeObjectURL(url);
      onMessage?.("审计日志已导出");
      await load();
    } catch (e) {
      onMessage?.(e?.message || "导出失败");
    }
  };

  const firingAlerts =
    promAlerts?.ok && promAlerts?.data?.data?.alerts
      ? promAlerts.data.data.alerts.filter((a) => a.state === "firing")
      : [];

  const tenantRows =
    tenants.length > 0
      ? tenants
      : usage?.tenants || (usage?.tenant_id ? [usage] : []);

  return (
    <div className="gov-stack">
      {showTenants ? (
        <section className="admin-card admin-card--accent">
          <h3 className="admin-card__title">租户与 Token 配额</h3>
          <p className="admin-card__desc">
            租户实体 SSOT · 超配额任务返回 429 · 配额留空=不限（<code>CLAWHIVE_DEFAULT_TENANT_QUOTA_TOKENS</code>）
          </p>
          {loading && !usage && tenants.length === 0 ? <p className="muted">加载中…</p> : null}
          {usage ? (
            <div className="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
              <div className="kpi-tile">
                <span className="kpi-label">账期</span>
                <span className="kpi-value" style={{ fontSize: "1rem" }}>
                  {usage.period || "—"}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">集群合计 Tokens</span>
                <span className="kpi-value" style={{ fontSize: "1rem" }}>
                  {usage.total_tokens != null ? Number(usage.total_tokens).toLocaleString() : "—"}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">默认配额</span>
                <span className="kpi-value" style={{ fontSize: "1rem" }}>
                  {usage.default_quota_tokens != null
                    ? Number(usage.default_quota_tokens).toLocaleString()
                    : "不限"}
                </span>
              </div>
            </div>
          ) : null}
          <div className="compact-table">
            {tenantRows.length === 0 ? (
              <p className="muted">暂无租户记录</p>
            ) : (
              tenantRows.map((t) => (
                <div className="compact-table__row compact-table__row--actions" key={t.tenant_id}>
                  <span>
                    {t.name && t.name !== t.tenant_id ? `${t.name} (${t.tenant_id})` : t.tenant_id}
                  </span>
                  <span className={`status ${t.status === "disabled" ? "offline" : "online"}`}>
                    {t.status || "active"}
                  </span>
                  <span>
                    {Number(t.tokens_used || 0).toLocaleString()} tokens
                    {t.quota_tokens ? ` / ${Number(t.quota_tokens).toLocaleString()}` : "（不限）"}
                  </span>
                  <span className={t.quota_utilization >= 0.8 ? "status offline" : "status online"}>
                    {pct(t.quota_utilization)}
                  </span>
                  {canManageQuota && t.tenant_id !== "default" ? (
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => toggleTenantStatus(t.tenant_id, t.status)}
                    >
                      {t.status === "disabled" ? "启用" : "停用"}
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {canManageQuota ? (
            <>
              <form onSubmit={createTenant} className="form form--inline-grid">
                <label>
                  新租户 ID
                  <input
                    placeholder="acme"
                    value={newTenantId}
                    onChange={(e) => setNewTenantId(e.target.value)}
                  />
                </label>
                <label>
                  显示名
                  <input
                    placeholder="可选"
                    value={newTenantName}
                    onChange={(e) => setNewTenantName(e.target.value)}
                  />
                </label>
                <button type="submit" className="btn-secondary btn-sm" disabled={saving}>
                  创建租户
                </button>
              </form>
              <form onSubmit={saveQuota} className="form form--inline-grid">
                <label>
                  租户 ID
                  <input
                    placeholder="default"
                    value={quotaTenant}
                    onChange={(e) => setQuotaTenant(e.target.value)}
                  />
                </label>
                <label>
                  月度配额
                  <input
                    placeholder="留空=不限"
                    value={quotaValue}
                    onChange={(e) => setQuotaValue(e.target.value)}
                  />
                </label>
                <button type="submit" className="btn-primary btn-sm" disabled={saving}>
                  {saving ? "保存中…" : "设置配额"}
                </button>
              </form>
            </>
          ) : (
            <p className="muted">仅 admin 可改配额</p>
          )}
        </section>
      ) : null}

      {showSecrets && canViewSecrets ? (
        <>
          <section className="admin-card">
            <h3 className="admin-card__title">密钥与通知</h3>
            <p className="admin-card__desc">
              Vault ref · 轮换可写进程 env
              {notify?.vault_at_rest_enabled ? " + Fernet 落库" : "（设 CLAWHIVE_VAULT_KEY 可落库）"} · 告警 webhook
              不明文回显
            </p>
            <div className="kpi-grid kpi-grid--3" style={{ marginBottom: 12 }}>
              <div className="kpi-tile">
                <span className="kpi-label">告警 webhook</span>
                <span className={`kpi-value status ${notify?.alert_webhook_configured ? "online" : "offline"}`} style={{ fontSize: "1rem" }}>
                  {notify?.alert_webhook_configured ? "已配置" : "未配置"}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">Vault at-rest</span>
                <span className={`kpi-value status ${notify?.vault_at_rest_enabled ? "online" : "offline"}`} style={{ fontSize: "1rem" }}>
                  {notify?.vault_at_rest_enabled ? "Fernet 开" : "仅 env"}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">说明</span>
                <span className="kpi-value muted" style={{ fontSize: "0.85rem" }}>
                  非真 KMS
                </span>
              </div>
            </div>
            <div className="compact-table">
              {secrets.length === 0 ? (
                <p className="muted">无密钥引用</p>
              ) : (
                secrets.map((r) => (
                  <div className="compact-table__row compact-table__row--actions" key={r.ref_id}>
                    <span>{r.label || r.ref_id}</span>
                    <span className="muted">{r.env_var || r.ref_id}</span>
                    <span className={`status ${r.configured ? "online" : "offline"}`}>
                      {r.configured ? "已配置" : "未配置"}
                    </span>
                    <span className="muted">{r.sealed_stored ? "已封存" : "—"}</span>
                    <span className="muted">{r.rotated_at ? `轮换 ${String(r.rotated_at).slice(0, 19)}` : "—"}</span>
                    {canManageQuota ? (
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        disabled={rotating === r.ref_id}
                        onClick={() => rotateSecret(r.ref_id)}
                      >
                        {rotating === r.ref_id ? "…" : "轮换"}
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="admin-card">
            <h3 className="admin-card__title">Prometheus 告警</h3>
            <p className="admin-card__desc">
              平台告警中心另展示 notify_status。外发：<code>CLAWHIVE_ALERT_WEBHOOK_URL</code>
            </p>
            {firingAlerts.length === 0 ? (
              <p className="muted">当前无 firing 告警</p>
            ) : (
              <ul className="audit-list">
                {firingAlerts.slice(0, 12).map((a, i) => (
                  <li key={`${a.labels?.alertname || "a"}-${i}`} className="audit-item">
                    <div className="audit-item__head">
                      <strong>{a.labels?.alertname || "alert"}</strong>
                      <span className="muted">{a.labels?.severity || ""}</span>
                    </div>
                    <p className="audit-item__detail">{a.annotations?.summary || a.annotations?.description || ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      {showAudit && canAudit ? (
        <>
          <section className="admin-card">
            <h3 className="admin-card__title">敏感操作审计清单</h3>
            <p className="admin-card__desc">
              CP-G2：近 {checklist?.lookback_days || 90} 天覆盖 {checklist?.covered_count ?? "—"}/
              {checklist?.required_count ?? "—"}
            </p>
            <div className="compact-table">
              {(checklist?.items || []).map((it) => (
                <div className="compact-table__row" key={it.action}>
                  <span>
                    <code>{it.action}</code> · {it.label}
                  </span>
                  <span className={`status ${it.seen ? "online" : "offline"}`}>
                    {it.seen ? "已见" : "未见"}
                  </span>
                  <span className="muted">{it.last_at ? String(it.last_at).slice(0, 19) : "—"}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="admin-card">
            <div className="ops-header">
              <div>
                <h3 className="admin-card__title">审计日志</h3>
                <p className="admin-card__desc">筛选并导出 CSV（含 actor / tenant / 时间）</p>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={exportAudits}>
                导出 CSV
              </button>
            </div>
            <div className="form form--inline-grid">
              <label>
                Action
                <input
                  value={auditAction}
                  onChange={(e) => setAuditAction(e.target.value)}
                  placeholder="tenant.quota.set"
                />
              </label>
              <label>
                Actor
                <input value={auditActor} onChange={(e) => setAuditActor(e.target.value)} placeholder="admin" />
              </label>
              <button type="button" className="btn-secondary btn-sm" onClick={() => load()}>
                刷新
              </button>
            </div>
            <ul className="audit-list">
              {audits.length === 0 ? (
                <li className="muted">暂无审计记录</li>
              ) : (
                audits.map((a) => (
                  <li key={a.id || `${a.action}-${a.created_at}`} className="audit-item">
                    <div className="audit-item__head">
                      <strong>{a.action}</strong>
                      <span className="muted">{a.username}</span>
                      <span className="muted">tenant={a.tenant_id || "default"}</span>
                      <span className="muted">{String(a.created_at || "").slice(0, 19)}</span>
                    </div>
                    <p className="audit-item__detail">
                      {a.target_type}/{a.target_id} · {a.detail}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </section>
        </>
      ) : null}

      {showAudit && !canAudit ? <p className="muted">仅 admin 可查看审计</p> : null}
      {showSecrets && !canViewSecrets ? <p className="muted">仅 operator/admin 可查看密钥</p> : null}
    </div>
  );
}
