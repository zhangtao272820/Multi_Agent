#!/usr/bin/env python3
"""扫描全集群 Playbook / skills-starter，生成「内部免费市场」Registry index。

用法（在 Manage-platform_Agent 目录）：
  python scripts/sync-internal-market.py
  python scripts/sync-internal-market.py --zip    # 同时打 zip 包（可离线分发）
  python scripts/sync-internal-market.py --dry-run

产出：
  skills-catalog/internal-market/index.json
  skills-catalog/internal-market/packages/<skill_id>/<version>/package.zip  （--zip）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore

SCRIPT_DIR = Path(__file__).resolve().parent
PLATFORM_DIR = SCRIPT_DIR.parent
REPO_ROOT = PLATFORM_DIR.parent
MARKET_DIR = PLATFORM_DIR / "skills-catalog" / "internal-market"
PACKAGES_DIR = MARKET_DIR / "packages"
INDEX_FILE = MARKET_DIR / "index.json"

SCAN_PLAYBOOK_ROOTS = [
    "Manager_Agent/skills",
    "DB_Agent/skills",
    "RAG_Agent/skills",
    "code_assistent_Agent/skills",
    "CodePy_Agent/skills",
    "Extractor_Agent/skills",
    "ExtractorPy_Agent/skills",
    "Music_Agent/skills",
    "Video_Agent/skills",
    "Multimodal_Agent/skills",
    "AI_Agent/skills",
    "Lobster_Agent/skills",
    "Tavern_Agent/skills",
]

# Agent 目录 → 兼容 Agent 名（ClawHive 注册名）
PATH_AGENT_MAP = {
    "Manager_Agent": "Manager_Agent",
    "DB_Agent": "DB_Agent",
    "RAG_Agent": "RAG_Agent",
    "code_assistent_Agent": "code_assistent_Agent",
    "CodePy_Agent": "code_assistent_Agent",
    "Extractor_Agent": "Extractor_Agent",
    "ExtractorPy_Agent": "Extractor_Agent",
    "Music_Agent": "Music_Agent",
    "Video_Agent": "Video_Agent",
    "Multimodal_Agent": "Multimodal_Agent",
    "AI_Agent": "AI_Agent",
    "Lobster_Agent": "Lobster_Agent",
    "Tavern_Agent": "Tavern_Agent",
}

OWNER_AGENT_MAP = {
    "manager_agent": "Manager_Agent",
    "db_agent": "DB_Agent",
    "rag_agent": "RAG_Agent",
    "code_agent": "code_assistent_Agent",
    "extractor_agent": "Extractor_Agent",
}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_frontmatter(text: str) -> dict:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None or yaml is None:
        return {}
    meta = yaml.safe_load("\n".join(lines[1:end])) or {}
    return meta if isinstance(meta, dict) else {}


def _agent_from_path(skill_dir: Path) -> str:
    rel = skill_dir.relative_to(REPO_ROOT)
    top = rel.parts[0] if rel.parts else ""
    return PATH_AGENT_MAP.get(top, top or "*")


def _scan_playbooks() -> list[dict]:
    entries: list[dict] = []
    seen: set[str] = set()
    for rel_root in SCAN_PLAYBOOK_ROOTS:
        root = REPO_ROOT / rel_root.replace("/", "\\") if "\\" in str(REPO_ROOT) else REPO_ROOT / rel_root
        if not root.is_dir():
            continue
        for skill_md in root.glob("*/skill.md"):
            skill_dir = skill_md.parent
            skill_id = skill_dir.name
            key = f"{rel_root.split('/')[0]}:{skill_id}"
            if key in seen:
                continue
            seen.add(key)

            text = skill_md.read_text(encoding="utf-8")
            meta = _parse_frontmatter(text)
            version = str(meta.get("version") or "1.0.0").strip()
            name = str(meta.get("name") or skill_id).strip()
            description = str(meta.get("description") or "").strip()
            owner = str(meta.get("owner") or "").strip().lower()
            stage = str(meta.get("stage") or "playbook").strip()
            agent = OWNER_AGENT_MAP.get(owner) or _agent_from_path(skill_dir)

            try:
                ws_path = skill_dir.relative_to(REPO_ROOT).as_posix()
            except ValueError:
                ws_path = str(skill_dir)

            tags = ["playbook", "internal", stage]
            if agent != "*":
                tags.append(agent.replace("_Agent", "").lower())

            entries.append(
                {
                    "skill_id": skill_id,
                    "name": name,
                    "kind": "playbook",
                    "latest": version,
                    "versions": [version],
                    "tags": tags,
                    "compatible_agents": [agent] if agent != "*" else ["*"],
                    "description": description or f"{agent} Playbook · {skill_id}",
                    "workspace_path": ws_path,
                    "publisher": "internal",
                    "status": "published",
                    "license": "free",
                }
            )
    return entries


def _scan_starters() -> list[dict]:
    entries: list[dict] = []
    starter = PLATFORM_DIR / "skills-starter"
    if not starter.is_dir():
        return entries
    for manifest in list(starter.rglob("skill.yaml")) + list(starter.rglob("skill.yml")):
        if yaml is None:
            break
        raw = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            continue
        meta = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
        skill_id = str(meta.get("id") or manifest.parent.name).strip()
        entries.append(
            {
                "skill_id": skill_id,
                "name": str(meta.get("name") or skill_id),
                "kind": "executable",
                "latest": str(meta.get("version") or "1.0.0"),
                "versions": [str(meta.get("version") or "1.0.0")],
                "tags": ["executable", "internal", "starter"],
                "compatible_agents": ["*"],
                "description": str(meta.get("description") or ""),
                "workspace_path": manifest.parent.relative_to(REPO_ROOT).as_posix(),
                "publisher": "platform",
                "status": "published",
                "license": "free",
            }
        )
    return entries


def _zip_playbook(entry: dict, src_dir: Path) -> tuple[str, str]:
    skill_id = entry["skill_id"]
    version = entry["latest"]
    out_dir = PACKAGES_DIR / skill_id / version
    out_dir.mkdir(parents=True, exist_ok=True)
    out_zip = out_dir / "package.zip"
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in src_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(src_dir).as_posix())
    rel = out_zip.relative_to(PLATFORM_DIR).as_posix()
    return rel.replace("\\", "/"), _sha256_file(out_zip)


def _zip_executable(entry: dict, src_dir: Path) -> tuple[str, str]:
    return _zip_playbook(entry, src_dir)


def build_index(*, with_zip: bool = False) -> dict:
    entries = _scan_playbooks() + _scan_starters()
    entries.sort(key=lambda x: (x.get("kind", ""), x.get("skill_id", "")))

    if with_zip:
        PACKAGES_DIR.mkdir(parents=True, exist_ok=True)
        for entry in entries:
            ws = REPO_ROOT / str(entry["workspace_path"])
            if not ws.is_dir():
                continue
            pkg_url, digest = (
                _zip_executable(entry, ws) if entry["kind"] == "executable" else _zip_playbook(entry, ws)
            )
            entry["package_url"] = pkg_url
            entry["sha256"] = digest

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "apiVersion": "clawhive/registry/v1",
        "registry_id": "internal_market",
        "name": "内部免费技能市场（全集群 Playbook + Starter）",
        "description": "扫描 e:\\Agent 各 Agent/skills 与 skills-starter，供 ClawHive 控制台一键赋能。",
        "license": "free",
        "updated_at": now,
        "skills": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="同步内部免费技能市场 index.json")
    parser.add_argument("--zip", action="store_true", help="为每个技能生成 package.zip")
    parser.add_argument("--dry-run", action="store_true", help="只打印统计，不写文件")
    args = parser.parse_args()

    index = build_index(with_zip=args.zip)
    count = len(index.get("skills") or [])
    playbook = len([s for s in index["skills"] if s.get("kind") == "playbook"])
    executable = count - playbook
    print(f"skills={count} (playbook={playbook}, executable={executable})")

    if args.dry_run:
        for s in index["skills"]:
            print(f"  - {s['skill_id']}@{s['latest']} [{s['kind']}] -> {s.get('compatible_agents')}")
        return

    MARKET_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {INDEX_FILE}")


if __name__ == "__main__":
    main()
