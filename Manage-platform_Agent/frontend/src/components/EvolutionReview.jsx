import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

/**
 * 待我审阅：流程说明 + 四队列 Tab。
 * 纪律：不自动上线；晋级必过人审 + verify。
 */
export default function EvolutionReview({ apiBase, authToken, onRefresh }) {
  const [status, setStatus] = useState("pending");
  const [activeTab, setActiveTab] = useState("candidates");
  const [candidates, setCandidates] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [pgDrafts, setPgDrafts] = useState([]);
  const [hub, setHub] = useState(null);
  const [promptShadow, setPromptShadow] = useState(null);
  const [lobsterItems, setLobsterItems] = useState([]);
  const [onlineEvalLatest, setOnlineEvalLatest] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");

  const headers = {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json",
  };

  const load = useCallback(async () => {
    setMsg("");
    const [candRes, opsRes] = await Promise.all([
      fetchJsonSafe(`${apiBase}/api/manager/evolution/global-candidates?status=${encodeURIComponent(status)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
      fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "evolution_review_bundle" }),
      }),
    ]);
    if (candRes.ok && candRes.data) {
      const list = candRes.data.candidates || candRes.data.items || candRes.data.rows || [];
      setCandidates(Array.isArray(list) ? list : []);
    } else {
      setCandidates([]);
    }
    if (opsRes.ok && opsRes.data) {
      setDrafts(Array.isArray(opsRes.data.drafts) ? opsRes.data.drafts : []);
      setPgDrafts(Array.isArray(opsRes.data.pgDrafts) ? opsRes.data.pgDrafts : []);
      setHub(opsRes.data.evolutionHub || null);
      setPromptShadow(opsRes.data.promptShadow || null);
      setLobsterItems(Array.isArray(opsRes.data.lobsterPlaybooks) ? opsRes.data.lobsterPlaybooks : []);
      setOnlineEvalLatest(opsRes.data.onlineEvalLatest || null);
    }
  }, [apiBase, authToken, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reviewCandidate(id, decision) {
    const verb = decision === "approved" ? "批准" : "拒绝";
    if (!window.confirm(`确认${verb}候选 ${id}？`)) return;
    const label = `review-${id}-${decision}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/global-review`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, decision, note: "platform EvolutionReview" }),
      });
      if (!ok) throw new Error(error || data?.detail || "review failed");
      setMsg(`候选 ${id} → ${verb}`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function skillAction(action, skillId) {
    const verb = action === "skill_draft_promote" ? "晋级" : "拒绝";
    if (!window.confirm(`确认${verb}技能草稿 ${skillId}？`)) return;
    const label = `${action}-${skillId}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, skillId }),
      });
      if (!ok) throw new Error(error || data?.message || data?.detail || "ops failed");
      setMsg(`技能草稿 ${skillId} 已${verb}`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function managerEvoAction(action, extra = {}) {
    if (action === "prompt_promote") {
      if (!window.confirm("确认将试用版 Prompt 正式生效？此操作会改线上编排提示。")) return;
    }
    const label = `${action}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, ...extra }),
      });
      if (!ok) throw new Error(error || data?.message || data?.detail || "ops failed");
      setMsg(action === "prompt_promote" ? "Prompt 已正式生效" : "已刷新对比");
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function expertPromote(agent, patchId) {
    if (!window.confirm(`确认将 ${agent} 的补丁 ${patchId} 正式生效？`)) return;
    const label = `expert-${agent}-${patchId}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "expert_patch_promote", agent, patchId }),
      });
      if (!ok) throw new Error(error || data?.detail || data?.message || "promote failed");
      setMsg(`${agent} 补丁 ${patchId} 已生效`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function lobsterAction(action, key) {
    const verb = action === "promote" ? "晋级" : action === "reject" ? "拒绝" : "回滚";
    if (!window.confirm(`确认${verb} GUI 剧本 ${String(key).slice(0, 48)}？`)) return;
    const label = `lobster-${action}-${key || ""}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/lobster/playbook-evolution`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, key, status: "all" }),
      });
      if (!ok) throw new Error(error || data?.reason || data?.detail || "lobster failed");
      setMsg(`GUI 剧本已${verb}`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  const draftRows = pgDrafts.length
    ? pgDrafts
    : drafts.map((d) => ({
        skillId: d.skillId,
        agent: d.agent,
        status: "draft",
        success_score: null,
      }));

  const expertPatches = useMemo(() => {
    const out = [];
    const agents = hub?.agents || {};
    for (const name of ["db", "rag", "admin"]) {
      const block = agents[name];
      const data = block?.data || block || {};
      const patches =
        data.promptPatches ||
        data.promotablePatches ||
        data.patches ||
        data.shadowPatches ||
        data.learning?.patches ||
        data.summary?.patches ||
        [];
      const list = Array.isArray(patches)
        ? patches
        : Array.isArray(data.promotablePatches)
          ? data.promotablePatches
          : [];
      if (!Array.isArray(list)) continue;
      for (const p of list.slice(0, 20)) {
        const id = p.id || p.patchId || p.patch_id;
        if (!id) continue;
        if (p.promotedAt || p.promoted_at) continue;
        out.push({
          agent: name,
          patchId: String(id),
          stage: p.stage || "—",
          hits: p.hits ?? p.hitCount ?? "—",
          text: String(p.text || p.summary || "").slice(0, 100),
        });
      }
    }
    return out;
  }, [hub]);

  const lobsterShadowCount = lobsterItems.filter((r) => (r.status || "shadow") === "shadow" || !r.status).length;
  const promptPending =
    (promptShadow?.diff ? 1 : 0) + expertPatches.length + (promptShadow?.shadowPresent ? 1 : 0);

  const tabs = [
    { id: "candidates", label: "待审候选", count: candidates.length },
    { id: "skills", label: "技能草稿", count: draftRows.length },
    { id: "prompts", label: "Prompt 与专家补丁", count: expertPatches.length + (promptShadow?.diff ? 1 : 0) },
    { id: "lobster", label: "GUI 自动化剧本", count: lobsterItems.length },
  ];

  const pendingTotal =
    (status === "pending" ? candidates.length : 0) +
    draftRows.length +
    expertPatches.length +
    lobsterShadowCount;

  function EmptyHint({ children }) {
    return <p className="evo-empty muted">{children}</p>;
  }

  return (
    <div className="evo-panel">
      <div className="evo-panel__head">
        <div>
          <h2 className="evo-panel__title">
            自我进化（人审门禁）
            <span className="evo-badge evo-badge--safe">不会自动上线</span>
          </h2>
          <p className="muted evo-panel__lead">
            总管里点「有用 / 无用 / 路由不对」只产生学习信号；真正改线上要在这里人工批准。
          </p>
        </div>
        <div className="evo-panel__actions">
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={Boolean(busy)}>
            刷新待审
          </button>
          {msg ? <span className="muted evo-panel__msg">{msg}</span> : null}
        </div>
      </div>

      <ol className="evo-flow" aria-label="进化流程">
        <li className="evo-flow__step">
          <span className="evo-flow__n">1</span>
          <span className="evo-flow__t">总管反馈</span>
          <span className="evo-flow__d">点有用 / 无用 / 路由不对</span>
        </li>
        <li className="evo-flow__arrow" aria-hidden="true">
          →
        </li>
        <li className="evo-flow__step">
          <span className="evo-flow__n">2</span>
          <span className="evo-flow__t">影子 / 草稿</span>
          <span className="evo-flow__d">系统只写试用版</span>
        </li>
        <li className="evo-flow__arrow" aria-hidden="true">
          →
        </li>
        <li className="evo-flow__step evo-flow__step--here">
          <span className="evo-flow__n">3</span>
          <span className="evo-flow__t">你在这里批准</span>
          <span className="evo-flow__d">
            待审 {pendingTotal} 项
            {promptPending ? ` · 补丁相关 ${promptPending}` : ""}
          </span>
        </li>
      </ol>

      <div className="evo-meta muted">
        {onlineEvalLatest && (onlineEvalLatest.runId != null || onlineEvalLatest.ok != null) ? (
          <span>
            上线前评测：run #{onlineEvalLatest.runId ?? "—"} ·{" "}
            {onlineEvalLatest.ok ? "通过" : "未通过"} · 通过 {onlineEvalLatest.passed ?? "—"} / 失败{" "}
            {onlineEvalLatest.failed ?? "—"}
          </span>
        ) : (
          <span>上线前评测：暂无最近结果（不影响你先浏览待审列表）</span>
        )}
      </div>

      <div className="evo-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`evo-tabs__btn${activeTab === t.id ? " is-active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            <span className="evo-badge">{t.count}</span>
          </button>
        ))}
      </div>

      {activeTab === "candidates" ? (
        <div className="evo-tab-panel" role="tabpanel">
          <div className="evo-tab-panel__toolbar">
            <label className="evo-filter">
              状态{" "}
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="pending">待审</option>
                <option value="approved">已批准</option>
                <option value="rejected">已拒绝</option>
              </select>
            </label>
          </div>
          {!candidates.length ? (
            <EmptyHint>
              暂无{status === "pending" ? "待审" : status === "approved" ? "已批准" : "已拒绝"}
              候选。这很正常：先去总管跑真实题并点「有用」，再回这里刷新。
            </EmptyHint>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>来源</th>
                    <th>摘要</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.slice(0, 30).map((c) => {
                    const id = c.id ?? c.candidate_id ?? c.key;
                    return (
                      <tr key={String(id)}>
                        <td>{String(id)}</td>
                        <td>{c.agent || c.plane || "—"}</td>
                        <td style={{ maxWidth: 360 }}>
                          {String(c.summary || c.title || c.patch || c.stage || "—").slice(0, 120)}
                        </td>
                        <td>
                          {status === "pending" ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--ghost"
                                disabled={Boolean(busy)}
                                onClick={() => void reviewCandidate(id, "approved")}
                              >
                                批准
                              </button>{" "}
                              <button
                                type="button"
                                className="btn btn--ghost"
                                disabled={Boolean(busy)}
                                onClick={() => void reviewCandidate(id, "rejected")}
                              >
                                拒绝
                              </button>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "skills" ? (
        <div className="evo-tab-panel" role="tabpanel">
          {!draftRows.length ? (
            <EmptyHint>
              暂无技能草稿。成功路径足够多且过门禁后，系统才会生成草稿；不会自己发明技能。
            </EmptyHint>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>草稿 ID</th>
                    <th>路径</th>
                    <th>分数</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {draftRows.slice(0, 40).map((d) => {
                    const sid = d.skillId || d.skill_id;
                    return (
                      <tr key={String(sid)}>
                        <td>{String(sid)}</td>
                        <td>{d.agent || "—"}</td>
                        <td>{d.success_score ?? d.successScore ?? "—"}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={Boolean(busy)}
                            onClick={() => void skillAction("skill_draft_promote", sid)}
                          >
                            晋级
                          </button>{" "}
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={Boolean(busy)}
                            onClick={() => void skillAction("skill_draft_reject", sid)}
                          >
                            拒绝
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "prompts" ? (
        <div className="evo-tab-panel" role="tabpanel">
          <h3 className="evo-subhead">总管试用版 Prompt</h3>
          <div className="evo-tab-panel__toolbar">
            <button
              type="button"
              className="btn-secondary"
              disabled={Boolean(busy)}
              onClick={() => void managerEvoAction("prompt_shadow_diff")}
            >
              刷新对比
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={Boolean(busy)}
              onClick={() => void managerEvoAction("prompt_promote")}
            >
              将试用版 Prompt 正式生效
            </button>
          </div>
          {promptShadow?.diff ? (
            <pre className="evo-diff muted">{JSON.stringify(promptShadow.diff, null, 2).slice(0, 1200)}</pre>
          ) : (
            <EmptyHint>暂无总管 Prompt 试用版对比。有影子补丁后点「刷新对比」再决定是否生效。</EmptyHint>
          )}

          <h3 className="evo-subhead">专家补丁（DB / RAG / Admin）</h3>
          {!expertPatches.length ? (
            <EmptyHint>暂无专家未生效补丁。专家侧学习写影子后会出现在此列表。</EmptyHint>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>专家</th>
                    <th>补丁 ID</th>
                    <th>阶段</th>
                    <th>命中</th>
                    <th>摘要</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {expertPatches.map((p) => (
                    <tr key={`${p.agent}-${p.patchId}`}>
                      <td>{p.agent}</td>
                      <td>{p.patchId}</td>
                      <td>{p.stage}</td>
                      <td>{p.hits}</td>
                      <td style={{ maxWidth: 280 }}>{p.text || "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={Boolean(busy)}
                          onClick={() => void expertPromote(p.agent, p.patchId)}
                        >
                          正式生效
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "lobster" ? (
        <div className="evo-tab-panel" role="tabpanel">
          {!lobsterItems.length ? (
            <EmptyHint>
              暂无 GUI 自动化剧本。Lobster 成功跑通网页任务后会写入试用版；可在此晋级或回滚。
            </EmptyHint>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>键</th>
                    <th>站点</th>
                    <th>状态</th>
                    <th>步骤</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {lobsterItems.slice(0, 40).map((row) => {
                    const key = row.key;
                    const st = row.status || "shadow";
                    return (
                      <tr key={String(key)}>
                        <td style={{ maxWidth: 220 }}>{String(key).slice(0, 64)}</td>
                        <td>{row.host || "—"}</td>
                        <td>{st === "active" ? "已生效" : st === "shadow" || !row.status ? "试用版" : st}</td>
                        <td>{Array.isArray(row.plan_steps) ? row.plan_steps.length : "—"}</td>
                        <td>
                          {st === "shadow" || !row.status ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--ghost"
                                disabled={Boolean(busy)}
                                onClick={() => void lobsterAction("promote", key)}
                              >
                                晋级
                              </button>{" "}
                              <button
                                type="button"
                                className="btn btn--ghost"
                                disabled={Boolean(busy)}
                                onClick={() => void lobsterAction("reject", key)}
                              >
                                拒绝
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              onClick={() => void lobsterAction("rollback", key)}
                            >
                              回滚
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
