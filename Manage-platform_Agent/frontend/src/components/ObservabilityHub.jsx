import { useState } from "react";
import { fetchJsonSafe } from "../utils/api";

function alertSeverity(a) {
  const raw = String(a.severity || a.level || a.labels?.severity || "").toLowerCase();
  if (raw.includes("crit") || raw === "error" || raw === "fatal") return "critical";
  if (raw.includes("warn")) return "warning";
  if (raw.includes("info") || raw.includes("notice")) return "info";
  return raw || "info";
}

/**
 * 可观测统一：告警摘要 + run_id/trace_id 深链检索
 */
export default function ObservabilityHub({
  apiBase,
  token,
  alerts = [],
  onAckAlert,
  onAckAllAlerts,
  onClearAlerts,
  onRefreshAlerts,
  children,
}) {
  const [runId, setRunId] = useState("");
  const [traceId, setTraceId] = useState("");
  const [links, setLinks] = useState(null);
  const [busy, setBusy] = useState(false);

  const lookup = async () => {
    setBusy(true);
    const out = {};
    if (runId.trim()) {
      const { ok, data } = await fetchJsonSafe(
        `${apiBase}/api/observability/log-link?run_id=${encodeURIComponent(runId.trim())}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (ok) out.log = data;
    }
    if (traceId.trim()) {
      const { ok, data } = await fetchJsonSafe(
        `${apiBase}/api/observability/trace-link?trace_id=${encodeURIComponent(traceId.trim())}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (ok) out.trace = data;
    }
    setLinks(out);
    setBusy(false);
  };

  return (
    <div className="page-stack page-stack--fill obs-hub">
      <section className="panel obs-hub__section">
        <div className="ops-header">
          <div>
            <p className="panel-eyebrow">可观测</p>
            <h2 className="ops-title">日志 · 追踪 · 告警</h2>
            <p className="panel-desc">按 run_id / trace_id 打开 Loki · Tempo · Langfuse</p>
          </div>
          {onRefreshAlerts ? (
            <button type="button" className="btn-secondary btn-sm" onClick={onRefreshAlerts}>
              刷新告警
            </button>
          ) : null}
        </div>

        <div className="obs-lookup">
          <input
            placeholder="run_id"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            aria-label="run_id"
          />
          <input
            placeholder="trace_id"
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            aria-label="trace_id"
          />
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={lookup}>
            查询深链
          </button>
        </div>

        {links ? (
          <div className="obs-lookup__links">
            {links.log?.loki_url || links.log?.grafana_url ? (
              <p>
                Loki：{" "}
                <a href={links.log.loki_url || links.log.grafana_url} target="_blank" rel="noreferrer">
                  打开日志
                </a>
              </p>
            ) : null}
            {links.trace ? (
              <p>
                {links.trace.tempo_url || links.trace.grafana_url ? (
                  <>
                    Tempo：{" "}
                    <a href={links.trace.tempo_url || links.trace.grafana_url} target="_blank" rel="noreferrer">
                      打开追踪
                    </a>
                    {" · "}
                  </>
                ) : null}
                {links.trace.langfuse_url ? (
                  <a href={links.trace.langfuse_url} target="_blank" rel="noreferrer">
                    Langfuse
                  </a>
                ) : null}
              </p>
            ) : null}
            <details>
              <summary>原始 payload</summary>
              <pre>{JSON.stringify(links, null, 2)}</pre>
            </details>
          </div>
        ) : null}

        <div className="obs-alerts">
          <div className="obs-alerts__head">
            <strong>告警</strong>
            <span className="muted">{alerts.length} 条</span>
            {onAckAllAlerts ? (
              <button type="button" className="btn-secondary btn-xs" onClick={onAckAllAlerts}>
                全部确认
              </button>
            ) : null}
            {onClearAlerts ? (
              <button type="button" className="btn-ghost btn-xs" onClick={onClearAlerts}>
                清空
              </button>
            ) : null}
          </div>
          {alerts.length === 0 ? (
            <p className="muted">无活跃告警</p>
          ) : (
            <ul className="obs-alerts__list">
              {alerts.slice(0, 20).map((a, i) => {
                const sev = alertSeverity(a);
                return (
                  <li key={a.id || i} className="obs-alerts__item">
                    <div className="obs-alerts__item-main">
                      <span className={`obs-alerts__sev obs-alerts__sev--${sev}`}>{sev}</span>
                      <strong>{a.name || a.alertname || a.title || "alert"}</strong>
                      <span className="muted"> {a.summary || a.message || ""}</span>
                    </div>
                    {onAckAlert && a.id ? (
                      <button type="button" className="btn-ghost btn-xs" onClick={() => onAckAlert(a.id)}>
                        确认
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      {children}
    </div>
  );
}
