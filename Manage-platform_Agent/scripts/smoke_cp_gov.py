#!/usr/bin/env python3
"""CP-Gov 守门：离线契约 + 可选对运行中 ClawHive 做角色隔离抽验。

用法:
  python scripts/smoke_cp_gov.py
  python scripts/smoke_cp_gov.py --base http://127.0.0.1:18000 --user admin --password admin123

退出码 0 = 通过。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def _fail(msg: str) -> None:
    print(f"[FAIL] {msg}")
    raise SystemExit(1)


def _ok(msg: str) -> None:
    print(f"[OK] {msg}")


def smoke_offline() -> None:
    from app.governance import (
        SENSITIVE_AUDIT_ACTIONS,
        backup_policy_payload,
        notify_status_payload,
        rbac_matrix_payload,
    )
    from app.secret_vault import open_secret_value, seal_secret_value

    matrix = rbac_matrix_payload()
    if not matrix.get("ok") or len(matrix.get("domains") or []) < 8:
        _fail("rbac_matrix domains too few")
    admin_only = [d for d in matrix["domains"] if d["admin"] and not d["viewer"] and not d["operator"]]
    if not any(d["id"] == "users" for d in admin_only):
        _fail("users domain must be admin-only vs viewer")
    _ok(f"rbac_matrix domains={len(matrix['domains'])}")

    actions = {a["action"] for a in SENSITIVE_AUDIT_ACTIONS}
    required = {
        "auth.login_failed",
        "user.update_role",
        "tenant.quota.set",
        "capability_models.update",
        "agents_lan.update",
        "agent.drain",
        "ops.backup.postgres",
        "ops.backup.restore",
        "secret.rotate",
        "audit.export",
    }
    missing = required - actions
    if missing:
        _fail(f"SENSITIVE_AUDIT_ACTIONS missing {missing}")
    _ok(f"sensitive_actions={len(SENSITIVE_AUDIT_ACTIONS)}")

    notify = notify_status_payload()
    if "alert_webhook_configured" not in notify or "vault_at_rest_enabled" not in notify:
        _fail("notify_status_payload shape")
    _ok("notify_status_payload")

    policy = backup_policy_payload(backup_items=[])
    if int(policy.get("retain_count") or 0) < 1:
        _fail("backup retain_count")
    if "health_gate" not in policy:
        _fail("backup policy missing health_gate")
    _ok(f"backup_policy retain={policy['retain_count']}")

    # Fernet roundtrip only when key set; otherwise seal returns None (honest)
    sealed = seal_secret_value("cp-gov-smoke-secret")
    if sealed:
        opened = open_secret_value(sealed)
        if opened != "cp-gov-smoke-secret":
            _fail("vault Fernet roundtrip failed")
        _ok("vault Fernet roundtrip (CLAWHIVE_VAULT_KEY set)")
    else:
        _ok("vault Fernet skipped (CLAWHIVE_VAULT_KEY unset — expected)")


def smoke_live(base: str, user: str, password: str) -> None:
    try:
        import urllib.error
        import urllib.request
    except ImportError as exc:  # pragma: no cover
        _fail(str(exc))

    base = base.rstrip("/")

    def req(method: str, path: str, *, token: str | None = None, body: dict | None = None, expect: int | None = None):
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(f"{base}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                code = resp.status
                payload = json.loads(raw) if raw.strip().startswith(("{", "[")) else raw
                if expect is not None and code != expect:
                    _fail(f"{method} {path} expected {expect} got {code}")
                return code, payload
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"detail": raw}
            if expect is not None and exc.code != expect:
                _fail(f"{method} {path} expected {expect} got {exc.code}: {payload}")
            return exc.code, payload

    code, _ = req("GET", "/health/ready", expect=None)
    if code not in (200, 503):
        _fail(f"/health/ready unexpected {code}")
    if code == 503:
        print("[WARN] /health/ready=503 (deps not all up); continuing API checks")
    else:
        _ok("/health/ready")

    # failed login must 401 (audit side-effect on server)
    req("POST", "/api/auth/login", body={"username": user, "password": "definitely-wrong-cp-gov"}, expect=401)
    _ok("auth.login_failed path returns 401")

    _, login = req("POST", "/api/auth/login", body={"username": user, "password": password}, expect=200)
    token = str(login.get("access_token") or "")
    role = str(login.get("role") or "")
    if not token:
        _fail("login missing access_token")
    _ok(f"login role={role}")

    _, matrix = req("GET", "/api/governance/rbac-matrix", token=token, expect=200)
    if not matrix.get("domains"):
        _fail("live rbac-matrix empty")
    _ok("GET /api/governance/rbac-matrix")

    if role == "admin":
        _, check = req("GET", "/api/governance/audit-checklist", token=token, expect=200)
        if "items" not in check:
            _fail("audit-checklist missing items")
        _ok(f"audit-checklist covered={check.get('covered_count')}/{check.get('required_count')}")

        # export must include tenant_id header
        code, csv_body = req("GET", "/api/audit-logs/export?format=csv&limit=5", token=token, expect=200)
        text = csv_body if isinstance(csv_body, str) else str(csv_body)
        if "tenant_id" not in text.splitlines()[0]:
            _fail("audit CSV missing tenant_id column")
        _ok("audit export CSV has tenant_id")
    else:
        req("GET", "/api/governance/audit-checklist", token=token, expect=403)
        _ok("non-admin denied audit-checklist")

    req("GET", "/api/ops/backup/policy", token=token, expect=200)
    _ok("GET /api/ops/backup/policy")

    if role in ("operator", "admin"):
        req("GET", "/api/governance/notify-status", token=token, expect=200)
        _ok("GET /api/governance/notify-status")


def main() -> None:
    parser = argparse.ArgumentParser(description="CP-Gov smoke")
    parser.add_argument("--base", default="", help="ClawHive API base, e.g. http://127.0.0.1:18000")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password", default="admin123")
    args = parser.parse_args()

    print("=== CP-Gov offline ===")
    smoke_offline()
    if args.base.strip():
        print("=== CP-Gov live ===")
        smoke_live(args.base.strip(), args.user, args.password)
    else:
        print("[SKIP] live API (pass --base to enable)")
    print("=== CP-Gov smoke passed ===")


if __name__ == "__main__":
    main()
