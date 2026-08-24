"""租户领域补丁：blueprint 短文注入 Understand（学 DB_Agent domain patch，无多跳 NLU）。"""
from __future__ import annotations

from pathlib import Path

from app.tenants import Tenant
from app.understand import tenant_dir


def load_blueprint_text(tenant: Tenant, *, max_chars: int = 1200) -> str:
    folder = tenant_dir(tenant)
    if not folder:
        return ""
    path = folder / "blueprint.md"
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1] + "…"


def blueprint_prompt_block(tenant: Tenant, *, max_chars: int = 1200) -> str:
    text = load_blueprint_text(tenant, max_chars=max_chars)
    if not text:
        return ""
    return f"领域蓝图（选表与 JOIN 消歧，必须遵守）：\n{text}\n\n"
