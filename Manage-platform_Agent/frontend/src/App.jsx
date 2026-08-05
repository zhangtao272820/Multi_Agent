import { useEffect, useMemo, useState } from "react";
import OpsOverview from "./components/OpsOverview";
import AdminShell from "./components/AdminShell";
import EnterpriseMonitorPanel from "./components/EnterpriseMonitorPanel";
import ManagerObservability from "./components/ManagerObservability";
import AgentConfigPanel from "./components/AgentConfigPanel";
import AgentControlPanel from "./components/AgentControlPanel";
import UsersRolesPanel from "./components/UsersRolesPanel";
import SettingsGovernance from "./components/SettingsGovernance";
import TaskProgressPanel from "./components/TaskProgressPanel";
import MonitorChartsPanel from "./components/MonitorChartsPanel";
import DeployCenterPanel from "./components/DeployCenterPanel";
import MaintainPanel from "./components/MaintainPanel";
import ObservabilityHub from "./components/ObservabilityHub";
import { fetchJsonSafe } from "./utils/api";
import { agentListLabel } from "./agentDisplayNames";
import { BRAND_AVATARS, BRAND_LOGOS } from "@brand/react/assetMap.js";
import BrandMotif from "@brand/react/BrandMotif.jsx";

const APP_ROUTES = [
  "overview",
  "manager",
  "monitor",
  "config",
  "agents",
  "tasks",
  "skills",
  "users",
  "tenants",
  "audit",
  "secrets",
  "settings",
  "deploy",
  "maintain",
];

function parseAppRoute(hash) {
  const raw = String(hash || "#/overview").replace(/^#/, "");
  const seg = (raw.startsWith("/") ? raw.slice(1) : raw).split("/")[0] || "overview";
  if (seg === "monitor") return "monitor";
  return APP_ROUTES.includes(seg) ? seg : "overview";
}

const browserHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
const pageProtocol = typeof window !== "undefined" ? window.location.protocol : "http:";
const pageHost = typeof window !== "undefined" ? window.location.host : `${browserHost}:5173`;
const defaultApiOrigin = import.meta.env.DEV ? `http://${browserHost}:8000` : "";
const defaultWsOrigin = import.meta.env.DEV
  ? `ws://${browserHost}:8000`
  : `${pageProtocol === "https:" ? "wss" : "ws"}://${pageHost}`;
const apiOrigin = import.meta.env.VITE_API_BASE_URL || defaultApiOrigin;
const wsOrigin = import.meta.env.VITE_WS_BASE_URL || defaultWsOrigin;
const API_BASE = apiOrigin.replace(/\/$/, "");
const WS_URL = `${wsOrigin.replace(/\/$/, "")}/ws/events`;

const defaultAgentForm = {
  name: "",
  category: "general",
  endpoint: "",
  status: "online",
};

const defaultSkillForm = {
  skill_id: "",
  name: "",
  version: "0.1.0",
  runtime: "python3.11",
  entrypoint: "",
  tags: "",
  description: "",
};

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("clawhive_token") || "");
  const [role, setRole] = useState(localStorage.getItem("clawhive_role") || "");
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcError, setOidcError] = useState("");
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [agents, setAgents] = useState([]);
  const [runtime, setRuntime] = useState({});
  const [runtimeMeta, setRuntimeMeta] = useState({ byName: {}, config_package: {}, image_version: "" });
  const [events, setEvents] = useState([]);
  const [agentForm, setAgentForm] = useState(defaultAgentForm);
  const [task, setTask] = useState("");
  const [targetAgentId, setTargetAgentId] = useState("");
  const [taskResult, setTaskResult] = useState(null);
  const [taskStartedAt, setTaskStartedAt] = useState(null);
  const [taskFlowEvents, setTaskFlowEvents] = useState([]);
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "viewer" });
  const [healthOverview, setHealthOverview] = useState(null);
  const [managerCluster, setManagerCluster] = useState(null);
  const [monitorSummary, setMonitorSummary] = useState(null);
  const [envSnapshot, setEnvSnapshot] = useState(null);
  const [managerObservability, setManagerObservability] = useState(null);
  const [promSnapshot, setPromSnapshot] = useState(null);
  const [platformError, setPlatformError] = useState("");
  const [skills, setSkills] = useState([]);
  const [skillPipelines, setSkillPipelines] = useState({});
  const [skillPipelineJobs, setSkillPipelineJobs] = useState({});
  const [skillInstalls, setSkillInstalls] = useState([]);
  const [skillStatusFilter, setSkillStatusFilter] = useState("");
  const [skillRuns, setSkillRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [selectedRunTraceUrl, setSelectedRunTraceUrl] = useState("");
  const [selectedRunLogUrl, setSelectedRunLogUrl] = useState("");
  const [skillPackageFile, setSkillPackageFile] = useState(null);
  const [skillImportRoot, setSkillImportRoot] = useState("");
  const [skillForm, setSkillForm] = useState(defaultSkillForm);
  const [skillInstallForm, setSkillInstallForm] = useState({
    skill_version_key: "",
    skill_id: "",
    version: "",
    agent_id: "",
    note: "",
    force_replace: false,
    rollout_strategy: "single-agent",
    target_agents_text: "",
    canary_percent: 10,
    failure_rate_threshold: 0.2,
    timeout_rate_threshold: 0.2,
    cost_threshold: 50000,
    total_cost_threshold: 10000,
  });
  const [rolloutJobs, setRolloutJobs] = useState([]);
  const [skillInvokeForm, setSkillInvokeForm] = useState({
    skill_version_key: "",
    skill_id: "",
    version: "",
    agent_id: "",
    input_json: '{"text":"hello"}',
    context_json: "{}",
  });
  const [installAgentFilter, setInstallAgentFilter] = useState("");
  const [skillsCenterTab, setSkillsCenterTab] = useState("market");
  const [registrySources, setRegistrySources] = useState([]);
  const [registryId, setRegistryId] = useState("internal_market");
  const [registrySkills, setRegistrySkills] = useState([]);
  const [registrySearch, setRegistrySearch] = useState("");
  const [registryKind, setRegistryKind] = useState("");
  const [registryAgent, setRegistryAgent] = useState("");
  const [catalogInstallAgentId, setCatalogInstallAgentId] = useState("");
  const [skillImportUrl, setSkillImportUrl] = useState("");
  const [skillImportSha256, setSkillImportSha256] = useState("");
  const [marketStats, setMarketStats] = useState(null);
  const [controlMode, setControlMode] = useState("unknown");
  const [controlMessage, setControlMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [wsState, setWsState] = useState("connecting");
  const [monitorAlerts, setMonitorAlerts] = useState([]);
  const [skillRunsSkillFilter, setSkillRunsSkillFilter] = useState("");
  const [appRoute, setAppRoute] = useState(
    typeof window !== "undefined" ? parseAppRoute(window.location.hash) : "overview"
  );

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    [agents]
  );
  const parseMaybeJson = (raw) => {
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const taskObservability = useMemo(() => {
    if (!taskResult) return null;
    const plannerObj = parseMaybeJson(taskResult.planner_output);
    if (!plannerObj || typeof plannerObj !== "object") return null;
    const timeline = plannerObj.phase_timeline || plannerObj.phaseTimeline;
    const tokens = plannerObj.token_summary || plannerObj.tokenSummary;
    if (!Array.isArray(timeline) && !tokens) return null;
    return {
      phaseTimeline: Array.isArray(timeline) ? timeline : [],
      tokenSummary: tokens && typeof tokens === "object" ? tokens : null,
      wallClockMs: Number(plannerObj.wall_clock_ms || plannerObj.wallClockMs || 0),
      runId: String(plannerObj.run_id || plannerObj.runId || ""),
    };
  }, [taskResult]);
  const taskManagerView = useMemo(() => {
    if (!taskResult) return null;
    const execObj = parseMaybeJson(taskResult.execution_output) || {};
    const plannerObj = parseMaybeJson(taskResult.planner_output) || {};
    const merged = {
      ...plannerObj,
      ...execObj,
      scheduler: execObj.scheduler || plannerObj.scheduler || null,
      security: execObj.security || plannerObj.security || null,
      monitor: execObj.monitor || plannerObj.monitor || null,
    };
    const scheduler = merged.scheduler && typeof merged.scheduler === "object" ? merged.scheduler : null;
    const security = merged.security && typeof merged.security === "object" ? merged.security : null;
    const monitor = merged.monitor && typeof merged.monitor === "object" ? merged.monitor : null;
    const hasAny = Boolean(scheduler || security || monitor);
    return hasAny ? { scheduler, security, monitor } : null;
  }, [taskResult]);

  useEffect(() => {
    if (token) fetchAgentsMinimal();
  }, [token]);

  useEffect(() => {
    // OIDC callback: ?access_token=...&role=... or ?oidc_error=...
    try {
      const params = new URLSearchParams(window.location.search || "");
      const err = params.get("oidc_error");
      if (err) {
        setOidcError(err);
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      }
      const at = params.get("access_token");
      if (at) {
        const r = params.get("role") || "viewer";
        setToken(at);
        setRole(r);
        localStorage.setItem("clawhive_token", at);
        localStorage.setItem("clawhive_role", r);
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      }
    } catch {
      /* ignore */
    }
    fetch(`${API_BASE}/api/auth/oidc/status`)
      .then((r) => r.json())
      .then((d) => setOidcEnabled(Boolean(d?.enabled)))
      .catch(() => setOidcEnabled(false));
  }, []);

  useEffect(() => {
    if (!token) return;
    loadRouteData(appRoute);
  }, [token, appRoute, role]);

  useEffect(() => {
    if (!token) return;
    if (appRoute !== "overview" && appRoute !== "manager") return;
    const ms = appRoute === "manager" ? 5000 : 30000;
    const t = setInterval(() => {
      if (appRoute === "overview") refreshOpsDashboard();
      if (appRoute === "manager") fetchManagerObservability();
    }, ms);
    return () => clearInterval(t);
  }, [token, appRoute]);

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    ws.onopen = () => setWsState("connected");
    ws.onclose = () => setWsState("disconnected");
    ws.onerror = () => setWsState("error");
    ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      setEvents((prev) => [data, ...prev].slice(0, 100));
      if (data.event_type === "agent.registered") {
        setAgents((prev) => [data.payload.agent, ...prev]);
      }
      if (data.event_type === "agent.runtime") {
        setRuntime((prev) => ({ ...prev, [data.payload.agent_name]: data.payload.running }));
      }
      if (data.event_type === "agent.runtime.bulk") {
        setRuntime((prev) => ({ ...prev, ...data.payload.results }));
      }
      if (String(data.event_type || "").startsWith("task.")) {
        setTaskFlowEvents((prev) => [data, ...prev].slice(0, 40));
      }
    };
    return () => ws.close();
  }, [token]);

  useEffect(() => {
    const onHash = () => setAppRoute(parseAppRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!token) return;
    if (appRoute === "monitor") fetchMonitorAlerts();
  }, [token, appRoute]);

  function navigateApp(route) {
    window.location.hash = route === "overview" ? "#/overview" : `#/${route}`;
    setAppRoute(route);
  }

  function formatApiError(data, fallback = "未知错误") {
    if (!data) return fallback;
    if (typeof data === "string") return data;
    if (typeof data?.detail === "string") return data.detail;
    if (typeof data?.message === "string") return data.message;
    if (data?.detail && typeof data.detail === "object") {
      const code = data.detail.code || data.detail.error_code;
      const msg = data.detail.message || data.detail.detail;
      if (code && msg) return `${code}: ${msg}`;
      if (code) return String(code);
      if (msg) return String(msg);
    }
    if (data?.detail) return JSON.stringify(data.detail);
    try {
      return JSON.stringify(data);
    } catch {
      return fallback;
    }
  }

  async function promInstant(expr) {
    const url = `${API_BASE}/api/metrics/prom/query?expr=${encodeURIComponent(expr)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(formatApiError(data, "Prometheus 查询失败"));
    const raw = data?.data?.data?.result?.[0]?.value?.[1];
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  async function appendMonitorAlert(alert) {
    try {
      const resp = await fetch(`${API_BASE}/api/monitor/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(alert),
      });
      const data = await resp.json();
      if (!resp.ok) return;
      const newAlert = data?.alert;
      if (!newAlert) return;
      setMonitorAlerts((prev) => {
        if (prev.some((x) => x.id === newAlert.id)) return prev;
        return [newAlert, ...prev].slice(0, 80);
      });
    } catch {
      // ignore alert persistence failure
    }
  }

  async function acknowledgeAlert(alertId) {
    try {
      const resp = await fetch(`${API_BASE}/api/monitor/alerts/${alertId}/ack`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (!resp.ok) {
        setControlMessage(`确认告警失败：${formatApiError(data)}`);
        return;
      }
      const next = data?.alert;
      setMonitorAlerts((prev) => prev.map((a) => (a.id === alertId ? (next || { ...a, acked: true }) : a)));
    } catch (e) {
      setControlMessage(`确认告警失败：${e?.message || e}`);
    }
  }

  async function login(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(formatApiError(errBody, response.status === 429 ? "配额已用尽" : "登录失败"));
      }
      const data = await response.json();
      setToken(data.access_token);
      setRole(data.role);
      localStorage.setItem("clawhive_token", data.access_token);
      localStorage.setItem("clawhive_role", data.role);
      localStorage.setItem("clawhive_username", loginForm.username.trim());
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken("");
    setRole("");
    localStorage.removeItem("clawhive_token");
    localStorage.removeItem("clawhive_role");
    localStorage.removeItem("clawhive_username");
  }

  async function fetchAgentsMinimal(retry = 0) {
    const response = await fetch(`${API_BASE}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (response.status === 503 && retry < 10) {
      setControlMessage("服务启动中，正在等待后端就绪…");
      await new Promise((r) => setTimeout(r, 1500));
      return fetchAgentsMinimal(retry + 1);
    }
    if (response.status === 401) {
      const detail = formatApiError(data, "登录已失效");
      setControlMessage(
        detail.includes("用户不存在")
          ? "登录状态失效（服务刚重启），请重新登录。"
          : "登录已失效，请重新登录。"
      );
      logout();
      return;
    }
    setAgents(Array.isArray(data) ? data : []);
    await fetchRuntime();
  }

  async function loadRouteData(route) {
    if (route === "overview") {
      setDashboardLoading(true);
      try {
        await Promise.all([refreshOpsDashboard(), fetchManagerObservability()]);
      } finally {
        setDashboardLoading(false);
      }
      return;
    }
    if (route === "manager") {
      setDashboardLoading(true);
      try {
        await fetchManagerObservability();
      } finally {
        setDashboardLoading(false);
      }
      return;
    }
    if (route === "skills") {
      setLoading(true);
      try {
        await Promise.all([
          fetchSkills(),
          fetchSkillInstalls(),
          fetchSkillRuns(),
          fetchRegistrySources(),
          fetchRegistrySkills(),
          fetchMarketStats(),
        ]);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (route === "settings" || route === "users") {
      await fetchEnvSnapshot();
      if (role === "admin") await fetchUsers();
      return;
    }
    if (route === "tenants" || route === "audit" || route === "secrets") {
      return;
    }
    if (route === "monitor") {
      await fetchMonitorAlerts();
    }
  }

  async function fetchAgents() {
    await fetchAgentsMinimal();
    await loadRouteData(appRoute);
  }

  async function refreshOpsDashboard() {
    setPlatformError("");
    const results = await Promise.all([fetchMonitorDashboard(), fetchEnvSnapshot()]);
    if (results.some((r) => r === false)) {
      setPlatformError("部分接口不可用：请确认 clawhive_backend 已启动（docker ps），并 Ctrl+F5 刷新。");
    }
  }

  async function fetchMonitorDashboard() {
    if (!token) return true;
    const { ok, data, error } = await fetchJsonSafe(`${API_BASE}/api/monitor/dashboard`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      setHealthOverview(null);
      setManagerCluster(null);
      setMonitorSummary(null);
      setPromSnapshot(null);
      if (error) setPlatformError(error);
      return false;
    }
    setHealthOverview(data.health || null);
    const mgr = data.manager || {};
    setManagerCluster({
      ok: Boolean(mgr.reachable),
      error: mgr.error,
      manager_endpoint: mgr.endpoint,
      metrics: {
        data: {
          runs: mgr.runs,
          phases: mgr.phases,
          tokenSummary: mgr.token_summary,
          evolution: mgr.evolution,
        },
      },
      registry: { data: mgr.registry },
    });
    const prom = data.prometheus || {};
    const audit = data.audit || {};
    setPromSnapshot({
      managerRuns: prom.manager_runs ?? audit.manager_runs ?? null,
      managerTokens: prom.manager_tokens ?? audit.total_tokens ?? null,
      searchHitRate: prom.search_hit_rate ?? audit.search_hit_rate ?? null,
      firstPassSuccessRate: prom.first_pass_success_rate ?? audit.first_pass_success_rate ?? null,
      agentsHealthy: prom.agents_healthy ?? audit.agents_healthy ?? null,
      agentsTotal: prom.agents_total ?? audit.agents_total ?? null,
    });
    setMonitorSummary({
      ok: data.ok,
      overall_status: data.overall_status,
      checked_at: data.checked_at,
      down_agents: data.down_agents,
      manager_reachable: mgr.reachable,
      manager_runs: mgr.runs,
      manager_phases: mgr.phases,
      manager_token_summary: mgr.token_summary,
      manager_evolution: mgr.evolution,
      audit,
      registry_count: Array.isArray(mgr.registry?.registry?.entries)
        ? mgr.registry.registry.entries.length
        : Array.isArray(mgr.registry?.entries)
          ? mgr.registry.entries.length
          : 0,
    });
    return true;
  }

  async function fetchPromSnapshot() {
    if (!token) return true;
    try {
      const [managerRuns, managerTokens, searchHitRate, firstPassSuccessRate] = await Promise.all([
        promInstant("manager_runs_total").catch(() => null),
        promInstant("manager_tokens_total").catch(() => null),
        promInstant("manager_search_hit_rate").catch(() => null),
        promInstant("manager_first_pass_success_rate").catch(() => null),
      ]);
      setPromSnapshot((prev) => ({
        ...(prev || {}),
        managerRuns,
        managerTokens,
        searchHitRate,
        firstPassSuccessRate,
      }));
      return true;
    } catch {
      setPromSnapshot(null);
      return false;
    }
  }

  async function fetchManagerObservability() {
    const { ok, data, error } = await fetchJsonSafe(`${API_BASE}/api/manager/observability`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      setManagerObservability(null);
      if (error) setPlatformError(error);
      return false;
    }
    setManagerObservability(data);
    return true;
  }

  async function fetchHealthOverview() {
    const { ok, data, error } = await fetchJsonSafe(`${API_BASE}/api/health/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      setHealthOverview(null);
      if (error) setPlatformError(error);
      return false;
    }
    setHealthOverview(data);
    return true;
  }

  async function fetchMonitorSummary() {
    const { ok, data, error } = await fetchJsonSafe(`${API_BASE}/api/monitor/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      setMonitorSummary(null);
      if (error) setPlatformError(error);
      return false;
    }
    setMonitorSummary(data);
    return true;
  }

  async function fetchEnvSnapshot() {
    const { ok, data } = await fetchJsonSafe(`${API_BASE}/api/platform/env-snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setEnvSnapshot(ok ? data : null);
    return ok;
  }

  async function fetchManagerCluster() {
    const { ok, data, error } = await fetchJsonSafe(`${API_BASE}/api/manager/cluster-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      setManagerCluster({ ok: false, error: error || data?.detail || "fetch_failed" });
      return false;
    }
    setManagerCluster(data);
    return true;
  }

  async function fetchUsers() {
    const response = await fetch(`${API_BASE}/api/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setUsers(Array.isArray(data) ? data : []);
  }

  async function fetchSkills(status = skillStatusFilter) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await fetch(`${API_BASE}/api/skills${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    const nextSkills = Array.isArray(data) ? data : [];
    setSkills(nextSkills);
    const entries = await Promise.all(
      nextSkills.map(async (s) => {
        try {
          const resp = await fetch(
            `${API_BASE}/api/skills/${encodeURIComponent(s.skill_id)}/pipeline?version=${encodeURIComponent(s.version)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const pipeline = await resp.json();
          if (!resp.ok) return [`${s.skill_id}@${s.version}`, null];
          return [`${s.skill_id}@${s.version}`, pipeline];
        } catch {
          return [`${s.skill_id}@${s.version}`, null];
        }
      })
    );
    setSkillPipelines(Object.fromEntries(entries));
    const jobEntries = await Promise.all(
      nextSkills.map(async (s) => {
        try {
          const resp = await fetch(
            `${API_BASE}/api/skills/${encodeURIComponent(s.skill_id)}/pipeline/jobs?version=${encodeURIComponent(
              s.version
            )}&limit=1`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const jobs = await resp.json();
          if (!resp.ok || !Array.isArray(jobs) || jobs.length === 0) return [`${s.skill_id}@${s.version}`, null];
          return [`${s.skill_id}@${s.version}`, jobs[0]];
        } catch {
          return [`${s.skill_id}@${s.version}`, null];
        }
      })
    );
    setSkillPipelineJobs(Object.fromEntries(jobEntries));
  }

  async function fetchMarketStats() {
    const response = await fetch(`${API_BASE}/api/skills/market/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (response.ok) setMarketStats(data);
  }

  async function fetchRegistrySources() {
    const response = await fetch(`${API_BASE}/api/skills/registry/sources`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setRegistrySources(Array.isArray(data.sources) ? data.sources : []);
  }

  async function fetchRegistrySkills(rid = registryId) {
    const params = new URLSearchParams({ registry_id: rid || "builtin" });
    if (registrySearch.trim()) params.set("q", registrySearch.trim());
    if (registryKind) params.set("kind", registryKind);
    if (registryAgent) params.set("agent", registryAgent);
    const response = await fetch(`${API_BASE}/api/skills/registry/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setRegistrySkills(Array.isArray(data.items) ? data.items : []);
  }

  async function catalogInstallSkill(item) {
    if (!catalogInstallAgentId) {
      setControlMessage("请先选择要赋能的目标 Agent");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/skills/catalog/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          source: "registry",
          registry_id: item.registry_id || registryId || "builtin",
          skill_id: item.skill_id,
          version: item.latest || item.version || "",
          target_agents: [catalogInstallAgentId],
          force_replace: true,
          auto_publish: true,
          note: "catalog install from UI",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`赋能失败：${formatApiError(data)}`);
      } else {
        setControlMessage(data.message || "赋能成功");
        await Promise.all([fetchSkills(), fetchSkillInstalls(catalogInstallAgentId), fetchRegistrySkills(), fetchMarketStats()]);
        setSkillsCenterTab("installed");
        setInstallAgentFilter(catalogInstallAgentId);
      }
    } finally {
      setLoading(false);
    }
  }

  async function importSkillFromUrl(event) {
    event.preventDefault();
    if (!skillImportUrl.trim()) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/skills/import/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          package_url: skillImportUrl.trim(),
          sha256: skillImportSha256.trim(),
          registry_id: registryId,
          auto_publish: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`URL 导入失败：${formatApiError(data)}`);
      } else {
        setControlMessage(`URL 导入成功：${data.skill_id}@${data.version}`);
        setSkillImportUrl("");
        setSkillImportSha256("");
        await fetchSkills();
      }
    } finally {
      setLoading(false);
    }
  }

  async function resyncSkill(record) {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/skills/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skill_id: record.skill_id,
          version: record.version,
          agent_id: record.agent_id,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`重新同步失败：${formatApiError(data)}`);
      } else {
        setControlMessage(data.result?.sync_status === "synced" ? "同步成功" : `同步异常：${data.result?.sync_error || ""}`);
      }
      await fetchSkillInstalls(record.agent_id || installAgentFilter);
    } finally {
      setLoading(false);
    }
  }

  async function fetchSkillInstalls(agentId = installAgentFilter) {
    const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    const response = await fetch(`${API_BASE}/api/skills/installs${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setSkillInstalls(Array.isArray(data) ? data : []);
  }

  async function publishSkillVersion(skillId, version) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, note: "manual publish" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`发布失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(`已发布 ${skillId}@${version}`);
    await fetchSkills();
  }

  async function reviewSkillVersion(skillId, version) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, note: "manual review" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`提审失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(`已提审 ${skillId}@${version}`);
    await fetchSkills();
  }

  async function signSkillVersion(skillId, version) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, note: "manual sign" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`签名失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(`已签名 ${skillId}@${version}`);
    await fetchSkills();
  }

  async function deprecateSkillVersion(skillId, version) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/deprecate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, note: "manual deprecate" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`下线失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(`已下线 ${skillId}@${version}`);
    await fetchSkills();
  }

  async function updatePipelineStage(skillId, version, stage, result = "passed") {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/pipeline/${stage}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        version,
        result,
        note: `manual ${stage}`,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`流水线更新失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(`流水线阶段已更新：${skillId}@${version} / ${stage}=${result}`);
    setSkillPipelines((prev) => ({ ...prev, [`${skillId}@${version}`]: data.pipeline || null }));
  }

  async function runPipelineJob(skillId, version, forceRetry = false) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/pipeline/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, force_retry: forceRetry }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`流水线任务创建失败：${formatApiError(data)}`);
      return;
    }
    const job = data.job || null;
    if (!job?.job_id) {
      setControlMessage("流水线任务创建失败：缺少 job_id");
      return;
    }
    setSkillPipelineJobs((prev) => ({ ...prev, [`${skillId}@${version}`]: job }));
    setControlMessage(
      data.deduped
        ? `已有执行中的流水线任务：${job.job_id}`
        : `流水线任务已创建：${job.job_id}（${skillId}@${version}）`
    );
    pollPipelineJob(skillId, version, job.job_id);
  }

  async function pollPipelineJob(skillId, version, jobId) {
    let done = false;
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const response = await fetch(`${API_BASE}/api/skills/pipeline/jobs/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`查询流水线任务失败：${formatApiError(data)}`);
        return;
      }
      setSkillPipelineJobs((prev) => ({ ...prev, [`${skillId}@${version}`]: data }));
      done = data.status === "success" || data.status === "failed";
      if (done) {
        await fetchSkills(skillStatusFilter);
        setControlMessage(
          data.status === "success"
            ? `流水线执行完成：${skillId}@${version}`
            : `流水线执行失败：${skillId}@${version} / ${data.error || "请查看详情"}`
        );
      }
    }
  }

  async function releaseSkillVersion(skillId, version) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, note: "one-click release" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`一键发布失败：${formatApiError(data)}`);
      return;
    }
    const finalStatus = data?.release?.status || "unknown";
    setControlMessage(`一键发布完成：${skillId}@${version} -> ${finalStatus}`);
    await fetchSkills(skillStatusFilter);
  }

  async function runPipelineAndRelease(skillId, version) {
    const response = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/pipeline/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, force_retry: true }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`创建流水线任务失败：${formatApiError(data)}`);
      return;
    }
    const job = data.job || null;
    if (!job?.job_id) {
      setControlMessage("创建流水线任务失败：缺少 job_id");
      return;
    }
    setSkillPipelineJobs((prev) => ({ ...prev, [`${skillId}@${version}`]: job }));
    setControlMessage(`流水线执行中：${skillId}@${version} / ${job.job_id}`);

    let done = false;
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const jr = await fetch(`${API_BASE}/api/skills/pipeline/jobs/${encodeURIComponent(job.job_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const jd = await jr.json();
      if (!jr.ok) {
        setControlMessage(`查询流水线任务失败：${formatApiError(jd)}`);
        return;
      }
      setSkillPipelineJobs((prev) => ({ ...prev, [`${skillId}@${version}`]: jd }));
      done = jd.status === "success" || jd.status === "failed";
      if (done && jd.status === "failed") {
        await fetchSkills(skillStatusFilter);
        setControlMessage(`流水线失败，未发布：${skillId}@${version} / ${jd.error || "请查看详情"}`);
        return;
      }
    }
    await fetchSkills(skillStatusFilter);
    await releaseSkillVersion(skillId, version);
  }

  async function rollbackSkill(record) {
    const toVersion = window.prompt(`请输入回滚版本（skill=${record.skill_id}）`);
    if (!toVersion) return;
    const response = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(record.agent_id)}/skills/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_id: record.skill_id,
        to_version: toVersion.trim(),
        note: "manual rollback",
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`回滚失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(data.message || "回滚完成");
    await fetchSkillInstalls(record.agent_id || installAgentFilter);
  }

  async function fetchRuntime() {
    const response = await fetch(`${API_BASE}/api/agents/runtime`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    const runningMap = data.running || {};
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const byName = {};
    for (const row of agents) {
      if (row?.name) byName[row.name] = row;
      if (row?.name && row.actual_state) {
        runningMap[row.name] = row.actual_state === "running";
      }
    }
    setRuntime(runningMap);
    setControlMode(data.control_mode || "unknown");
    setRuntimeMeta({
      byName,
      config_package: data.config_package || {},
      image_version: data.image_version || "",
    });
  }

  async function fetchSkillRuns(skillId = skillRunsSkillFilter) {
    const q = skillId ? `&skill_id=${encodeURIComponent(skillId)}` : "";
    const response = await fetch(`${API_BASE}/api/skills/runs?limit=50${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setSkillRuns(Array.isArray(data) ? data : []);
  }

  async function fetchMonitorAlerts() {
    const response = await fetch(`${API_BASE}/api/monitor/alerts?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`获取告警失败：${formatApiError(data)}`);
      return;
    }
    setMonitorAlerts(Array.isArray(data) ? data : []);
  }

  async function ackAllMonitorAlerts() {
    const response = await fetch(`${API_BASE}/api/monitor/alerts/ack-all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`确认全部告警失败：${formatApiError(data)}`);
      return;
    }
    await fetchMonitorAlerts();
  }

  async function clearMonitorAlerts() {
    const response = await fetch(`${API_BASE}/api/monitor/alerts`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`清空告警失败：${formatApiError(data)}`);
      return;
    }
    setMonitorAlerts([]);
  }

  async function submitAgent(event) {
    event.preventDefault();
    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(agentForm),
      });
      setAgentForm(defaultAgentForm);
      await fetchAgents();
    } finally {
      setLoading(false);
    }
  }

  async function executeTask(event) {
    event.preventDefault();
    if (!task.trim()) return;
    setLoading(true);
    setTaskResult(null);
    setTaskStartedAt(null);
    setTaskFlowEvents([]);
    try {
      const response = await fetch(`${API_BASE}/api/tasks/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          task,
          target_agent_id: targetAgentId || null,
          priority: "normal",
          context: {},
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setControlMessage(result?.detail || result?.message || `提交失败 (${response.status})`);
        return;
      }
      setTaskResult(result);
      setTaskStartedAt(Date.now());
      if (result?.task_id) {
        pollTaskResult(result.task_id);
      }
    } finally {
      setLoading(false);
    }
  }

  async function pollTaskResult(taskId) {
    let finished = false;
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const response = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json();
      setTaskResult(result);
      finished = ["success", "failed", "dead"].includes(result.status);
    }
  }

  async function startAgent(name) {
    const response = await fetch(`${API_BASE}/api/agents/${name}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok || !data.started) {
      setControlMessage(`启动 ${name} 失败：${data.detail || data.error || "未知错误"}`);
    } else {
      setControlMessage(`已启动 ${name}（${data.control_mode || controlMode}）`);
    }
    await fetchAgents();
  }

  async function stopAgent(name) {
    const response = await fetch(`${API_BASE}/api/agents/${name}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok || !data.stopped) {
      setControlMessage(`停止 ${name} 失败：${data.detail || data.error || "未知错误"}`);
    } else {
      setControlMessage(`已停止 ${name}（${data.control_mode || controlMode}）`);
    }
    await fetchAgents();
  }

  async function drainAgent(name) {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(name)}/drain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`Drain ${name} 失败：${data.detail || data.error || "未知错误"}`);
      } else {
        setControlMessage(`已 Drain ${name}`);
      }
      await fetchAgents();
    } finally {
      setLoading(false);
    }
  }

  async function rollingRestartAgent(name) {
    setLoading(true);
    setControlMessage(`正在滚动重启 ${name}…`);
    try {
      const response = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(name)}/rolling-restart?timeout_sec=120`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`滚动重启 ${name} 失败：${JSON.stringify(data.detail || data)}`);
      } else {
        setControlMessage(`滚动重启完成 ${name}（${data.result?.steps || "ok"}）`);
      }
      await fetchAgents();
    } finally {
      setLoading(false);
    }
  }

  async function startAllAgents() {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/agents/start-all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setControlMessage("已执行一键启动，请查看列表状态。");
      await fetchAgents();
    } finally {
      setLoading(false);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(newUser),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setControlMessage(String(data.detail || `创建用户失败 HTTP ${res.status}`));
        return;
      }
      setNewUser({ username: "", password: "", role: "viewer" });
      setControlMessage(`已创建用户 ${newUser.username}`);
      await fetchUsers();
    } finally {
      setLoading(false);
    }
  }

  async function resetUserPassword(username) {
    const pwd = window.prompt(`为 ${username} 设置新密码（至少 6 位）`);
    if (pwd == null) return;
    if (String(pwd).trim().length < 6) {
      setControlMessage("密码至少 6 位");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: String(pwd).trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setControlMessage(String(data.detail || `改密失败 HTTP ${res.status}`));
        return;
      }
      setControlMessage(`已重置 ${username} 的密码`);
    } finally {
      setLoading(false);
    }
  }

  async function removeUser(username) {
    if (!window.confirm(`确认删除用户 ${username}？`)) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setControlMessage(String(data.detail || `删除失败 HTTP ${res.status}`));
        return;
      }
      setControlMessage(`已删除用户 ${username}`);
      await fetchUsers();
    } finally {
      setLoading(false);
    }
  }

  async function changeUserRole(username, nextRole) {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setControlMessage(String(data.detail || `改角色失败 HTTP ${res.status}`));
        return;
      }
      setControlMessage(`已将 ${username} 设为 ${nextRole}`);
      await fetchUsers();
    } finally {
      setLoading(false);
    }
  }

  async function createSkill(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const payload = {
        ...skillForm,
        tags: skillForm.tags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
      await fetch(`${API_BASE}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      setSkillForm(defaultSkillForm);
      setControlMessage(`技能 ${payload.skill_id}@${payload.version} 已发布`);
      await fetchSkills();
    } finally {
      setLoading(false);
    }
  }

  async function uploadSkillPackage(event) {
    event.preventDefault();
    if (!skillPackageFile) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("package", skillPackageFile);
      const response = await fetch(`${API_BASE}/api/skills/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`技能包上传失败：${formatApiError(data)}`);
      } else {
        setControlMessage(`技能包已导入：${data.skill_id}@${data.version}`);
        setSkillPackageFile(null);
        await fetchSkills();
      }
    } finally {
      setLoading(false);
    }
  }

  async function importSkillsFromWorkspace(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const q = skillImportRoot.trim() ? `?root=${encodeURIComponent(skillImportRoot.trim())}` : "";
      const response = await fetch(`${API_BASE}/api/skills/import/workspace${q}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`工作区导入失败：${formatApiError(data)}`);
      } else {
        setControlMessage(`工作区导入完成：新增 ${data.imported_count}，跳过 ${data.skipped_count}`);
        await fetchSkills();
      }
    } finally {
      setLoading(false);
    }
  }

  async function installSkill(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skill_id: skillInstallForm.skill_id,
          version: skillInstallForm.version,
          agent_id: skillInstallForm.agent_id,
          note: skillInstallForm.note,
          force_replace: skillInstallForm.force_replace,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`技能安装失败：${formatApiError(data)}`);
      } else {
        setControlMessage(data.message || "技能安装成功");
      }
      await fetchSkillInstalls(skillInstallForm.agent_id || installAgentFilter);
    } finally {
      setLoading(false);
    }
  }

  async function uninstallSkill(record) {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/skills/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skill_id: record.skill_id,
          version: record.version,
          agent_id: record.agent_id,
          note: "manual uninstall",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`技能卸载失败：${formatApiError(data)}`);
      } else {
        setControlMessage(data.message || "技能已卸载");
      }
      await fetchSkillInstalls(record.agent_id || installAgentFilter);
    } finally {
      setLoading(false);
    }
  }

  async function createRolloutJob(event) {
    event.preventDefault();
    const targetAgents = skillInstallForm.target_agents_text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!skillInstallForm.skill_id || !skillInstallForm.version || targetAgents.length === 0) {
      setControlMessage("请先选择技能，并填写目标 Agent ID 列表（逗号分隔）");
      return;
    }
    const response = await fetch(`${API_BASE}/api/skills/rollouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_id: skillInstallForm.skill_id,
        version: skillInstallForm.version,
        strategy: skillInstallForm.rollout_strategy,
        target_agents: targetAgents,
        canary_percent: Number(skillInstallForm.canary_percent || 10),
        failure_rate_threshold: Number(skillInstallForm.failure_rate_threshold || 0.2),
        timeout_rate_threshold: Number(skillInstallForm.timeout_rate_threshold || 0.2),
        cost_threshold: Number(skillInstallForm.cost_threshold || 50000),
        total_cost_threshold: Number(skillInstallForm.total_cost_threshold || 10000),
        force_replace: true,
        note: skillInstallForm.note || "manual rollout",
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`创建 rollout 失败：${formatApiError(data)}`);
      return;
    }
    setControlMessage(`rollout 已创建：${data.job?.job_id || "-"}`);
    await fetchRolloutJobs(skillInstallForm.skill_id, skillInstallForm.version);
  }

  async function fetchRolloutJobs(skillId = skillInstallForm.skill_id, version = skillInstallForm.version) {
    if (!skillId || !version) return;
    const response = await fetch(
      `${API_BASE}/api/skills/rollouts?skill_id=${encodeURIComponent(skillId)}&version=${encodeURIComponent(version)}&limit=20`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`获取 rollout 失败：${formatApiError(data)}`);
      return;
    }
    setRolloutJobs(Array.isArray(data) ? data : []);
  }

  async function invokeSkill(event) {
    event.preventDefault();
    setLoading(true);
    try {
      let inputData = {};
      let contextData = {};
      try {
        inputData = JSON.parse(skillInvokeForm.input_json || "{}");
        contextData = JSON.parse(skillInvokeForm.context_json || "{}");
      } catch {
        setControlMessage("技能执行失败：input/context 不是合法 JSON");
        return;
      }
      const response = await fetch(`${API_BASE}/api/skills/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          skill_id: skillInvokeForm.skill_id,
          version: skillInvokeForm.version,
          agent_id: skillInvokeForm.agent_id || "",
          input_data: inputData,
          context: contextData,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setControlMessage(`技能执行失败：${formatApiError(data)}`);
      } else {
        setSelectedRun(data.run || null);
        setSelectedRunTraceUrl("");
        setSelectedRunLogUrl("");
        const tid = String(data.run?.trace_id || data.run?.run_id || "").trim();
        if (tid) {
          try {
            const linkRes = await fetch(
              `${API_BASE}/api/observability/trace-link?trace_id=${encodeURIComponent(tid)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const linkData = await linkRes.json();
            if (linkRes.ok && (linkData?.grafana_explore_url || linkData?.langfuse_url)) {
              setSelectedRunTraceUrl(
                String(linkData.grafana_explore_url || linkData.langfuse_url || "")
              );
            }
          } catch {
            /* ignore */
          }
          try {
            const logRes = await fetch(
              `${API_BASE}/api/observability/log-link?run_id=${encodeURIComponent(tid)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const logData = await logRes.json();
            if (logRes.ok && logData?.grafana_loki_url) {
              setSelectedRunLogUrl(String(logData.grafana_loki_url));
            }
          } catch {
            /* ignore */
          }
        }
        setControlMessage(
          `技能执行完成：${data.run?.skill_id}@${data.run?.version} / ${data.run?.status} / ${data.run?.duration_ms}ms`
        );
      }
      await fetchSkillRuns();
    } finally {
      setLoading(false);
    }
  }

  async function viewRunDetail(runId) {
    const response = await fetch(`${API_BASE}/api/skills/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      setControlMessage(`获取运行详情失败：${data.detail || "未知错误"}`);
      return;
    }
    setSelectedRun(data);
    setSelectedRunTraceUrl("");
    setSelectedRunLogUrl("");
    const tid = String(data?.trace_id || data?.run_id || runId || "").trim();
    if (tid) {
      try {
        const linkRes = await fetch(
          `${API_BASE}/api/observability/trace-link?trace_id=${encodeURIComponent(tid)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const linkData = await linkRes.json();
        if (linkRes.ok && (linkData?.grafana_explore_url || linkData?.langfuse_url)) {
          setSelectedRunTraceUrl(
            String(linkData.grafana_explore_url || linkData.langfuse_url || "")
          );
        }
      } catch {
        /* ignore deep-link failures */
      }
      try {
        const logRes = await fetch(
          `${API_BASE}/api/observability/log-link?run_id=${encodeURIComponent(tid)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const logData = await logRes.json();
        if (logRes.ok && logData?.grafana_loki_url) {
          setSelectedRunLogUrl(String(logData.grafana_loki_url));
        }
      } catch {
        /* ignore deep-link failures */
      }
    }
  }

  async function stopAllAgents() {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/agents/stop-all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setControlMessage("已执行一键停止，请查看列表状态。");
      await fetchAgents();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`page ${token ? "page--admin" : ""}`}>
      {!token ? (
        <div className="login-panel brand-shell" data-agent="platform">
          <div className="platform-season-bg platform-season-bg--hanlu" aria-hidden="true" />
          <BrandMotif motif="leaves" fixed />
          <section className="card login-card platform-glass">
            <div className="login-card__brand">
              <img className="login-card__logo" src={BRAND_LOGOS.platform} alt="" width={52} height={52} />
              <div className="login-card__titles">
                <p className="login-card__eyebrow">寒露 · 紫微</p>
                <h1 className="login-card__title">紫微</h1>
                <p className="login-card__sub">Agent 控制面 · 运维治理与星曜集群</p>
              </div>
              <img className="login-card__avatar" src={BRAND_AVATARS.platform} alt="" width={56} height={56} title="紫微虚拟形象" />
            </div>
            {oidcError ? <p className="status offline login-card__err">SSO 失败：{oidcError}</p> : null}
            <form onSubmit={login} className="form login-card__form">
              <label className="login-card__field">
                <span>用户名</span>
                <input
                  placeholder="请输入用户名"
                  autoComplete="username"
                  value={loginForm.username}
                  onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                  required
                />
              </label>
              <label className="login-card__field">
                <span>密码</span>
                <input
                  type="password"
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                  required
                />
              </label>
              <button className="btn-primary login-card__submit" disabled={loading} type="submit">
                {loading ? "登录中…" : "进入控制面"}
              </button>
            </form>
            {oidcEnabled ? (
              <p className="login-sso">
                <a className="btn-secondary" href={`${API_BASE}/api/auth/oidc/login`}>
                  企业 SSO 登录
                </a>
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {token ? (
        <AdminShell
          route={appRoute}
          onNavigate={navigateApp}
          wsState={wsState}
          role={role}
          onLogout={logout}
          clusterSummary={{
            running: Object.values(runtime || {}).filter(Boolean).length,
            total: (sortedAgents || []).length || Object.keys(runtime || {}).length,
            alerts: (monitorAlerts || []).filter((a) => !a.acked).length,
            configVersion: runtimeMeta?.config_package?.version || "",
          }}
        >
      {dashboardLoading && (appRoute === "overview" || appRoute === "manager") ? (
        <p className="page-loading-hint">正在加载监控数据…</p>
      ) : null}
      {appRoute === "monitor" ? (
        <ObservabilityHub
          apiBase={API_BASE}
          token={token}
          alerts={monitorAlerts}
          onAckAlert={acknowledgeAlert}
          onAckAllAlerts={ackAllMonitorAlerts}
          onClearAlerts={clearMonitorAlerts}
          onRefreshAlerts={fetchMonitorAlerts}
        >
          <MonitorChartsPanel
            token={token}
            apiBase={API_BASE}
            alerts={monitorAlerts}
            onError={setControlMessage}
            onAppendAlert={appendMonitorAlert}
            onAckAlert={acknowledgeAlert}
            onAckAllAlerts={ackAllMonitorAlerts}
            onClearAlerts={clearMonitorAlerts}
          />
          <EnterpriseMonitorPanel
            observability={managerObservability}
            promSnapshot={promSnapshot}
            loading={loading}
            onNavigate={navigateApp}
            onRefresh={async () => {
              await fetchManagerObservability();
              await fetchPromSnapshot();
            }}
          />
        </ObservabilityHub>
      ) : null}

      {appRoute === "overview" ? (
        <div className="page-stack">
        <OpsOverview
          healthOverview={healthOverview}
          managerCluster={managerCluster}
          monitorSummary={monitorSummary}
          envSnapshot={envSnapshot}
          promSnapshot={promSnapshot}
          platformError={platformError}
          loading={loading}
          onRefresh={refreshOpsDashboard}
        />

        <EnterpriseMonitorPanel
          observability={managerObservability}
          promSnapshot={promSnapshot}
          loading={loading}
          onNavigate={navigateApp}
          onRefresh={async () => {
            await fetchManagerObservability();
            await fetchPromSnapshot();
          }}
        />

        <nav className="link-nav" aria-label="快捷入口">
          <button type="button" className="link-nav__item" onClick={() => navigateApp("manager")}>
            <span className="link-nav__title">总管 & 子 Agent</span>
            <span className="link-nav__desc">Token · 阶段耗时 · 调用流水</span>
          </button>
          <button type="button" className="link-nav__item" onClick={() => navigateApp("monitor")}>
            <span className="link-nav__title">监控大屏</span>
            <span className="link-nav__desc">总管 & 子 Agent · Prometheus</span>
          </button>
          <button type="button" className="link-nav__item" onClick={() => navigateApp("tasks")}>
            <span className="link-nav__title">任务编排</span>
            <span className="link-nav__desc">Manager WebSocket 转发</span>
          </button>
        </nav>
        </div>
      ) : null}

      {appRoute === "manager" ? (
        <ManagerObservability
          data={managerObservability}
          loading={loading}
          onRefresh={fetchManagerObservability}
        />
      ) : null}

      {appRoute === "tasks" ? (
        <div className="page-stack">
        <section className="panel">
          <p className="panel-eyebrow">任务调度</p>
          <p className="task-hint">
            目标选「Manager 编排」或留空：经 WebSocket 调用总管 Agent 执行（P1 平台转发）。
            选择具体子 Agent 名称时走 LangGraph 规划建议（不替代 Manager 全家桶）。
          </p>
          <form onSubmit={executeTask} className="form">
            <textarea
              placeholder="例如：查知识库并联网总结某行业趋势，给出可核验来源"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
              required
            />
            <select value={targetAgentId} onChange={(e) => setTargetAgentId(e.target.value)}>
              <option value="">Manager 编排（推荐，默认）</option>
              <option value="manager">Manager 编排（显式）</option>
              {sortedAgents.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  LangGraph → {agentListLabel(agent.name)}
                </option>
              ))}
            </select>
            <button disabled={loading} type="submit">
              {loading ? "执行中..." : "提交任务"}
            </button>
          </form>
          <TaskProgressPanel
            taskId={taskResult?.task_id}
            status={taskResult?.status}
            startedAt={taskStartedAt}
            events={taskFlowEvents.filter(
              (e) => !taskResult?.task_id || e.payload?.task_id === taskResult.task_id
            )}
            summary={taskResult?.status === "running" ? "Worker 正在处理，请稍候…" : taskResult?.summary}
            error={taskResult?.raw?.last_error || (taskResult?.status === "failed" ? taskResult?.summary : "")}
            phaseTimeline={taskObservability?.phaseTimeline}
            tokenSummary={taskObservability?.tokenSummary}
            wallClockMs={taskObservability?.wallClockMs}
          />
          {taskResult && (
            <div className="result">
              <h3>任务结果</h3>
              <p>
                <strong>状态：</strong> {taskResult.status}
              </p>
              <p>
                <strong>摘要：</strong> {taskResult.summary}
              </p>
              {String(taskResult.planner_output || "").includes("manager_ws") ? (
                <p className="task-hint">已通过 Manager WebSocket 编排执行</p>
              ) : null}
              <details>
                <summary>Planner 输出</summary>
                <pre>{taskResult.planner_output}</pre>
              </details>
              <details>
                <summary>执行输出</summary>
                <pre>{taskResult.execution_output}</pre>
              </details>
              <details open={Boolean(taskManagerView)}>
                <summary>Manager 内置协作视图（Security / Scheduler / Monitor）</summary>
                {!taskManagerView ? (
                  <p className="muted">无结构化 Manager 视图（可能为 LangGraph 路径）</p>
                ) : (
                  <>
                    <details>
                      <summary>security</summary>
                      <pre>{JSON.stringify(taskManagerView.security || { message: "no security payload" }, null, 2)}</pre>
                    </details>
                    <details>
                      <summary>scheduler</summary>
                      <pre>{JSON.stringify(taskManagerView.scheduler || { message: "no scheduler payload" }, null, 2)}</pre>
                    </details>
                    <details>
                      <summary>monitor</summary>
                      <pre>{JSON.stringify(taskManagerView.monitor || { message: "no monitor payload" }, null, 2)}</pre>
                    </details>
                  </>
                )}
              </details>
            </div>
          )}
        </section>

        <section className="panel panel--scroll">
          <p className="panel-eyebrow">实时事件流</p>
          <div className="events events--flat">
            {events.length === 0 && <p className="muted">等待任务 / Agent 事件…</p>}
            {events.map((evt, idx) => (
              <div className="event" key={`${evt.timestamp}-${idx}`}>
                <p>
                  <strong>{evt.event_type}</strong> @ {new Date(evt.timestamp).toLocaleString()}
                </p>
                <pre>{JSON.stringify(evt.payload, null, 2)}</pre>
              </div>
            ))}
          </div>
        </section>
        </div>
      ) : null}

      {appRoute === "config" ? (
        <AgentConfigPanel
          apiBase={API_BASE}
          token={token}
          role={role}
          onMessage={(msg) => setPlatformError(msg)}
          onNavigate={navigateApp}
        />
      ) : null}

      {appRoute === "deploy" ? (
        <DeployCenterPanel
          apiBase={API_BASE}
          token={token}
          role={role}
          onMessage={setControlMessage}
        />
      ) : null}

      {appRoute === "maintain" ? (
        <MaintainPanel
          apiBase={API_BASE}
          token={token}
          role={role}
          onMessage={setControlMessage}
        />
      ) : null}

      {appRoute === "agents" ? (
        <AgentControlPanel
          controlMode={controlMode}
          controlMessage={controlMessage}
          loading={loading}
          sortedAgents={sortedAgents}
          runtime={runtime}
          runtimeMeta={runtimeMeta}
          agentForm={agentForm}
          setAgentForm={setAgentForm}
          onRefresh={fetchAgents}
          onStartAll={startAllAgents}
          onStopAll={stopAllAgents}
          onStart={startAgent}
          onStop={stopAgent}
          onDrain={drainAgent}
          onRollingRestart={rollingRestartAgent}
          onSubmitRegister={submitAgent}
        />
      ) : null}

      {appRoute === "skills" ? (
        <main className="dashboard dashboard--single">
        <div className="dashboard-col">
        <section className="card card--dense">
          <h2>技能中心</h2>
          <p className="card-lead">公共市场发现技能并一键赋能 Agent；已安装可查看同步状态。</p>
          {marketStats ? (
            <p className="muted">
              市场技能 {marketStats.catalog_skills ?? 0} · 本地 {marketStats.local_skills ?? 0} ·
              已安装 {marketStats.installed_count ?? 0} · 已同步 {marketStats.synced_count ?? 0}
              {marketStats.failed_sync_count ? ` · 同步失败 ${marketStats.failed_sync_count}` : ""}
            </p>
          ) : null}
          <div className="row">
            {[
              ["market", "公共市场"],
              ["installed", "已安装"],
              ["local", "本地管理"],
              ["invoke", "执行引擎"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={skillsCenterTab === id ? "tab-active" : ""}
                onClick={() => setSkillsCenterTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {skillsCenterTab === "market" ? (
        <section className="card card--dense card--scroll">
          <h2>公共技能市场</h2>
          <p className="card-lead">内置 Registry；选择 Agent 后点击「赋能」完成导入、安装与同步。</p>
          <div className="card__body-scroll">
          <div className="card-section">
            <h3 className="card-section-title">Registry 源</h3>
            <div className="row">
              <select
                value={registryId}
                onChange={async (e) => {
                  const v = e.target.value;
                  setRegistryId(v);
                  await fetchRegistrySkills(v);
                }}
              >
                {registrySources.length === 0 ? <option value="builtin">builtin</option> : null}
                {registrySources.map((s) => (
                  <option key={s.registry_id} value={s.registry_id}>
                    {s.label || s.registry_id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="card-section">
            <h3 className="card-section-title">筛选</h3>
            <div className="row">
              <input
                placeholder="搜索技能 ID / 名称 / 描述"
                value={registrySearch}
                onChange={(e) => setRegistrySearch(e.target.value)}
              />
              <select value={registryKind} onChange={(e) => setRegistryKind(e.target.value)}>
                <option value="">全部类型</option>
                <option value="playbook">playbook</option>
                <option value="executable">executable</option>
              </select>
              <select value={registryAgent} onChange={(e) => setRegistryAgent(e.target.value)}>
                <option value="">全部 Agent</option>
                {sortedAgents.map((a) => (
                  <option key={a.agent_id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => fetchRegistrySkills()} disabled={loading}>
                搜索
              </button>
            </div>
          </div>
          <div className="card-section">
            <h3 className="card-section-title">赋能目标</h3>
            <select
              value={catalogInstallAgentId}
              onChange={(e) => setCatalogInstallAgentId(e.target.value)}
            >
              <option value="">选择目标 Agent</option>
              {sortedAgents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="list section-gap">
            {registrySkills.length === 0 ? <p className="muted">暂无技能，请刷新或调整筛选</p> : null}
            {registrySkills.map((item) => (
              <div className="item" key={`${item.registry_id}-${item.skill_id}`}>
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.skill_id}@{item.latest} · {item.kind}</p>
                  <p className="muted">{item.description}</p>
                  <p className="muted">
                    标签: {(item.tags || []).join(", ") || "—"}
                    {" · "}
                    兼容: {(item.compatible_agents || []).join(", ")}
                    {item.package_url ? ` · 包: ${item.package_url}` : ""}
                    {item.sha256 ? ` · sha256: ${item.sha256.slice(0, 12)}…` : ""}
                    {item.local_installed ? ` · 本地: ${item.local_status || "yes"}` : ""}
                  </p>
                </div>
                <div className="agent-actions">
                  <span className={`status ${item.status === "published" ? "online" : "offline"}`}>
                    {item.status}
                  </span>
                  <button type="button" disabled={loading || !catalogInstallAgentId} onClick={() => catalogInstallSkill(item)}>
                    赋能到 Agent
                  </button>
                </div>
              </div>
            ))}
          </div>
          </div>
        </section>
        ) : null}

        {skillsCenterTab === "installed" ? (
        <section className="card card--dense card--scroll">
          <h2>已安装技能</h2>
          <div className="card__body-scroll">
          <div className="row section-gap">
            <select
              value={installAgentFilter}
              onChange={async (e) => {
                const v = e.target.value;
                setInstallAgentFilter(v);
                await fetchSkillInstalls(v);
              }}
            >
              <option value="">全部 Agent 安装记录</option>
              {sortedAgents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => fetchSkillInstalls(installAgentFilter)}>
              刷新
            </button>
          </div>
          <div className="list section-gap">
            {skillInstalls.length === 0 ? <p className="muted">暂无安装记录</p> : null}
            {skillInstalls.map((r, idx) => (
              <div className="item" key={`${r.skill_id}-${r.agent_id}-${idx}`}>
                <div>
                  <strong>{r.skill_id}@{r.version}</strong>
                  <p>{r.agent_name} / {r.kind || "—"} / {r.installed_by}</p>
                  {r.sync_path ? <p className="muted">path: {r.sync_path}</p> : null}
                  {r.sync_error ? <p className="muted">sync: {r.sync_error}</p> : null}
                </div>
                <div className="agent-actions">
                  <span
                    className={`status ${
                      r.sync_status === "synced" || r.sync_status === "synced_pending_reload"
                        ? "online"
                        : "offline"
                    }`}
                  >
                    {r.sync_status || r.status}
                  </span>
                  {r.status === "installed" ? (
                    <>
                      <button type="button" onClick={() => resyncSkill(r)}>重新同步</button>
                      <button type="button" onClick={() => uninstallSkill(r)}>卸载</button>
                      <button type="button" onClick={() => rollbackSkill(r)}>回滚</button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          </div>
        </section>
        ) : null}

        {skillsCenterTab === "local" ? (
        <section className="card card--dense card--scroll">
          <h2>本地技能管理</h2>
          <p className="card-lead">筛选、导入技能包或手动发布；下方区域可滚动，避免撑满整页。</p>
          <div className="card__body-scroll">
          <div className="card-section">
            <h3 className="card-section-title">筛选</h3>
            <div className="row">
              <select
                value={skillStatusFilter}
                onChange={async (e) => {
                  const v = e.target.value;
                  setSkillStatusFilter(v);
                  await fetchSkills(v);
                }}
              >
                <option value="">全部状态</option>
                <option value="published">published</option>
                <option value="deprecated">deprecated</option>
                <option value="draft">draft</option>
                <option value="review">review</option>
                <option value="signed">signed</option>
                <option value="archived">archived</option>
              </select>
              <button type="button" onClick={() => fetchSkills(skillStatusFilter)}>
                刷新技能列表
              </button>
            </div>
          </div>

          <div className="card-section">
            <h3 className="card-section-title">从 URL 导入（远程 Registry 包）</h3>
            <form onSubmit={importSkillFromUrl} className="form">
              <input
                placeholder="package_url（http(s) 或相对路径）"
                value={skillImportUrl}
                onChange={(e) => setSkillImportUrl(e.target.value)}
              />
              <input
                placeholder="sha256（可选，建议填写）"
                value={skillImportSha256}
                onChange={(e) => setSkillImportSha256(e.target.value)}
              />
              <button type="submit" disabled={loading || !skillImportUrl.trim()}>
                URL 导入并发布
              </button>
            </form>
          </div>

          <div className="card-section">
            <h3 className="card-section-title">上传与扫描</h3>
            <form onSubmit={uploadSkillPackage} className="form">
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setSkillPackageFile(e.target.files?.[0] || null)}
              />
              <button type="submit" disabled={loading || !skillPackageFile}>
                上传技能包（zip + skill.yaml）
              </button>
            </form>
            <form onSubmit={importSkillsFromWorkspace} className="form form--tight-top">
              <input
                placeholder="导入目录（留空默认 WORKSPACE_ROOT）"
                value={skillImportRoot}
                onChange={(e) => setSkillImportRoot(e.target.value)}
              />
              <button type="submit" disabled={loading}>
                从工作区扫描导入 skill.yaml
              </button>
            </form>
          </div>

          <div className="card-section">
            <h3 className="card-section-title">手动发布</h3>
            <form onSubmit={createSkill} className="form">
              <input
                placeholder="技能ID，例如 data.cleaning.standardize"
                value={skillForm.skill_id}
                onChange={(e) => setSkillForm({ ...skillForm, skill_id: e.target.value })}
                required
              />
              <input
                placeholder="技能名称"
                value={skillForm.name}
                onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })}
                required
              />
              <div className="row">
                <input
                  placeholder="版本号"
                  value={skillForm.version}
                  onChange={(e) => setSkillForm({ ...skillForm, version: e.target.value })}
                />
                <input
                  placeholder="运行时，例如 python3.11"
                  value={skillForm.runtime}
                  onChange={(e) => setSkillForm({ ...skillForm, runtime: e.target.value })}
                />
              </div>
              <input
                placeholder="入口点，例如 entrypoint/main.py:run"
                value={skillForm.entrypoint}
                onChange={(e) => setSkillForm({ ...skillForm, entrypoint: e.target.value })}
              />
              <input
                placeholder="标签（逗号分隔）"
                value={skillForm.tags}
                onChange={(e) => setSkillForm({ ...skillForm, tags: e.target.value })}
              />
              <textarea
                placeholder="技能描述"
                value={skillForm.description}
                onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })}
                rows={3}
              />
              <button type="submit" disabled={loading}>
                发布技能
              </button>
            </form>
          </div>

          <div className="list section-gap">
            {skills.length === 0 ? <p className="muted">暂无技能</p> : null}
            {skills.map((s) => (
              <div className="item" key={`${s.skill_id}@${s.version}`}>
                <div>
                  <strong>{s.name}</strong>
                  <p>{s.skill_id}@{s.version}</p>
                  <p className="muted">
                    pipeline:
                    {" "}
                    {(() => {
                      const p = skillPipelines[`${s.skill_id}@${s.version}`];
                      if (!p?.stages) return "loading";
                      const review = p.stages.review?.result || "pending";
                      const scan = p.stages.scan?.result || "pending";
                      const signature = p.stages.signature?.result || "pending";
                      const smoke = p.stages.smoke_test?.result || "pending";
                      const ready = p.publish_ready ? "ready" : "blocked";
                      return `review=${review} / scan=${scan} / signature=${signature} / smoke=${smoke} / ${ready}`;
                    })()}
                  </p>
                  <p className="muted">
                    job:
                    {" "}
                    {(() => {
                      const job = skillPipelineJobs[`${s.skill_id}@${s.version}`];
                      if (!job) return "none";
                      return `${job.status} / ${job.job_id}${job.error ? ` / ${job.error}` : ""}`;
                    })()}
                  </p>
                </div>
                <div className="agent-actions">
                  <span className={`status ${s.status === "published" ? "online" : "offline"}`}>{s.status}</span>
                  <button
                    type="button"
                    onClick={() => runPipelineAndRelease(s.skill_id, s.version)}
                  >
                    一键流水线并发布
                  </button>
                  <button
                    type="button"
                    onClick={() => runPipelineJob(s.skill_id, s.version, false)}
                  >
                    自动执行流水线
                  </button>
                  <button
                    type="button"
                    onClick={() => runPipelineJob(s.skill_id, s.version, true)}
                  >
                    重试流水线
                  </button>
                  <button
                    type="button"
                    onClick={() => updatePipelineStage(s.skill_id, s.version, "review")}
                    disabled
                    title="已弱化：建议使用自动流水线"
                  >
                    审核通过
                  </button>
                  <button
                    type="button"
                    onClick={() => updatePipelineStage(s.skill_id, s.version, "scan")}
                    disabled
                    title="已弱化：建议使用自动流水线"
                  >
                    扫描通过
                  </button>
                  <button
                    type="button"
                    onClick={() => updatePipelineStage(s.skill_id, s.version, "signature")}
                    disabled
                    title="已弱化：建议使用自动流水线"
                  >
                    签名通过
                  </button>
                  <button
                    type="button"
                    onClick={() => updatePipelineStage(s.skill_id, s.version, "smoke-test")}
                    disabled
                    title="已弱化：建议使用自动流水线"
                  >
                    冒烟通过
                  </button>
                  <button
                    type="button"
                    onClick={() => reviewSkillVersion(s.skill_id, s.version)}
                    disabled={s.status !== "draft"}
                  >
                    提审
                  </button>
                  <button
                    type="button"
                    onClick={() => signSkillVersion(s.skill_id, s.version)}
                    disabled={s.status !== "review"}
                  >
                    签名
                  </button>
                  <button
                    type="button"
                    onClick={() => publishSkillVersion(s.skill_id, s.version)}
                    disabled={s.status !== "signed" || !skillPipelines[`${s.skill_id}@${s.version}`]?.publish_ready}
                  >
                    发布
                  </button>
                  <button
                    type="button"
                    onClick={() => deprecateSkillVersion(s.skill_id, s.version)}
                    disabled={s.status !== "published"}
                  >
                    下线
                  </button>
                </div>
              </div>
            ))}
          </div>
          </div>
        </section>
        ) : null}

        {skillsCenterTab === "local" ? (
        <section className="card card--dense">
          <h2>技能安装与 Rollout</h2>
          <form onSubmit={installSkill} className="form">
            <select
              value={skillInstallForm.skill_version_key}
              onChange={(e) => {
                const selected = skills.find((s) => `${s.skill_id}@${s.version}` === e.target.value);
                setSkillInstallForm({
                  ...skillInstallForm,
                  skill_version_key: e.target.value,
                  skill_id: selected?.skill_id || "",
                  version: selected?.version || "",
                });
              }}
              required
            >
              <option value="">选择技能</option>
              {skills.map((s) => (
                <option key={`${s.skill_id}@${s.version}`} value={`${s.skill_id}@${s.version}`}>
                  {s.skill_id}@{s.version}
                </option>
              ))}
            </select>
            <select
              value={skillInstallForm.agent_id}
              onChange={(e) => setSkillInstallForm({ ...skillInstallForm, agent_id: e.target.value })}
              required
            >
              <option value="">选择目标 Agent</option>
              {sortedAgents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.name}
                </option>
              ))}
            </select>
            <input
              placeholder="安装备注（可选）"
              value={skillInstallForm.note}
              onChange={(e) => setSkillInstallForm({ ...skillInstallForm, note: e.target.value })}
            />
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={skillInstallForm.force_replace}
                onChange={(e) => setSkillInstallForm({ ...skillInstallForm, force_replace: e.target.checked })}
              />
              强制替换已安装的其他版本
            </label>
            <button type="submit" disabled={loading}>
              安装技能
            </button>
          </form>
          <form onSubmit={createRolloutJob} className="form form--tight-top">
            <h3 className="card-section-title">灰度/批量安装与自动回滚</h3>
            <select
              value={skillInstallForm.rollout_strategy}
              onChange={(e) => setSkillInstallForm({ ...skillInstallForm, rollout_strategy: e.target.value })}
            >
              <option value="single-agent">single-agent</option>
              <option value="batch">batch</option>
              <option value="canary">canary</option>
            </select>
            <input
              placeholder="目标 Agent IDs（逗号分隔）"
              value={skillInstallForm.target_agents_text}
              onChange={(e) => setSkillInstallForm({ ...skillInstallForm, target_agents_text: e.target.value })}
            />
            <div className="row">
              <input
                type="number"
                placeholder="canary %"
                value={skillInstallForm.canary_percent}
                onChange={(e) => setSkillInstallForm({ ...skillInstallForm, canary_percent: e.target.value })}
              />
              <input
                type="number"
                step="0.01"
                placeholder="失败率阈值"
                value={skillInstallForm.failure_rate_threshold}
                onChange={(e) => setSkillInstallForm({ ...skillInstallForm, failure_rate_threshold: e.target.value })}
              />
            </div>
            <div className="row">
              <input
                type="number"
                step="0.01"
                placeholder="超时率阈值"
                value={skillInstallForm.timeout_rate_threshold}
                onChange={(e) => setSkillInstallForm({ ...skillInstallForm, timeout_rate_threshold: e.target.value })}
              />
              <input
                type="number"
                placeholder="成本阈值(token)"
                value={skillInstallForm.cost_threshold}
                onChange={(e) => setSkillInstallForm({ ...skillInstallForm, cost_threshold: e.target.value })}
              />
            </div>
            <input
              type="number"
              step="0.1"
              placeholder="综合成本阈值(total_cost)"
              value={skillInstallForm.total_cost_threshold}
              onChange={(e) => setSkillInstallForm({ ...skillInstallForm, total_cost_threshold: e.target.value })}
            />
            <div className="row">
              <button type="submit" disabled={loading}>
                启动 Rollout
              </button>
              <button type="button" onClick={() => fetchRolloutJobs()}>
                刷新 Rollout
              </button>
            </div>
          </form>
          <div className="list section-gap">
            {rolloutJobs.length === 0 ? <p className="muted">暂无 rollout 记录</p> : null}
            {rolloutJobs.map((j) => (
              <div className="item" key={j.job_id}>
                <div>
                  <strong>{j.skill_id}@{j.version}</strong>
                  <p>{j.strategy} / {j.status}</p>
                </div>
                <div className="agent-actions">
                  <span className={`status ${j.status === "success" ? "online" : j.status === "rolled_back" ? "degraded" : "offline"}`}>
                    {j.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
        ) : null}

        {skillsCenterTab === "invoke" ? (
        <section className="card card--dense card--scroll">
          <h2>技能执行引擎</h2>
          <p className="card-lead">沙箱子进程执行技能；下方区域可滚动查看调用、历史 run 与详情。</p>
          <div className="card__body-scroll">
          <div className="card-section">
            <h3 className="card-section-title">调用参数</h3>
            <form onSubmit={invokeSkill} className="form">
              <select
                value={skillInvokeForm.skill_version_key}
                onChange={(e) => {
                  const selected = skills.find((s) => `${s.skill_id}@${s.version}` === e.target.value);
                  setSkillInvokeForm({
                    ...skillInvokeForm,
                    skill_version_key: e.target.value,
                    skill_id: selected?.skill_id || "",
                    version: selected?.version || "",
                  });
                }}
                required
              >
                <option value="">选择技能</option>
                {skills.map((s) => (
                  <option key={`${s.skill_id}@${s.version}`} value={`${s.skill_id}@${s.version}`}>
                    {s.skill_id}@{s.version}
                  </option>
                ))}
              </select>
              <select
                value={skillInvokeForm.agent_id}
                onChange={(e) => setSkillInvokeForm({ ...skillInvokeForm, agent_id: e.target.value })}
              >
                <option value="">不绑定 Agent（直接执行）</option>
                {sortedAgents.map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <textarea
                rows={3}
                placeholder='input_data JSON，例如 {"text":"hello"}'
                value={skillInvokeForm.input_json}
                onChange={(e) => setSkillInvokeForm({ ...skillInvokeForm, input_json: e.target.value })}
              />
              <textarea
                rows={2}
                placeholder='context JSON，例如 {"tenant":"default"}'
                value={skillInvokeForm.context_json}
                onChange={(e) => setSkillInvokeForm({ ...skillInvokeForm, context_json: e.target.value })}
              />
              <button type="submit" disabled={loading}>
                执行技能
              </button>
            </form>
          </div>

          <div className="card-section">
            <h3 className="card-section-title">运行记录</h3>
            <div className="row">
              <button type="button" onClick={() => fetchSkillRuns(skillRunsSkillFilter)}>
                刷新运行记录
              </button>
              <button
                type="button"
                onClick={() => {
                  setSkillRunsSkillFilter("");
                  fetchSkillRuns("");
                }}
              >
                清除运行过滤
              </button>
            </div>
            {skillRunsSkillFilter ? <p className="muted">当前运行过滤：{skillRunsSkillFilter}</p> : null}
            <div className="list section-gap">
              {skillRuns.length === 0 ? <p className="muted">暂无运行记录</p> : null}
              {skillRuns.map((r) => (
                <div className="item" key={r.run_id}>
                  <div>
                    <strong>{r.skill_id}@{r.version}</strong>
                    <p>{r.agent_name || "direct-run"} / {r.duration_ms}ms</p>
                  </div>
                  <div className="agent-actions">
                    <span className={`status ${r.status === "success" ? "online" : "offline"}`}>{r.status}</span>
                    <button type="button" onClick={() => viewRunDetail(r.run_id)}>
                      详情
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedRun ? (
            <div className="result section-gap">
              <h3>运行详情：{selectedRun.run_id}</h3>
              <p>
                <strong>状态:</strong> {selectedRun.status}
              </p>
              <p className="trace-id-row">
                <strong>Trace ID:</strong> {selectedRun.trace_id || selectedRun.run_id}
                {selectedRunTraceUrl ? (
                  <a
                    className="btn-secondary btn-secondary--sm"
                    href={selectedRunTraceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    追踪 · Tempo
                  </a>
                ) : null}
                {selectedRunLogUrl ? (
                  <a
                    className="btn-secondary btn-secondary--sm"
                    href={selectedRunLogUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    日志 · Loki
                  </a>
                ) : null}
              </p>
              <p>
                <strong>错误码:</strong> {selectedRun.error_code || "-"}
              </p>
              <p>
                <strong>成本(tokens):</strong> {selectedRun.cost_tokens ?? 0}
              </p>
              <p>
                <strong>耗时:</strong> {selectedRun.duration_ms}ms
              </p>
              <details>
                <summary>输入</summary>
                <pre>{JSON.stringify(selectedRun.input || {}, null, 2)}</pre>
              </details>
              <details>
                <summary>输出</summary>
                <pre>{JSON.stringify(selectedRun.output || {}, null, 2)}</pre>
              </details>
              <details>
                <summary>日志</summary>
                <pre>{selectedRun.logs || "(empty)"}</pre>
              </details>
              {selectedRun.error ? (
                <details>
                  <summary>错误堆栈</summary>
                  <pre>{selectedRun.error}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
          </div>
        </section>
        ) : null}

        </div>
        </main>
      ) : null}

      {appRoute === "users" ? (
        <UsersRolesPanel
          apiBase={API_BASE}
          token={token}
          role={role}
          users={users}
          newUser={newUser}
          setNewUser={setNewUser}
          loading={loading}
          onCreateUser={createUser}
          onChangeRole={changeUserRole}
          onResetPassword={resetUserPassword}
          onRemoveUser={removeUser}
          currentUsername={localStorage.getItem("clawhive_username") || loginForm.username}
          onMessage={setControlMessage}
        />
      ) : null}

      {appRoute === "tenants" ? (
        <div className="page-stack page-stack--scroll admin-page">
          <SettingsGovernance
            apiBase={API_BASE}
            token={token}
            role={role}
            onMessage={setControlMessage}
            section="tenants"
          />
        </div>
      ) : null}

      {appRoute === "audit" ? (
        <div className="page-stack page-stack--scroll admin-page">
          <SettingsGovernance
            apiBase={API_BASE}
            token={token}
            role={role}
            onMessage={setControlMessage}
            section="audit"
          />
        </div>
      ) : null}

      {appRoute === "secrets" ? (
        <div className="page-stack page-stack--scroll admin-page">
          <SettingsGovernance
            apiBase={API_BASE}
            token={token}
            role={role}
            onMessage={setControlMessage}
            section="secrets"
          />
        </div>
      ) : null}

      {appRoute === "settings" ? (
        <div className="page-stack page-stack--scroll admin-page">
          <div className="admin-grid admin-grid--2">
            <section className="admin-card">
              <h3 className="admin-card__title">环境登记</h3>
              <p className="admin-card__desc">
                只读快照 · 与 Manager 端点同步配置对齐。用户/租户/审计/密钥请用左侧治理菜单。
              </p>
              {envSnapshot?.agents?.length ? (
                <div className="compact-table">
                  {envSnapshot.agents.map((a) => (
                    <div className="compact-table__row" key={a.name}>
                      <span>{a.name}</span>
                      <span className="muted">{a.endpoint}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">暂无数据，点击下方刷新</p>
              )}
              <button
                type="button"
                className="btn-secondary btn-sm admin-card__foot-btn"
                onClick={() => fetchEnvSnapshot()}
              >
                刷新环境快照
              </button>
            </section>
            <section className="admin-card">
              <h3 className="admin-card__title">治理入口</h3>
              <p className="admin-card__desc">CP-Gov 已拆页</p>
              <div className="form form--inline-grid">
                <button type="button" className="btn-secondary btn-sm" onClick={() => (window.location.hash = "#/users")}>
                  用户与角色
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => (window.location.hash = "#/tenants")}>
                  租户与配额
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => (window.location.hash = "#/audit")}>
                  审计
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => (window.location.hash = "#/secrets")}>
                  密钥与通知
                </button>
              </div>
            </section>
          </div>
        </div>
      ) : null}
        </AdminShell>
      ) : null}
    </div>
  );
}
