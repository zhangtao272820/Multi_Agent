import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

/**
 * 待我审阅：流程说明 + 六队列 Tab（候选 / 用户记忆 / 技能 / 组织规则 / Prompt / GUI）。
 * 纪律：不自动上线；晋级必过人审 + verify。
 */
export default function EvolutionReview({ apiBase, authToken, onRefresh }) {
  const [status, setStatus] = useState("pending");
  const [activeTab, setActiveTab] = useState("memory");
  const [candidates, setCandidates] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [pgDrafts, setPgDrafts] = useState([]);
  const [hub, setHub] = useState(null);
  const [promptShadow, setPromptShadow] = useState(null);
  const [lobsterItems, setLobsterItems] = useState([]);
  const [ruleCandidates, setRuleCandidates] = useState([]);
  const [experienceCandidates, setExperienceCandidates] = useState([]);
  const [pendingPrefs, setPendingPrefs] = useState([]);
  const [rulePreviewId, setRulePreviewId] = useState("");
  const [expPreviewId, setExpPreviewId] = useState("");
  const [prefsPreviewKey, setPrefsPreviewKey] = useState("");
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
      setRuleCandidates(Array.isArray(opsRes.data.ruleCandidates) ? opsRes.data.ruleCandidates : []);
      setExperienceCandidates(
        Array.isArray(opsRes.data.experienceCandidates) ? opsRes.data.experienceCandidates : []
      );
      setPendingPrefs(Array.isArray(opsRes.data.pendingPrefs) ? opsRes.data.pendingPrefs : []);
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

  async function ruleAction(action, ruleCandidateId) {
    const verb = action === "rule_candidate_promote" ? "晋级" : "拒绝";
    if (!window.confirm(`确认${verb}组织规则候选 ${ruleCandidateId}？`)) return;
    const label = `${action}-${ruleCandidateId}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, ruleCandidateId }),
      });
      if (!ok) throw new Error(error || data?.message || data?.detail || "ops failed");
      setMsg(`规则候选 ${ruleCandidateId} 已${verb}`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function experienceAction(action, experienceCandidateId) {
    const verb = action === "experience_candidate_promote" ? "晋级" : "拒绝";
    if (!window.confirm(`确认${verb}经验候选 ${experienceCandidateId}？晋级后才参与召回。`)) return;
    const label = `${action}-${experienceCandidateId}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, experienceCandidateId }),
      });
      if (!ok) throw new Error(error || data?.message || data?.detail || data?.reason || "ops failed");
      setMsg(`经验候选 ${experienceCandidateId} 已${verb}`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function prefsAction(decision, userId) {
    const verb = decision === "confirm" ? "批准" : "拒绝";
    if (!window.confirm(`确认${verb}用户 ${userId} 的待审偏好？`)) return;
    const label = `prefs-${decision}-${userId}`;
    setBusy(label);
    setMsg("");
    try {
      const { ok, error, data } = await fetchJsonSafe(`${apiBase}/api/manager/evolution/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "user_profile_prefs", userId, decision }),
      });
      if (!ok) throw new Error(error || data?.message || data?.detail || "ops failed");
      setMsg(`用户 ${userId} 偏好已${verb}`);
      await load();
      onRefresh?.();
    } catch (e) {
      setMsg(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  function prefsRowKey(r) {
    return `${r.tenantId || "default"}:${r.userId}`;
  }

  function formatPrefsSource(source) {
    const s = String(source || "").trim();
    if (s === "hot_path_signal") return "热路径反馈（👍/高分 run）";
    if (s === "explicit_user_request") return "用户口语";
    if (s === "ops") return "管理员/ops";
    return s || "—";
  }

  function formatPrefsSummary(r) {
    if (r.summary && String(r.summary).trim() && !String(r.summary).startsWith("（无具体字段")) {
      return String(r.summary).trim();
    }
    const agents = Array.isArray(r.preferredAgents) ? r.preferredAgents.join("、") : "";
    const parts = [];
    if (agents) parts.push(`常用专家 → ${agents}`);
    if (r.refusePreference) parts.push(`拒答策略 → ${r.refusePreference}`);
    if (r.timezone) parts.push(`时区 → ${r.timezone}`);
    if (parts.length) return parts.join("；");
    if (r.conflictNote) return `冲突：${String(r.conflictNote).slice(0, 160)}`;
    return "（无具体字段，点击行查看详情）";
  }

  const draftRows = useMemo(() => {
    const raw = pgDrafts.length
      ? pgDrafts
      : drafts.map((d) => ({
          skillId: d.skillId,
          agent: d.agent,
          status: "draft",
          success_score: null,
          markdown: d.markdown || "",
          source_run_id: d.sourceRunId || d.source_run_id,
        }));
    const isExplicit = (row) =>
      /capture_source:\s*explicit_user_request/i.test(String(row.markdown || "")) ||
      /source=explicit_user_request/i.test(String(row.markdown || ""));
    return [...raw].sort((a, b) => {
      const ae = isExplicit(a) ? 1 : 0;
      const be = isExplicit(b) ? 1 : 0;
      if (ae !== be) return be - ae;
      const as = Number(a.success_score ?? a.successScore ?? 0);
      const bs = Number(b.success_score ?? b.successScore ?? 0);
      return bs - as;
    });
  }, [pgDrafts, drafts]);

  const ruleRows = useMemo(
    () =>
      [...ruleCandidates].sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      ),
    [ruleCandidates]
  );

  const experienceRows = useMemo(
    () =>
      [...experienceCandidates].sort((a, b) => {
        const ac = a.conflictNote ? 1 : 0;
        const bc = b.conflictNote ? 1 : 0;
        if (ac !== bc) return bc - ac;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      }),
    [experienceCandidates]
  );

  const prefsRows = useMemo(
    () =>
      [...pendingPrefs].sort((a, b) => {
        const ac = a.conflictNote ? 1 : 0;
        const bc = b.conflictNote ? 1 : 0;
        if (ac !== bc) return bc - ac;
        return String(b.proposedAt || "").localeCompare(String(a.proposedAt || ""));
      }),
    [pendingPrefs]
  );

  useEffect(() => {
    if (!prefsRows.length) {
      setPrefsPreviewKey("");
      return;
    }
    if (!prefsPreviewKey || !prefsRows.some((r) => prefsRowKey(r) === prefsPreviewKey)) {
      setPrefsPreviewKey(prefsRowKey(prefsRows[0]));
    }
  }, [prefsRows, prefsPreviewKey]);

  const memoryPendingCount = experienceRows.length + prefsRows.length;

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
    { id: "memory", label: "用户记忆", count: memoryPendingCount },
    { id: "candidates", label: "待审候选", count: candidates.length },
    { id: "skills", label: "技能草稿", count: draftRows.length },
    { id: "rules", label: "组织规则", count: ruleRows.length },
    { id: "prompts", label: "Prompt 与专家补丁", count: expertPatches.length + (promptShadow?.diff ? 1 : 0) },
    { id: "lobster", label: "GUI 自动化剧本", count: lobsterItems.length },
  ];

  const pendingTotal =
    memoryPendingCount +
    (status === "pending" ? candidates.length : 0) +
    draftRows.length +
    ruleRows.length +
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
            用户说「记住 / 答得很好」、点「有用」、保存偏好与打法，均先入草稿队列；自我进化高危项须在此人工批准后才参与召回或弱 hint 注入。
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

      {activeTab === "memory" ? (
        <div className="evo-tab-panel" role="tabpanel">
          <div className="evo-review-guide muted">
            <strong>怎么审？</strong>
            <ul>
              <li>
                <strong>保存的答案 / 👍</strong>：用户说「记住」或点有用 → 晋级后才参与经验召回；有「冲突」先看 path 是否矛盾。
              </li>
              <li>
                <strong>待审用户偏好</strong>：弱 hint（常用专家、拒答策略），<em>不改路由 cap</em>；批准=写入偏好，拒绝=丢弃提议。
              </li>
              <li>点击表格行可在右侧看「提议 vs 现有」全文；冲突说明必须读完再批。</li>
            </ul>
          </div>

          <h3 className="evo-subhead">保存的答案 / 👍 经验候选</h3>
          <p className="muted evo-zone__hint" style={{ marginTop: 0 }}>
            用户口语「记住」或点「有用」后写入候选；<strong>晋级前不参与经验召回</strong>。标红冲突项须先核对 path 再批准。
          </p>
          {!experienceRows.length ? (
            <EmptyHint>暂无经验候选。用户在总管说「这个很好帮我记住」或点「有用」后会出现在这里。</EmptyHint>
          ) : (
            <div className="evo-rules-layout">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>候选 ID</th>
                      <th>来源</th>
                      <th>场景</th>
                      <th>path</th>
                      <th>冲突</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {experienceRows.slice(0, 40).map((r) => {
                      const eid = r.id;
                      const hasConflict = Boolean(r.conflictNote);
                      return (
                        <tr
                          key={String(eid)}
                          className={`${expPreviewId === eid ? "is-selected" : ""}${hasConflict ? " evo-row-conflict" : " evo-row-explicit"}`}
                          onClick={() => setExpPreviewId(String(eid))}
                        >
                          <td>{String(eid)}</td>
                          <td>
                            <span className="evo-badge evo-badge--explicit">
                              {r.source === "explicit_feedback" ? "👍 有用" : "用户口语"}
                            </span>
                          </td>
                          <td style={{ maxWidth: 160, fontSize: 11 }}>{String(r.scenarioKey || "—").slice(0, 24)}</td>
                          <td>{Array.isArray(r.path) ? r.path.join("→") : "—"}</td>
                          <td style={{ maxWidth: 200, fontSize: 11 }}>
                            {hasConflict ? (
                              <span className="evo-badge evo-badge--warn" title={r.conflictNote}>
                                冲突
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              onClick={() => void experienceAction("experience_candidate_promote", eid)}
                            >
                              晋级
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              onClick={() => void experienceAction("experience_candidate_reject", eid)}
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
              <aside className="evo-rule-preview" aria-label="经验候选预览">
                <h3 className="evo-subhead">问句与冲突说明</h3>
                {expPreviewId ? (
                  <>
                    <p className="muted" style={{ fontSize: 12 }}>
                      run: {experienceRows.find((x) => x.id === expPreviewId)?.sourceRunId || "—"}
                    </p>
                    <pre className="evo-rule-preview__md">
                      {experienceRows.find((x) => x.id === expPreviewId)?.userText || "（无问句）"}
                    </pre>
                    {experienceRows.find((x) => x.id === expPreviewId)?.conflictNote ? (
                      <p className="evo-conflict-note">⚠ {experienceRows.find((x) => x.id === expPreviewId)?.conflictNote}</p>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">点击左侧一行查看问句全文与冲突说明</p>
                )}
              </aside>
            </div>
          )}

          <h3 className="evo-subhead" style={{ marginTop: 24 }}>
            待审用户偏好
          </h3>
          <p className="muted evo-zone__hint" style={{ marginTop: 0 }}>
            弱偏好须管理员或用户确认后才写入；有冲突时优先在此处理。
          </p>
          {!prefsRows.length ? (
            <EmptyHint>暂无待审偏好。用户说「我偏好用 RAG」等后会出现在这里或总管聊天卡片。</EmptyHint>
          ) : (
            <div className="evo-rules-layout">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>来源</th>
                      <th>新提议</th>
                      <th>冲突</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prefsRows.slice(0, 40).map((r) => {
                      const uid = r.userId;
                      const rowKey = prefsRowKey(r);
                      const summary = formatPrefsSummary(r);
                      return (
                        <tr
                          key={rowKey}
                          className={`${prefsPreviewKey === rowKey ? "is-selected" : ""}${r.conflictNote ? " evo-row-conflict" : ""}`}
                          onClick={() => setPrefsPreviewKey(rowKey)}
                        >
                          <td>{uid}</td>
                          <td style={{ fontSize: 11, maxWidth: 120 }}>{formatPrefsSource(r.source)}</td>
                          <td style={{ maxWidth: 280, fontSize: 12 }}>{summary.slice(0, 120)}</td>
                          <td style={{ maxWidth: 200, fontSize: 11 }}>
                            {r.conflictNote ? (
                              <span className="evo-badge evo-badge--warn" title={r.conflictNote}>
                                有冲突
                              </span>
                            ) : (
                              <span className="muted">无</span>
                            )}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              title="写入用户偏好（弱 hint，不改路由）"
                              onClick={() => void prefsAction("confirm", uid)}
                            >
                              批准
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              title="丢弃本次提议，保留现有偏好"
                              onClick={() => void prefsAction("reject", uid)}
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
              <aside className="evo-rule-preview" aria-label="偏好审阅详情">
                <h3 className="evo-subhead">偏好审阅详情</h3>
                {prefsPreviewKey ? (
                  (() => {
                    const r = prefsRows.find((x) => prefsRowKey(x) === prefsPreviewKey);
                    if (!r) return <p className="muted">未找到条目</p>;
                    return (
                      <>
                        <p className="muted" style={{ fontSize: 12 }}>
                          用户 {r.userId} · {formatPrefsSource(r.source)} · {r.proposedAt || "—"}
                        </p>
                        <div className="evo-prefs-compare">
                          <div>
                            <strong>新提议（待你批）</strong>
                            <pre className="evo-rule-preview__md">{formatPrefsSummary(r)}</pre>
                          </div>
                          <div>
                            <strong>当前已生效</strong>
                            <pre className="evo-rule-preview__md">
                              {r.currentSummary || "（尚无已生效偏好）"}
                            </pre>
                          </div>
                        </div>
                        {r.conflictNote ? (
                          <p className="evo-conflict-note">⚠ 冲突说明：{r.conflictNote}</p>
                        ) : (
                          <p className="muted" style={{ fontSize: 12 }}>
                            无冲突：批准后会覆盖/合并对应 prefs 字段。
                          </p>
                        )}
                        <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                          批准 = 把「新提议」写入用户偏好；拒绝 = 清空 pending，线上不变。
                        </p>
                      </>
                    );
                  })()
                ) : (
                  <p className="muted">点击左侧一行查看「新提议 vs 现有偏好」与冲突全文</p>
                )}
              </aside>
            </div>
          )}
        </div>
      ) : null}

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
                    <th>来源</th>
                    <th>路径</th>
                    <th>run</th>
                    <th>分数</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {draftRows.slice(0, 40).map((d) => {
                    const sid = d.skillId || d.skill_id;
                    const explicit =
                      /capture_source:\s*explicit_user_request/i.test(String(d.markdown || "")) ||
                      /source=explicit_user_request/i.test(String(d.markdown || ""));
                    const runId = d.source_run_id || d.sourceRunId || "—";
                    return (
                      <tr key={String(sid)} className={explicit ? "evo-row-explicit" : ""}>
                        <td>{String(sid)}</td>
                        <td>
                          {explicit ? (
                            <span className="evo-badge evo-badge--explicit">用户显式</span>
                          ) : (
                            <span className="muted">隐式</span>
                          )}
                        </td>
                        <td>{d.agent || "—"}</td>
                        <td style={{ maxWidth: 120, fontSize: 11 }}>{String(runId).slice(0, 16)}</td>
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

      {activeTab === "rules" ? (
        <div className="evo-tab-panel" role="tabpanel">
          {!ruleRows.length ? (
            <EmptyHint>
              暂无组织规则候选。用户在总管说「写成规则 / 别再踩」后会出现在这里；晋级前不改路由 Prompt。
            </EmptyHint>
          ) : (
            <div className="evo-rules-layout">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>规则 ID</th>
                      <th>来源</th>
                      <th>范围</th>
                      <th>摘要</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ruleRows.slice(0, 40).map((r) => {
                      const rid = r.id;
                      const explicit = String(r.source || "").includes("explicit") || Boolean(r.sourceRunId);
                      const titleLine = String(r.markdown || "")
                        .split("\n")
                        .find((ln) => ln.startsWith("# "))
                        ?.replace(/^#\s+/, "");
                      return (
                        <tr
                          key={String(rid)}
                          className={`${rulePreviewId === rid ? "is-selected" : ""}${explicit ? " evo-row-explicit" : ""}`}
                          onClick={() => setRulePreviewId(String(rid))}
                        >
                          <td>{String(rid)}</td>
                          <td>
                            {explicit ? (
                              <span className="evo-badge evo-badge--explicit">用户口语</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>{r.scope || "manager"}</td>
                          <td style={{ maxWidth: 280 }}>{(titleLine || r.sourceRunId || "—").slice(0, 80)}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              onClick={() => void ruleAction("rule_candidate_promote", rid)}
                            >
                              晋级
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={Boolean(busy)}
                              onClick={() => void ruleAction("rule_candidate_reject", rid)}
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
              <aside className="evo-rule-preview" aria-label="规则正文预览">
                <h3 className="evo-subhead">规则预览</h3>
                {rulePreviewId ? (
                  <pre className="evo-rule-preview__md">
                    {ruleCandidates.find((x) => x.id === rulePreviewId)?.markdown || "（无正文）"}
                  </pre>
                ) : (
                  <p className="muted">点击左侧一行查看 markdown 全文</p>
                )}
              </aside>
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
