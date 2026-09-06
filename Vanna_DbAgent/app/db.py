from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Any, Iterator

import pymysql
from pymysql.cursors import DictCursor

from app.settings import get_settings
from app.sql_guard import SECRET_FIELD_NAMES
from app.tenants import MysqlConf, Tenant

_AUDIT_COLS = {
    "modifier",
    "modifydate",
    "modifyid",
    "createid",
    "creator",
    "createdate",
}
_SAMPLE_COMMENT_HINTS = ("类型", "级别", "状态", "分类", "省市区", "地区")
_VARCHAR_W = re.compile(r"(?:var)?char\s*\(\s*(\d+)\s*\)", re.I)
_SAMPLE_ROW_CAP = 80
_SAMPLE_UNIQUE_CAP = 8
_SAMPLE_COL_CAP = 40


def _ident(name: str) -> str:
    return "`" + str(name or "").replace("`", "") + "`"


def should_sample_column(
    col: dict[str, Any],
    *,
    table: str = "",
    value_maps: dict[str, dict[str, str]] | None = None,
) -> bool:
    cname = str(col.get("name") or "")
    if not cname or cname.lower() in SECRET_FIELD_NAMES or cname.lower() in _AUDIT_COLS:
        return False
    key = f"{table}.{cname}" if table else cname
    if value_maps and key in value_maps:
        return True
    typ = str(col.get("type") or col.get("col_type") or "").strip().lower()
    cmt = str(col.get("comment") or "")
    width = 0
    m = _VARCHAR_W.search(typ)
    if m:
        width = int(m.group(1))
    type_ok = (
        "tinyint" in typ
        or "smallint" in typ
        or typ.startswith("enum")
        or (width > 0 and width <= 32)
    )
    comment_ok = any(h in cmt for h in _SAMPLE_COMMENT_HINTS)
    # 省市区/地区常为长 varchar，仍采样以便卡片展示复合串形态
    if comment_ok and any(h in cmt for h in ("省市区", "地区")):
        return True
    return type_ok and comment_ok


def sample_column_values(cur: Any, table: str, column: str) -> list[str]:
    try:
        cur.execute(
            f"SELECT {_ident(column)} AS v FROM {_ident(table)} "
            f"WHERE {_ident(column)} IS NOT NULL LIMIT %s",
            (_SAMPLE_ROW_CAP,),
        )
        rows = list(cur.fetchall() or [])
    except Exception:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        raw = row.get("v") if isinstance(row, dict) else None
        if raw is None:
            continue
        s = str(raw).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s[:40])
        if len(out) >= _SAMPLE_UNIQUE_CAP:
            break
    return out


@contextmanager
def mysql_conn(cfg: MysqlConf, read_timeout: int | None = None) -> Iterator[pymysql.Connection]:
    timeout = int(read_timeout if read_timeout is not None else get_settings().vanna_query_timeout_s)
    conn = pymysql.connect(
        host=cfg.host,
        port=int(cfg.port),
        user=cfg.user,
        password=cfg.password,
        database=cfg.database,
        charset="utf8mb4",
        cursorclass=DictCursor,
        connect_timeout=8,
        read_timeout=max(5, timeout),
        autocommit=True,
    )
    try:
        yield conn
    finally:
        conn.close()


def ping(cfg: MysqlConf) -> dict[str, Any]:
    with mysql_conn(cfg) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT DATABASE() AS db, NOW() AS now")
            row = cur.fetchone() or {}
    return {"db": row.get("db"), "now": str(row.get("now") or "")}


def list_allowed_tables(tenant: Tenant) -> list[dict[str, str]]:
    with mysql_conn(tenant.mysql) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_name AS name, COALESCE(table_comment, '') AS comment
                FROM information_schema.tables
                WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
                ORDER BY table_name
                """
            )
            rows = list(cur.fetchall() or [])
    return [
        {"name": str(r["name"]), "comment": str(r.get("comment") or "")}
        for r in rows
        if tenant.allow_table(str(r["name"]))
    ]


def snapshot_allowed_schema(tenant: Tenant) -> dict[str, Any]:
    with mysql_conn(tenant.mysql) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_name AS name, COALESCE(table_comment, '') AS comment
                FROM information_schema.tables
                WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
                ORDER BY table_name
                """
            )
            tables = list(cur.fetchall() or [])
            allowed: list[dict[str, Any]] = []
            skipped: list[str] = []
            sampled = 0
            for row in tables:
                name = str(row["name"])
                if not tenant.allow_table(name):
                    skipped.append(name)
                    continue
                cur.execute(
                    """
                    SELECT column_name AS name, column_type AS col_type,
                           COALESCE(column_comment, '') AS comment
                    FROM information_schema.columns
                    WHERE table_schema = DATABASE() AND table_name = %s
                    ORDER BY ordinal_position
                    """,
                    (name,),
                )
                cols = [
                    {
                        "name": str(c["name"]),
                        "type": str(c.get("col_type") or ""),
                        "comment": str(c.get("comment") or ""),
                    }
                    for c in (cur.fetchall() or [])
                    if str(c["name"]).lower() not in SECRET_FIELD_NAMES
                ]
                for col in cols:
                    if sampled >= _SAMPLE_COL_CAP:
                        break
                    if not should_sample_column(col, table=name, value_maps=tenant.value_maps):
                        continue
                    values = sample_column_values(cur, name, str(col["name"]))
                    if values:
                        col["samples"] = values
                        sampled += 1
                allowed.append(
                    {
                        "name": name,
                        "comment": str(row.get("comment") or ""),
                        "cols": cols,
                    }
                )
            cur.execute(
                """
                SELECT table_name AS from_table, column_name AS from_col,
                       referenced_table_name AS to_table, referenced_column_name AS to_col
                FROM information_schema.key_column_usage
                WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL
                """
            )
            fks = [
                {
                    "from_table": str(r["from_table"]),
                    "from_col": str(r["from_col"]),
                    "to_table": str(r["to_table"]),
                    "to_col": str(r["to_col"]),
                }
                for r in (cur.fetchall() or [])
                if tenant.allow_table(str(r["from_table"])) and tenant.allow_table(str(r["to_table"]))
            ]
    return {
        "database": tenant.mysql.database,
        "tables": allowed,
        "skipped": skipped,
        "fks": fks,
    }


def table_ddl(tenant: Tenant, table: str) -> str:
    if not tenant.allow_table(table):
        return ""
    with mysql_conn(tenant.mysql) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name AS name, column_type AS col_type,
                       COALESCE(column_comment, '') AS comment
                FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = %s
                ORDER BY ordinal_position
                """,
                (table,),
            )
            cols = list(cur.fetchall() or [])
            cur.execute(
                """
                SELECT COALESCE(table_comment, '') AS comment
                FROM information_schema.tables
                WHERE table_schema = DATABASE() AND table_name = %s
                LIMIT 1
                """,
                (table,),
            )
            trow = cur.fetchone() or {}
    comment = str(trow.get("comment") or "").strip()
    lines = [f"TABLE {table}" + (f" -- {comment}" if comment else "")]
    for c in cols:
        name = str(c["name"])
        if name.lower() in SECRET_FIELD_NAMES:
            continue
        cmt = str(c.get("comment") or "").strip()
        lines.append(f"  {name} {c['col_type']}" + (f" -- {cmt}" if cmt else ""))
    return "\n".join(lines)


def run_select(cfg: MysqlConf, sql: str, max_rows: int | None = None) -> list[dict[str, Any]]:
    limit = int(max_rows if max_rows is not None else get_settings().vanna_max_rows)
    with mysql_conn(cfg) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = list(cur.fetchall() or [])
    out: list[dict[str, Any]] = []
    for r in rows[: max(1, limit)]:
        item: dict[str, Any] = {}
        for k, v in r.items():
            if str(k).lower() in SECRET_FIELD_NAMES:
                continue
            item[str(k)] = v if v is None or isinstance(v, (int, float, bool, str)) else str(v)
        out.append(item)
    return out


def run_write(cfg: MysqlConf, sql: str) -> dict[str, Any]:
    """Execute a single guarded write statement in a transaction. Returns rowcount meta."""
    return run_writes(cfg, [sql])


def run_writes(cfg: MysqlConf, sqls: list[str]) -> dict[str, Any]:
    """Execute one or more guarded write statements in a single transaction (all-or-nothing)."""
    statements = [str(s or "").strip().rstrip(";") for s in sqls if str(s or "").strip()]
    if not statements:
        return {"ok": False, "rowcount": 0, "error": "empty_sql", "rowcounts": []}
    with mysql_conn(cfg) as conn:
        prev = bool(getattr(conn, "get_autocommit", lambda: True)())
        try:
            conn.autocommit(False)
            rowcounts: list[int] = []
            with conn.cursor() as cur:
                for sql in statements:
                    cur.execute(sql)
                    rowcounts.append(int(cur.rowcount or 0))
            conn.commit()
            return {
                "ok": True,
                "rowcount": sum(rowcounts),
                "rowcounts": rowcounts,
                "statement_count": len(statements),
                "error": "",
            }
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            return {
                "ok": False,
                "rowcount": 0,
                "rowcounts": [],
                "statement_count": len(statements),
                "error": str(exc),
            }
        finally:
            try:
                conn.autocommit(prev)
            except Exception:
                try:
                    conn.autocommit(True)
                except Exception:
                    pass


def apply_value_maps(rows: list[dict[str, Any]], tenant: Tenant, tables: list[str]) -> list[dict[str, Any]]:
    if not rows or not tenant.value_maps:
        return rows
    table_keys = [t.split(".")[-1] for t in tables]
    mapped: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        for col, val in list(item.items()):
            if val is None:
                continue
            keys = {str(val)}
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                try:
                    keys.add(str(int(val)))
                except (TypeError, ValueError):
                    pass
            for t in table_keys:
                spec = tenant.value_maps.get(f"{t}.{col}")
                if not spec:
                    continue
                hit = next((spec[k] for k in keys if k in spec), None)
                if hit is not None:
                    item[col] = hit
                    break
        mapped.append(item)
    return mapped
