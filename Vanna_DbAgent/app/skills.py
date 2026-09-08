"""Scene / domain skill files. Loaded by scene id, not by regex on the user question."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.settings import ROOT
from app.tenants import Tenant
from app.understand import tenant_dir


def scene_skill_path(scene_id: str) -> Path:
    return ROOT / "skills" / f"{str(scene_id or '').strip()}.md"


def load_scene_skill(scene_id: str) -> str:
    path = scene_skill_path(scene_id)
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    # auto 缺文件时回退助手技能，避免空 prompt
    if str(scene_id or "").strip().lower() in {"auto", "smart", "default", ""}:
        fallback = scene_skill_path("assistant")
        if fallback.is_file():
            return fallback.read_text(encoding="utf-8").strip()
    return ""


def tenant_skills_dir(tenant: Tenant) -> Path | None:
    folder = tenant_dir(tenant)
    if not folder:
        return None
    path = folder / "skills"
    return path if path.is_dir() else None


def load_tenant_skills(tenant: Tenant) -> list[dict[str, str]]:
    folder = tenant_skills_dir(tenant)
    if not folder:
        return []
    out: list[dict[str, str]] = []
    for path in sorted(folder.glob("*.md")):
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            continue
        out.append({"id": path.stem, "title": path.stem, "text": text})
    return out


def skill_prompt_block(
    scene_id: str,
    tenant: Tenant,
    recalled: list[dict[str, Any]] | None = None,
    *,
    cap: int = 1800,
) -> str:
    parts: list[str] = []
    scene = load_scene_skill(scene_id)
    if scene:
        parts.append(f"场景技能 {scene_id}：\n{scene[:900]}")
    recalled_bits = [
        str(h.get("document") or "")
        for h in (recalled or [])
        if h.get("kind") == "skill" and h.get("document")
    ]
    if not recalled_bits:
        recalled_bits = [s["text"][:700] for s in load_tenant_skills(tenant)[:3]]
    if recalled_bits:
        parts.append("领域技能：\n" + "\n\n".join(recalled_bits[:3]))
    text = "\n\n".join(parts)
    return text[:cap] if len(text) > cap else text
