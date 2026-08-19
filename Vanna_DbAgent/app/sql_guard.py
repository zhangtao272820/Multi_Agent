from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.scenes import Scene
from app.tenants import Tenant

_WRITE = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|load)\b",
    re.I,
)
_FILE_IO = re.compile(r"\binto\s+(outfile|dumpfile)\b|\bload_file\s*\(", re.I)
_TIME_BOMB = re.compile(r"\b(sleep|benchmark)\s*\(", re.I)
_SYS_SCHEMA = re.compile(r"\b(information_schema|performance_schema)\b|\bmysql\s*\.", re.I)
_SECRET_COL = re.compile(r"\b(userpwd|password|passwd|pwd|id_card|idcard|identity_card)\b", re.I)
_STRICT_SECRET = re.compile(
    r"\b(userpwd|password|passwd|pwd|id_card|idcard|identity_card|id_no|idno|"
    r"bank_card|bankcard|credit_card|creditcard|card_no|cardno)\b",
    re.I,
)
_FROM_JOIN = re.compile(
    r"\b(?:from|join)\s+((?:`?[A-Za-z_][\w]*`?\s*\.\s*)?`?[A-Za-z_][\w]*`?)",
    re.I,
)
_IDENT = re.compile(r"`?([A-Za-z_][\w]*)`?")

SECRET_FIELD_NAMES = {
    "userpwd",
    "password",
    "passwd",
    "pwd",
    "id_card",
    "idcard",
    "identity_card",
    "id_no",
    "idno",
}

GUARD_REASONS = {
    "empty": "SQL 为空",
    "multi_statement": "禁止多语句",
    "not_select": "仅允许 SELECT / WITH",
    "write_keyword": "禁止写操作",
    "file_io": "禁止文件读写",
    "time_bomb": "禁止 SLEEP / BENCHMARK",
    "system_schema": "当前场景不允许查询系统库",
    "secret_column": "禁止查询密码或证件等敏感列",
    "table_not_allowed": "表不在租户白名单",
    "parse_error": "SQL 无法解析",
    "ok": "通过",
}


@dataclass
class GuardResult:
    ok: bool
    reason: str
    sql: str
    tables: list[str] = field(default_factory=list)


def strip_sql_fence(raw: str) -> str:
    s = str(raw or "").strip()
    s = re.sub(r"^```(?:sql)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```$", "", s)
    return s.strip()


def extract_tables(sql: str) -> list[str]:
    ast_tables = _ast_tables(sql)
    if ast_tables is not None:
        return ast_tables
    found: list[str] = []
    for m in _FROM_JOIN.finditer(sql or ""):
        token = re.sub(r"\s+", "", m.group(1) or "")
        parts = [p for p in token.split(".") if p]
        names = [_IDENT.match(p).group(1) if _IDENT.match(p) else p.strip("`") for p in parts]
        if len(names) == 2:
            found.append(f"{names[0]}.{names[1]}")
        elif names:
            found.append(names[-1])
    out: list[str] = []
    seen: set[str] = set()
    for t in found:
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def is_read_only_select_sql(sql: str) -> tuple[bool, str, str]:
    raw = str(sql or "").strip()
    if not raw:
        return False, "empty", ""
    normalized = re.sub(r"/\*[\s\S]*?\*/", " ", raw)
    normalized = re.sub(r"--[^\n]*", " ", normalized)
    normalized = re.sub(r"#[^\n]*", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    s = re.sub(r";+\s*$", "", normalized).strip()
    if not s:
        return False, "empty", ""
    if ";" in s:
        return False, "multi_statement", s
    if not re.match(r"^(select|with)\b", s, re.I):
        return False, "not_select", s
    if _WRITE.search(s):
        return False, "write_keyword", s
    if _FILE_IO.search(s):
        return False, "file_io", s
    if _TIME_BOMB.search(s):
        return False, "time_bomb", s
    return True, "ok", s


def _ast_tables(sql: str) -> list[str] | None:
    try:
        import sqlglot
        from sqlglot import exp
    except Exception:
        return None
    try:
        trees = sqlglot.parse(sql, read="mysql")
    except Exception:
        return None
    if not trees:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for tree in trees:
        if tree is None:
            continue
        for table in tree.find_all(exp.Table):
            name = str(table.name or "").strip()
            db = str(table.db or table.catalog or "").strip()
            token = f"{db}.{name}" if db and name else name
            if not token:
                continue
            key = token.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(token)
    return out


def _ast_gate(sql: str) -> tuple[bool, str] | None:
    """Return None if sqlglot unavailable or parse failed (regex already passed)."""
    try:
        import sqlglot
        from sqlglot import exp
    except Exception:
        return None
    try:
        trees = sqlglot.parse(sql, read="mysql")
    except Exception:
        return None
    live = [t for t in (trees or []) if t is not None]
    if not live:
        return False, "empty"
    if len(live) > 1:
        return False, "multi_statement"
    tree = live[0]
    kind = type(tree).__name__
    if kind not in {"Select", "Union", "With"}:
        return False, "not_select"
    blob = sql.lower()
    if "for update" in blob:
        return False, "write_keyword"
    try:
        for fn in tree.find_all(exp.Anonymous, exp.Func):
            fname = str(getattr(fn, "this", None) or getattr(fn, "name", None) or "").lower()
            if fname in {"sleep", "benchmark"}:
                return False, "time_bomb"
            if fname == "load_file":
                return False, "file_io"
    except Exception:
        pass
    if "into outfile" in blob or "into dumpfile" in blob:
        return False, "file_io"
    return True, "ok"


def enforce_select_limit(sql: str, max_limit: int = 50, default_limit: int = 50) -> str:
    s = re.sub(r";+\s*$", "", str(sql or "").strip())
    if not s:
        return s
    if re.search(r"\blimit\b", s, re.I):

        def _cap(m: re.Match[str]) -> str:
            n1 = int(m.group(1))
            if m.group(3):
                n2 = max(1, min(max_limit, int(m.group(3))))
                return f"LIMIT {max(0, n1)}, {n2}"
            return f"LIMIT {max(1, min(max_limit, n1))}"

        return re.sub(r"\blimit\s+(\d+)(\s*,\s*(\d+))?", _cap, s, flags=re.I, count=1)
    if re.search(r"\bcount\s*\(\s*\*\s*\)", s, re.I) and not re.search(r"\bgroup\s+by\b", s, re.I):
        return s
    return f"{s} LIMIT {default_limit}"


def _secret_hit(sql: str, scene: Scene) -> bool:
    pat = _STRICT_SECRET if scene.strict_secrets else _SECRET_COL
    return bool(pat.search(sql))


def _sys_schema_ok(sql: str, scene: Scene) -> bool:
    if not _SYS_SCHEMA.search(sql):
        return True
    return bool(scene.allow_sys_schema)


def _table_allowed(name: str, tenant: Tenant, scene: Scene) -> bool:
    n = str(name or "")
    if "." in n:
        schema, table = n.split(".", 1)
        schema_l = schema.lower()
        if schema_l in {"information_schema", "performance_schema"}:
            return bool(scene.allow_sys_schema)
        if schema_l == "mysql":
            return False
        return tenant.allow_table(table)
    if n.lower() in {"information_schema", "performance_schema"}:
        return bool(scene.allow_sys_schema)
    if scene.allow_sys_schema and n.lower() in {
        "tables",
        "columns",
        "statistics",
        "processlist",
        "innodb_trx",
        "innodb_locks",
        "innodb_lock_waits",
        "schemata",
        "key_column_usage",
        "table_constraints",
        "routines",
        "triggers",
        "views",
    }:
        return True
    return tenant.allow_table(n)


def guard_sql(
    sql: str,
    *,
    tenant: Tenant,
    scene: Scene,
    max_limit: int = 50,
    default_limit: int = 50,
) -> GuardResult:
    ok, reason, cleaned = is_read_only_select_sql(strip_sql_fence(sql))
    if not ok:
        return GuardResult(ok=False, reason=reason, sql=cleaned, tables=extract_tables(cleaned))
    ast = _ast_gate(cleaned)
    if ast is not None and not ast[0]:
        return GuardResult(ok=False, reason=ast[1], sql=cleaned, tables=extract_tables(cleaned))
    if not _sys_schema_ok(cleaned, scene):
        return GuardResult(
            ok=False,
            reason="system_schema",
            sql=cleaned,
            tables=extract_tables(cleaned),
        )
    if _secret_hit(cleaned, scene):
        return GuardResult(
            ok=False,
            reason="secret_column",
            sql=cleaned,
            tables=extract_tables(cleaned),
        )
    tables = extract_tables(cleaned)
    for t in tables:
        if not _table_allowed(t, tenant, scene):
            return GuardResult(ok=False, reason="table_not_allowed", sql=cleaned, tables=tables)
    limited = enforce_select_limit(cleaned, max_limit=max_limit, default_limit=default_limit)
    return GuardResult(ok=True, reason="ok", sql=limited, tables=tables)
