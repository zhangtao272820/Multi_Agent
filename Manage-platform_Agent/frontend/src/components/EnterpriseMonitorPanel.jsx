function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString();
}

function lastPointValue(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const pts = series[series.length - 1]?.values || series[series.length - 1];
  if (!Array.isArray(pts) || !pts.length) return null;
  const v = Number(pts[pts.length - 1]?.[1] ?? pts[pts.length - 1]);
  return Number.isFinite(v) ? v : null;
}

function shortId(id) {
  const s = String(id || "");
  if (s.length <= 16) return s || "—";
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

export default function EnterpriseMonitorPanel({
  observability,
  promSnapshot,
  loading,
  onRefresh,
  onNavigate,
}) {
  const mgr = observability?.manager || {};
  const token = mgr.token_summary || {};
  const evo = mgr.evolution || {};
  const prom = promSnapshot || {};
  const tracing = observability?.tracing || {};
  const logging = observability?.logging || {};
  const recentTraces = Array.isArray(tracing.recent_traces) ? tracing.recent_traces : [];
  const grafanaUrl = tracing.grafana_public_url || logging.grafana_public_url;

  return (
    <section className="panel ops-surface">
      <div className="ops-header">
        <div>
          <p className="panel-eyebrow">企业监控</p>
            <h2 className="ops-title">观测指标条</h2>
            <p className="panel-desc">
              天相 Audit：Token · 成功率 · Tempo/Loki/Langfuse ·{" "}
              <code>/api/monitor/dashboard</code> · <code>audit</code>
            </p>
        </div>
        <button type="button" className="btn-secondary" disabled={loading} onClick={onRefresh}>
          刷新
        </button>
      </div>

      <div className="kpi-grid kpi-grid--6">
        <div className="kpi-tile">
          <span className="kpi-label">Prometheus Runs</span>
          <span className="kpi-value">{fmtNum(prom.managerRuns)}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Prometheus Tokens</span>
          <span className="kpi-value">{fmtNum(prom.managerTokens)}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Metrics Token</span>
          <span className="kpi-value">{fmtNum(token.totalTokens)}</span>
          <span className="kpi-meta">jsonl 窗口汇总</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">搜索命中率</span>
          <span className="kpi-value">
            {prom.searchHitRate != null
              ? `${(prom.searchHitRate * 100).toFixed(1)}%`
              : evo.searchHitRate != null
                ? `${(evo.searchHitRate * 100).toFixed(1)}%`
                : "—"}
          </span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">NLU 样本</span>
          <span className="kpi-value">{fmtNum(evo.nluSampleCount)}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">首遍成功率</span>
          <span className="kpi-value">
            {prom.firstPassSuccessRate != null
              ? `${(prom.firstPassSuccessRate * 100).toFixed(1)}%`
              : evo.firstPassSuccessRate != null
                ? `${(evo.firstPassSuccessRate * 100).toFixed(1)}%`
                : "—"}
          </span>
          <span className="kpi-meta">Audit 聚合</span>
        </div>
      </div>

      <div className="obs-strips section-gap">
        <div className="trace-strip">
          <div className="trace-strip__head">
            <strong>追踪 · Tempo</strong>
            <span className={`badge ${tracing.tempo_ready ? "online" : "offline"}`}>
              {tracing.tempo_ready ? "Tempo ready" : "Tempo 未就绪"}
            </span>
            {grafanaUrl ? (
              <a
                className="btn-secondary btn-secondary--sm"
                href={grafanaUrl}
                target="_blank"
                rel="noreferrer"
              >
                打开 Grafana
              </a>
            ) : null}
          </div>
          <p className="muted panel-desc">
            Manager finalize 推送 OTLP → Tempo；深链 Explore（uid=tempo）。
          </p>
        </div>

        <div className="trace-strip">
          <div className="trace-strip__head">
            <strong>LLM 观测 · Langfuse</strong>
            <span className={`badge ${tracing.langfuse_ready ? "online" : "offline"}`}>
              {tracing.langfuse_ready ? "Langfuse ready" : "Langfuse 未就绪"}
            </span>
            {tracing.langfuse_public_url ? (
              <a
                className="btn-secondary btn-secondary--sm"
                href={tracing.langfuse_public_url}
                target="_blank"
                rel="noreferrer"
              >
                打开 Langfuse
              </a>
            ) : null}
          </div>
          <p className="muted panel-desc">
            OTLP fan-out → Langfuse；控制台深链打开同一 trace_id。
          </p>
        </div>

        <div className="trace-strip">
          <div className="trace-strip__head">
            <strong>日志 · Loki</strong>
            <span className={`badge ${logging.loki_ready ? "online" : "offline"}`}>
              {logging.loki_ready ? "Loki ready" : "Loki 未就绪"}
            </span>
          </div>
          <p className="muted panel-desc">
            结构化 JSON（run_id / trace_id）→ Promtail → Loki；按 run_id 串联。
          </p>
        </div>
      </div>

      {recentTraces.length === 0 ? (
        <p className="muted section-gap">暂无近期 runs（需 MANAGER_OTEL_EXPORT=1 且有 run metrics）</p>
      ) : (
        <ul className="trace-strip__list section-gap">
          {recentTraces.slice(0, 8).map((t) => (
            <li key={`${t.run_id}-${t.trace_id}`}>
              <code title={t.trace_id || t.run_id}>{shortId(t.trace_id || t.run_id)}</code>
              <span className="muted">{fmtNum(t.span_count)} spans</span>
              {t.grafana_explore_url ? (
                <a href={t.grafana_explore_url} target="_blank" rel="noreferrer">
                  Tempo
                </a>
              ) : null}
              {t.langfuse_url ? (
                <a href={t.langfuse_url} target="_blank" rel="noreferrer">
                  Langfuse
                </a>
              ) : null}
              {t.grafana_loki_url ? (
                <a href={t.grafana_loki_url} target="_blank" rel="noreferrer">
                  日志
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <nav className="link-nav link-nav--compact">
        <button type="button" className="link-nav__item" onClick={() => onNavigate?.("manager")}>
          <span className="link-nav__title">总管 & 子 Agent 详情</span>
          <span className="link-nav__desc">阶段 / Token / 调用流水</span>
        </button>
        <button type="button" className="link-nav__item" onClick={() => onNavigate?.("monitor")}>
          <span className="link-nav__title">监控大屏</span>
          <span className="link-nav__desc">总管 & 子 Agent · Token / 阶段 / 调用流水</span>
        </button>
      </nav>
    </section>
  );
}

export { lastPointValue, fmtNum };
