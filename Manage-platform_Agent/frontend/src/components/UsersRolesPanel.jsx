import { useEffect, useState } from "react";
import { fetchJsonSafe } from "../utils/api";

function cell(ok) {
  return ok ? <span className="rbac-matrix__ok">允许</span> : <span className="rbac-matrix__no">—</span>;
}

const ROLE_OPTIONS = [
  { value: "user", label: "user（对话）" },
  { value: "viewer", label: "viewer（控制端只读）" },
  { value: "operator", label: "operator" },
  { value: "admin", label: "admin" },
];

export default function UsersRolesPanel({
  apiBase,
  token,
  role,
  users,
  newUser,
  setNewUser,
  loading,
  onCreateUser,
  onChangeRole,
  onResetPassword,
  onRemoveUser,
  currentUsername,
  onMessage,
}) {
  const [matrix, setMatrix] = useState(null);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const { ok, data } = await fetchJsonSafe(`${apiBase}/api/governance/rbac-matrix`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ok) setMatrix(data);
    })();
  }, [apiBase, token]);

  const roleCols = matrix?.roles?.length
    ? matrix.roles
    : ["user", "viewer", "operator", "admin"];

  const matrixTable = matrix?.domains ? (
    <table className="rbac-matrix">
      <thead>
        <tr>
          <th>控制面域</th>
          {roleCols.map((r) => (
            <th key={r}>{r}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {matrix.domains.map((d) => (
          <tr key={d.id}>
            <td>{d.label}</td>
            {roleCols.map((r) => (
              <td key={r}>{cell(Boolean(d[r]))}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <p className="muted">加载权限矩阵…</p>
  );

  if (role !== "admin") {
    return (
      <div className="page-stack page-stack--scroll admin-page">
        <div className="gov-page-intro">
          <p>
            当前角色 {role || "—"} 为只读视角。用户管理需 admin；下方为角色 × 控制面域执法表（user
            无任何控制面权限）。
          </p>
        </div>
        <section className="admin-card">
          <h3 className="admin-card__title">角色 × 控制面域</h3>
          <p className="admin-card__desc">{matrix?.note || "与后端 require_roles 对齐"}</p>
          {matrixTable}
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack page-stack--scroll admin-page">
      <div className="gov-page-intro">
        <p>
          控制台与 Agent UI 共用 ClawHive 身份。<strong>user</strong> 仅总管/子 Agent
          对话（禁止登控制端）；viewer 控制端只读；operator 运维；admin 治理与密钥。记忆按对话账号
          JWT.sub 隔离，不必先登控制端。
        </p>
      </div>
      <div className="admin-grid admin-grid--2">
        <section className="admin-card admin-card--accent">
          <h3 className="admin-card__title">用户管理</h3>
          <p className="admin-card__desc">创建账号、改角色、重置密码或删除（不可删除当前登录用户）</p>
          <form onSubmit={onCreateUser} className="form form--inline-grid">
            <label>
              用户名
              <input
                placeholder="username"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                placeholder="••••••"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                required
              />
            </label>
            <label>
              角色
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-primary btn-sm" disabled={loading}>
              创建用户
            </button>
          </form>
          <div className="compact-table admin-card__table">
            {users.length === 0 ? (
              <p className="muted">暂无用户</p>
            ) : (
              users.map((u) => (
                <div key={u.username} className="compact-table__row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span>{u.username}</span>
                  <select
                    value={u.role}
                    disabled={loading}
                    onChange={(e) => onChangeRole(u.username, e.target.value)}
                    aria-label={`${u.username} 角色`}
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={loading}
                    onClick={() => onResetPassword(u.username)}
                  >
                    改密
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={loading || u.username === currentUsername}
                    onClick={() => onRemoveUser(u.username)}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="admin-card">
          <h3 className="admin-card__title">角色 × 控制面域</h3>
          <p className="admin-card__desc">
            {matrix?.note || "与后端 require_roles 对齐"}
          </p>
          {matrixTable}
          <button
            type="button"
            className="btn-ghost btn-sm admin-card__foot-btn"
            onClick={() => onMessage?.("权限变更后立即由后端 403 执法，无需重启")}
          >
            权限说明
          </button>
        </section>
      </div>
    </div>
  );
}
