import { useState } from "react";
import { fetchJsonSafe } from "../utils/api";
import EvolutionReview from "./EvolutionReview";

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString();
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function statusClass(status) {
  if (status === "healthy" || status === "online") return "online";
  if (status === "degraded" || status === "unknown") return "degraded";
  return "offline";
}

function flagOn(v) {
  if (typeof v === "boolean") return v;
  if (v && typeof v === "object" && "enabled" in v) return Boolean(v.enabled);
  return null;
}

function flagLabel(v) {
  const on = flagOn(v);
  if (on == null) return "—";
  return on ? "开" : "关";
}

function flagStatusClass(v) {
  const on = flagOn(v);
  if (on == null) return "degraded";
  return on ? "online" : "offline";
}

function summarizeAgentMetrics(data) {
  if (!data || typeof data !== "object") return "—";
  if (Array.isArray(data.counters)) {
    const top = data.counters.slice(0, 3).map((c) => `${c.name || c.key}: ${c.value ?? c.count ?? "?"}`);
    return top.join(" · ") || "counters";
  }
  const keys = Object.keys(data).slice(0, 4);
  if (!keys.length) return "—";
  return keys.map((k) => `${k}`).join(", ");
}

export default function ManagerObservability({ data, loading, onRefresh, apiBase, authToken }) {
  const mgr = data?.manager || {};
  const [planeBusy, setPlaneBusy] = useState("");
  const [planeMsg, setPlaneMsg] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const [intentOpen, setIntentOpen] = useState(false);
  const [evoBusy, setEvoBusy] = useState("");
  const [evoMsg, setEvoMsg] = useState("");

  async function resetAgentPlane(agent, scope) {
    const label = `${agent}/${scope}`;
    if (!window.confirm(`确认清除 ${label}？仅影响该 Agent 本平面，不会跨清其他专家。`)) return;
    setPlaneBusy(label);
    setPlaneMsg("");
    try {
      const { ok, error } = await fetchJsonSafe(`${apiBase}/api/agents/plane-reset`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agent, scope }),
      });
      if (!ok) throw new Error(error || "请求失败");
      setPlaneMsg(`${label} 已清除`);
      onRefresh?.();
    } catch (e) {
      setPlaneMsg(`${label} 失败：${String(e?.message || e)}`);
    } finally {
      setPlaneBusy("");
    }
  }

  const token = mgr.token_summary || {};
  const phases = Object.entries(mgr.phases || {})
    .sort((a, b) => (b[1]?.avgMs || 0) - (a[1]?.avgMs || 0))
    .slice(0, 12);
  const tokenByPhase = Object.entries(token.byPhase || {}).sort((a, b) => b[1] - a[1]);
  const byAgent = Object.entries(mgr.by_agent_success || {}).sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
  const recent = Array.isArray(mgr.recent_metrics) ? mgr.recent_metrics : [];
  const evo = mgr.evolution || {};
  const regEvo = mgr.registry?.evolution || {};
  const healthAgents = data?.agents_health || [];
  const metricsAgents = data?.agents_metrics || [];

  const unified = evo.unifiedLearning || {};
  const vector = evo.vectorIndex || {};
  const patches = evo.promptPatches || {};
  const plannerRules = evo.plannerRules || {};
  const experiments = evo.experiments || {};
  const byIntent = Object.entries(evo.byIntent || {}).sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
  const policyCanaryPct =
    regEvo.policyCanaryPercent != null
      ? regEvo.policyCanaryPercent
      : evo.policyCanary?.share != null
        ? Math.round(Number(evo.policyCanary.share) * 100)
        : null;

  const learnFlags = [
    { key: "routeStrategy", label: "路由策略 hint", value: evo.routeStrategy ?? regEvo.routeStrategy },
    { key: "routeBandit", label: "路径试探（Bandit）", value: regEvo.routeBandit },
    { key: "unifiedLearning", label: "统一学习", value: unified.enabled ?? regEvo.unifiedLearning },
    { key: "promptEvolve", label: "Prompt 影子学习", value: regEvo.promptEvolve },
    { key: "implicitLearning", label: "隐式学习", value: regEvo.implicitLearning },
    {
      key: "policyCanary",
      label: "策略金丝雀",
      value: regEvo.policyCanaryEnabled ?? (policyCanaryPct != null && policyCanaryPct > 0),
      meta: policyCanaryPct != null ? `${policyCanaryPct}%` : null,
    },
  ];

  async function evolutionOpsAction(action, label) {
    if (!window.confirm(`确认执行「${label}」？可能影响线上策略，请谨慎。`)) return;
    setEvoBusy(action);
    setEvoMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      if (!ok) throw new Error(error || data?.detail || data?.message || "请求失败");
      setEvoMsg(`${label} 完成`);
      onRefresh?.();
    } catch (e) {
      setEvoMsg(`${label} 失败：${String(e?.message || e)}`);
    } finally {
      setEvoBusy("");
    }
  }

  return (
    <div className="obs-page">
      <div className="obs-toolbar">
        <p className="card-lead">
          对接 Manager <code>/api/metrics</code> 与 Prometheus；子 Agent 并行拉取 <code>/api/metrics</code>。
          Token 分 phase 汇总（P4 台账，见升级.md §8）。路由学习为弱参考，编排 LLM 仍为权威。
        </p>
        <button type="button" className="btn-secondary" disabled={loading} onClick={onRefresh}>
          {loading ? "刷新中…" : "立即刷新"}
        </button>
      </div>

      <div className="kpi-grid kpi-grid--6">
        <div className="kpi-tile">
          <span className="kpi-label">平台状态</span>
          <span className={`status ${statusClass(data?.overall_status)}`}>{data?.overall_status || "—"}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Manager</span>
          <span className={`status ${mgr.reachable ? "online" : "offline"}`}>
            {mgr.reachable ? "可达" : "不可达"}
          </span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">编排 Run 数</span>
          <span className="kpi-value">{fmtNum(mgr.runs)}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">Token（窗口内）</span>
          <span className="kpi-value">{fmtNum(token.totalTokens)}</span>
          <span className="kpi-meta">USD ≈ {token.totalUsd != null ? token.totalUsd : "—"}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">首遍成功率</span>
          <span className="kpi-value">{fmtPct(evo.firstPassSuccessRate)}</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">经验回放使用率</span>
          <span className="kpi-value">{fmtPct(evo.experienceReplayUsageRate)}</span>
        </div>
      </div>

      <div className="obs-grid">
        <section className="card card--wide">
          <h2>自我进化</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            分区说明：上方<strong>待我审阅</strong>（含「用户记忆」Tab）→ 中间<strong>学习是否在涨</strong>（看板）→ 底部
            <strong>高级清除与回滚</strong>（危险，默认折叠）。默认不会自动改线上。
          </p>

          {/* A+B：流程 + 待审 */}
          <EvolutionReview apiBase={apiBase} authToken={authToken} onRefresh={onRefresh} />

          {/* C：学习是否在涨 */}
          <div className="evo-zone evo-zone--board">
            <h3 className="evo-zone__title">学习是否在涨</h3>
            <p className="muted evo-zone__hint">开关与样本数字只说明「有没有在学」；不代表已经改线上路由。</p>

            <div className="kpi-grid kpi-grid--6" style={{ marginBottom: 16 }}>
              {learnFlags.map((f) => (
                <div className="kpi-tile" key={f.key}>
                  <span className="kpi-label">{f.label}</span>
                  <span className={`status ${flagStatusClass(f.value)}`}>{flagLabel(f.value)}</span>
                  {f.meta ? <span className="kpi-meta">{f.meta}</span> : null}
                </div>
              ))}
            </div>

            <div className="kpi-grid kpi-grid--6" style={{ marginBottom: 16 }}>
              <div className="kpi-tile">
                <span className="kpi-label">学习样本</span>
                <span className="kpi-value">{fmtNum(unified.sampleCount)}</span>
                <span className="kpi-meta">
                  综合均分 {unified.avgComposite != null ? Number(unified.avgComposite).toFixed(3) : "—"}
                  {unified.supersededCount ? ` · 已作废 ${unified.supersededCount}` : ""}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">经验条数</span>
                <span className="kpi-value">{fmtNum(evo.experienceCount)}</span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">向量索引</span>
                <span className="kpi-value">{fmtNum(vector.total)}</span>
                <span className="kpi-meta">
                  经验 {fmtNum(vector.experience)} · 计划 {fmtNum(vector.planOutcome)}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">Prompt 补丁</span>
                <span className="kpi-value">
                  {patches.activePresent ? "已生效" : patches.shadowPresent ? "仅试用版" : "无"}
                </span>
                <span className="kpi-meta">
                  路由 {fmtNum(patches.routerActive)}/{fmtNum(patches.routerShadow)} · 规划{" "}
                  {fmtNum(patches.plannerActive)}/{fmtNum(patches.plannerShadow)}
                </span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">规划规则</span>
                <span className="kpi-value">{fmtNum(plannerRules.activeCount)}</span>
                <span className="kpi-meta">试用版 {fmtNum(plannerRules.shadowCount)}</span>
              </div>
              <div className="kpi-tile">
                <span className="kpi-label">进化实验</span>
                <span className="kpi-value">{fmtNum(experiments.experimentCount)}</span>
                <span className="kpi-meta">
                  假设 {fmtNum(experiments.hypothesisCount)} · 运行中 {fmtNum(experiments.runningCount)}
                  {experiments.autoExperimentEnabled === false ? " · 自动关" : ""}
                </span>
              </div>
            </div>

            <details
              className="evo-fold"
              open={intentOpen}
              onToggle={(e) => setIntentOpen(e.currentTarget.open)}
            >
              <summary className="evo-fold__summary">按意图明细（byIntent）</summary>
              {!byIntent.length ? (
                <p className="muted">尚无意图统计；多跑真实题并点「有用」写入经验后出现。</p>
              ) : (
                <div className="data-table">
                  <div className="data-table__head data-table__head--3">
                    <span>意图</span>
                    <span>样本</span>
                    <span>平均成功率</span>
                  </div>
                  {byIntent.slice(0, 20).map(([name, v]) => (
                    <div className="data-table__row data-table__row--3" key={name}>
                      <span>{name}</span>
                      <span>{v.count}</span>
                      <span>{fmtPct(v.avgSuccess)}</span>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </div>

          {/* D：高级危险折叠 */}
          <details
            className="evo-danger-fold"
            open={dangerOpen}
            onToggle={(e) => setDangerOpen(e.currentTarget.open)}
          >
            <summary className="evo-danger-fold__summary">高级：清除与回滚（危险）</summary>
            <p className="muted evo-danger-fold__hint">
              仅运维排障时使用。清除学习数据或回滚策略不会自动再生成；误点需重新喂题。
            </p>
            <div className="evo-danger-fold__actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={Boolean(evoBusy)}
                onClick={() => void evolutionOpsAction("policy_rollback", "撤销策略")}
              >
                {evoBusy === "policy_rollback" ? "…" : "撤销策略"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={Boolean(evoBusy)}
                onClick={() => void evolutionOpsAction("evolution_experiment_rollback", "撤销实验")}
              >
                {evoBusy === "evolution_experiment_rollback" ? "…" : "撤销实验"}
              </button>
              {[
                ["manager", "experience", "总管·清经验"],
                ["manager", "summaries", "总管·清摘要"],
                ["manager", "evolution", "总管·重置进化"],
                ["db", "learning", "DB·清学习"],
                ["db", "prompts", "DB·重置进化"],
                ["rag", "learning", "RAG·清学习"],
                ["rag", "prompts", "RAG·重置进化"],
                ["admin", "memory", "Admin·清记忆"],
                ["admin", "evolution", "Admin·重置进化"],
              ].map(([agent, scope, label]) => (
                <button
                  key={`${agent}-${scope}`}
                  type="button"
                  className="btn btn--ghost"
                  disabled={Boolean(planeBusy)}
                  onClick={() => void resetAgentPlane(agent, scope)}
                >
                  {planeBusy === `${agent}/${scope}` ? "…" : label}
                </button>
              ))}
            </div>
            {planeMsg || evoMsg ? <span className="muted">{planeMsg || evoMsg}</span> : null}
          </details>
        </section>

        <section className="card">
          <h2>总管阶段耗时</h2>
          {!phases.length ? <p className="muted">暂无 phase 数据（需 Manager 产生编排 run）</p> : null}
          <div className="phase-bars">
            {phases.map(([name, v]) => (
              <div className="phase-bar" key={name}>
                <span className="phase-bar__label">{name}</span>
                <div className="phase-bar__track">
                  <div className="phase-bar__fill" style={{ width: `${Math.min(100, (v.avgMs || 0) / 120)}%` }} />
                </div>
                <span className="phase-bar__val">
                  {v.avgMs}ms · {v.count}次
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Token 按阶段</h2>
          {!tokenByPhase.length ? (
            <p className="muted">暂无 token 埋点（LLM 调用会写入 manager-metrics.jsonl）</p>
          ) : (
            <div className="data-table">
              <div className="data-table__head">
                <span>阶段</span>
                <span>Tokens</span>
              </div>
              {tokenByPhase.map(([phase, n]) => (
                <div className="data-table__row" key={phase}>
                  <span>{phase}</span>
                  <span className="mono">{fmtNum(n)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card card--wide">
          <h2>子 Agent 路径成功率（Manager 经验统计）</h2>
          {!byAgent.length ? (
            <p className="muted">
              尚无 experience 路径统计；多跑真实业务题并点「有用」写入经验后，此处会出现 byAgent 成功率。
            </p>
          ) : null}
          <div className="data-table">
            <div className="data-table__head data-table__head--3">
              <span>Agent / 路径</span>
              <span>样本</span>
              <span>平均成功率</span>
            </div>
            {byAgent.map(([name, v]) => (
              <div className="data-table__row data-table__row--3" key={name}>
                <span>{name}</span>
                <span>{v.count}</span>
                <span>{fmtPct(v.avgSuccess)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card card--wide">
          <h2>子 Agent 探活 + 指标快照</h2>
          <div className="agent-metrics-grid">
            {healthAgents.map((h) => {
              const snap = metricsAgents.find((a) => a.name === h.name);
              return (
                <div className={`agent-metric-card ${statusClass(h.status)}`} key={h.name}>
                  <div className="agent-metric-card__head">
                    <strong>{h.name}</strong>
                    <span className={`status ${statusClass(h.status)}`}>{h.status}</span>
                  </div>
                  <p className="muted">{h.latency_ms}ms · {h.probe_path || h.target}</p>
                  {snap?.ok ? (
                    <p className="agent-metric-card__meta">{summarizeAgentMetrics(snap.metrics)}</p>
                  ) : (
                    <p className="agent-metric-card__meta muted">
                      {snap?.error || h.status !== "healthy" ? "指标不可用" : "—"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="card card--wide">
          <h2>总管调用流水（最近埋点）</h2>
          <div className="data-table data-table--scroll">
            <div className="data-table__head data-table__head--5">
              <span>时间</span>
              <span>Run</span>
              <span>阶段</span>
              <span>耗时</span>
              <span>Token</span>
            </div>
            {recent.length === 0 ? (
              <p className="muted" style={{ padding: "12px" }}>
                暂无流水；提交任务经 Manager 编排后会出现
              </p>
            ) : (
              recent.slice(0, 40).map((r, i) => (
                <div className="data-table__row data-table__row--5" key={`${r.ts}-${r.phase}-${i}`}>
                  <span className="muted">{r.ts ? new Date(r.ts).toLocaleTimeString() : "—"}</span>
                  <span className="mono truncate">{r.runId ? String(r.runId).slice(0, 8) : "—"}</span>
                  <span>{r.phase}</span>
                  <span>{r.ms != null ? `${r.ms}ms` : "—"}</span>
                  <span>{r.tokens != null ? fmtNum(r.tokens) : "—"}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
