# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(r"E:\Agent\Vanna_DbAgent\frontend\index.html")
text = p.read_text(encoding="utf-8")
assert "正在读取目录" in text

css_old = "    .examples { flex: 1; min-height: 0; }"
css_new = """    .examples { flex: 1; min-height: 0; }
    .login-gate {
      position: fixed; inset: 0; z-index: 40;
      display: none; align-items: center; justify-content: center;
      background: rgba(27, 42, 65, 0.55);
      backdrop-filter: blur(4px);
    }
    .login-gate.on { display: flex; }
    .login-card {
      width: min(360px, 92vw);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 28px 24px 22px;
    }
    .login-card h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }
    .login-card .sub { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .login-card label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .login-card input {
      width: 100%; box-sizing: border-box; margin-bottom: 12px;
      border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-size: 14px;
    }
    .login-card button {
      width: 100%; border: 0; border-radius: 10px; padding: 11px 14px;
      background: var(--accent); color: #fff; font-size: 14px; cursor: pointer;
    }
    .login-card button:disabled { opacity: 0.6; cursor: wait; }
    .login-err { color: var(--warn); font-size: 13px; min-height: 1.2em; margin: 0 0 10px; }"""
if css_old not in text:
    raise SystemExit("css anchor missing")
text = text.replace(css_old, css_new, 1)

body_old = "<body>\n  <div class=\"shell\">"
body_new = """<body>
  <div class="login-gate" id="loginGate" aria-hidden="true">
    <form class="login-card" id="loginForm">
      <h1>Vanna 库问数</h1>
      <p class="sub">使用 ClawHive 账号登录后进入协作问数。</p>
      <label for="loginUser">用户名</label>
      <input id="loginUser" name="username" autocomplete="username" required />
      <label for="loginPass">密码</label>
      <input id="loginPass" name="password" type="password" autocomplete="current-password" required />
      <p class="login-err" id="loginErr"></p>
      <button type="submit" id="loginGo">登录</button>
    </form>
  </div>
  <div class="shell">"""
if body_old not in text:
    raise SystemExit("body anchor missing")
text = text.replace(body_old, body_new, 1)

script_old = """    const $ = (id) => document.getElementById(id);
    const SESSION_KEY = "vanna_session_id";
    const FEEDBACK_KEY = "vanna_session_feedback";
    let pendingId = "";
    let lastSql = "";
    let lastQuestion = "";
    let feedbackByMsg = {};
    let scenes = [];
    let maxQuestion = 400;
    let sessionId = localStorage.getItem(SESSION_KEY) || "";
    let liveCard = null;

    function escapeHtml(v) {
      if (v == null) return "";
      return String(v).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }

    async function boot() {
      const meta = await fetch("/api/meta").then((r) => r.json());"""

script_new = """    const $ = (id) => document.getElementById(id);
    const SESSION_KEY = "vanna_session_id";
    const FEEDBACK_KEY = "vanna_session_feedback";
    const TOKEN_KEY = "clawhive_access_token";
    let pendingId = "";
    let lastSql = "";
    let lastQuestion = "";
    let feedbackByMsg = {};
    let scenes = [];
    let maxQuestion = 400;
    let sessionId = localStorage.getItem(SESSION_KEY) || "";
    let liveCard = null;
    let authToken = localStorage.getItem(TOKEN_KEY) || "";

    function escapeHtml(v) {
      if (v == null) return "";
      return String(v).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }

    function setAuthToken(token) {
      authToken = String(token || "").trim();
      if (authToken) localStorage.setItem(TOKEN_KEY, authToken);
      else localStorage.removeItem(TOKEN_KEY);
    }

    function showLogin(msg) {
      $("loginErr").textContent = msg || "";
      $("loginGate").classList.add("on");
      $("loginGate").setAttribute("aria-hidden", "false");
    }

    function hideLogin() {
      $("loginGate").classList.remove("on");
      $("loginGate").setAttribute("aria-hidden", "true");
      $("loginErr").textContent = "";
    }

    async function api(url, opts = {}) {
      const headers = Object.assign({}, opts.headers || {});
      if (authToken) headers["Authorization"] = "Bearer " + authToken;
      const res = await fetch(url, Object.assign({}, opts, { headers }));
      if (res.status === 401) {
        const body = await res.clone().json().catch(() => ({}));
        const detail = String(body.detail || "");
        if (/login_required|invalid_user_token|jwt_/i.test(detail)) {
          setAuthToken("");
          showLogin(detail === "login_required" ? "请先登录" : "登录已失效，请重新登录");
          throw new Error(detail || "login_required");
        }
      }
      return res;
    }

    $("loginForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = $("loginGo");
      btn.disabled = true;
      $("loginErr").textContent = "";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            username: $("loginUser").value.trim(),
            password: $("loginPass").value,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(data.detail || ("HTTP " + res.status)));
        const access = String(data.access_token || "").trim();
        if (!access) throw new Error("缺少 access_token");
        setAuthToken(access);
        hideLogin();
        await boot();
      } catch (err) {
        $("loginErr").textContent = String(err.message || err);
      } finally {
        btn.disabled = false;
      }
    });

    async function boot() {
      const metaRes = await api("/api/meta");
      const meta = await metaRes.json();
      hideLogin();"""

if script_old not in text:
    raise SystemExit("script boot anchor missing")
text = text.replace(script_old, script_new, 1)

# replace remaining API fetches (keep auth/login)
import re
text2, n = re.subn(r'fetch\("/api/(?!auth/)', 'api("/api/', text)
print("api replacements", n)
text = text2

boot_catch_old = '    boot().catch((err) => { $("catalogStatus").textContent = "无法连接 API：" + err; });'
boot_catch_new = '''    boot().catch((err) => {
      const msg = String(err && err.message || err);
      if (/login_required|invalid_user_token|jwt_/i.test(msg)) {
        showLogin(msg === "login_required" ? "请先登录" : "登录已失效，请重新登录");
        return;
      }
      $("catalogStatus").textContent = "无法连接 API：" + err;
    });'''
if boot_catch_old not in text:
    raise SystemExit("boot catch missing")
text = text.replace(boot_catch_old, boot_catch_new, 1)

p.write_text(text, encoding="utf-8")
assert "正在读取目录" in p.read_text(encoding="utf-8")
assert "loginGate" in p.read_text(encoding="utf-8")
assert 'api("/api/meta")' in p.read_text(encoding="utf-8")
print("OK")
