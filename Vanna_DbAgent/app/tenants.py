from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from app.settings import ROOT


@dataclass
class MysqlConf:
    host: str
    port: int
    user: str
    password: str
    database: str


@dataclass
class Tenant:
    id: str
    title: str
    mysql: MysqlConf
    table_whitelist_prefixes: list[str] = field(default_factory=list)
    table_whitelist: list[str] = field(default_factory=list)
    skip_list_tables: list[str] = field(default_factory=list)
    docs_path: Path | None = None
    golden_path: Path | None = None
    value_maps: dict[str, dict[str, str]] = field(default_factory=dict)
    column_match: dict[str, str] = field(default_factory=dict)

    def allow_table(self, name: str) -> bool:
        n = str(name or "")
        if not n:
            return False
        if n in self.table_whitelist:
            return True
        lower_map = {x.lower(): x for x in self.table_whitelist}
        if n.lower() in lower_map:
            return True
        return any(n.startswith(p) or n.lower().startswith(p.lower()) for p in self.table_whitelist_prefixes)


def _expand(v: Any) -> Any:
    if isinstance(v, str) and v.startswith("${") and v.endswith("}"):
        return os.getenv(v[2:-1], "")
    return v


def load_tenants(dir_path: Path | None = None) -> dict[str, Tenant]:
    base = dir_path or (ROOT / "tenants")
    out: dict[str, Tenant] = {}
    if not base.is_dir():
        return out
    for yml in sorted(base.glob("*.yml")):
        if yml.name.startswith("_"):
            continue
        raw = yaml.safe_load(yml.read_text(encoding="utf-8")) or {}
        tid = str(raw.get("id") or yml.stem).strip()
        if not tid or tid.startswith("_"):
            continue
        mysql = raw.get("mysql") or {}
        password = str(_expand(mysql.get("password") or "") or "")
        if mysql.get("password_env"):
            password = os.getenv(str(mysql["password_env"]), password)
        tdir = base / tid
        docs = tdir / "docs.md"
        golden = tdir / "golden.json"
        vmaps_path = tdir / "value_maps.json"
        value_maps: dict[str, dict[str, str]] = {}
        if vmaps_path.is_file():
            raw_maps = json.loads(vmaps_path.read_text(encoding="utf-8")) or {}
            if isinstance(raw_maps, dict):
                value_maps = {
                    str(k): {str(vk): str(vv) for vk, vv in (v or {}).items()}
                    for k, v in raw_maps.items()
                    if isinstance(v, dict)
                }
        from app.sql_match_normalize import load_column_match

        cm_path = tdir / "column_match.json"
        column_match: dict[str, str] = {}
        if cm_path.is_file():
            try:
                column_match = load_column_match(json.loads(cm_path.read_text(encoding="utf-8")) or {})
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                column_match = {}
        port_raw = _expand(mysql.get("port") or 3306)
        try:
            port = int(port_raw or 3306)
        except (TypeError, ValueError):
            port = 3306
        out[tid] = Tenant(
            id=tid,
            title=str(raw.get("title") or tid),
            mysql=MysqlConf(
                host=str(_expand(mysql.get("host") or "127.0.0.1") or "127.0.0.1"),
                port=port,
                user=str(_expand(mysql.get("user") or "root") or "root"),
                password=str(password or ""),
                database=str(_expand(mysql.get("database") or "") or ""),
            ),
            table_whitelist_prefixes=list(raw.get("table_whitelist_prefixes") or []),
            table_whitelist=list(raw.get("table_whitelist") or []),
            skip_list_tables=[str(x) for x in (raw.get("skip_list_tables") or [])],
            docs_path=docs if docs.is_file() else None,
            golden_path=golden if golden.is_file() else None,
            value_maps=value_maps,
            column_match=column_match,
        )
    return out
