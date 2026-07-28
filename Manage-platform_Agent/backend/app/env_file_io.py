"""共享 .env 读写（不碰密钥语义，调用方负责白名单）。"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SECRET_KEY_RE = re.compile(
    r"(API_KEY|PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)$",
    re.IGNORECASE,
)


def is_secret_env_key(key: str) -> bool:
    k = str(key or "").strip()
    if not k:
        return False
    if SECRET_KEY_RE.search(k):
        return True
    upper = k.upper()
    return any(
        x in upper
        for x in (
            "API_KEY",
            "_PASSWORD",
            "_SECRET",
            "_TOKEN",
            "PRIVATE_KEY",
            "ACCESS_KEY",
        )
    )


def parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key:
            out[key] = val
    return out


def upsert_env_keys(
    path: Path,
    updates: dict[str, str],
    *,
    header_label: str = "clawhive",
) -> dict[str, Any]:
    """写入/更新键；返回 changed 映射 old→new。"""
    pending = {str(k).strip(): str(v) for k, v in updates.items() if str(k).strip()}
    lines: list[str] = []
    changed: dict[str, tuple[str, str]] = {}

    if path.is_file():
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                lines.append(raw)
                continue
            key_part = stripped.split("=", 1)[0].strip().lstrip("export ").strip()
            if key_part in pending:
                old_val = stripped.split("=", 1)[1].strip().strip('"').strip("'")
                new_val = pending.pop(key_part)
                if old_val != new_val:
                    changed[key_part] = (old_val, new_val)
                lines.append(f"{key_part}={new_val}")
            else:
                lines.append(raw)
    else:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines.append(f"# synced from ClawHive ({header_label}) — {ts}")

    for key, val in pending.items():
        changed[key] = ("", val)
        lines.append(f"{key}={val}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {
        "path": str(path),
        "changed_keys": list(changed.keys()),
        "changed": {k: {"old": o, "new": n} for k, (o, n) in changed.items()},
    }


def norm_env_val(v: str) -> str:
    return re.sub(r"\s+", "", str(v or "").strip().lower())
