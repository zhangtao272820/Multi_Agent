"""技能赋能：将平台安装记录同步到 Agent 工作区并触发 reload。"""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlalchemy.orm import Session

from .agent_env_registry import AGENT_ENV_SPECS
from .config import get_settings
from .db_models import AgentRecord, SkillArtifactRecord, SkillInstallRecord, SkillRecord
from .managed_agents import managed_agent_specs
from .skill_registry import normalize_env_skill_key, parse_playbook_frontmatter

settings = get_settings()


def _record_sync_metric(sync_status: str) -> None:
    try:
        from .metrics import skill_sync_total

        skill_sync_total.labels(sync_status=sync_status or "unknown").inc()
    except Exception:
        return

AGENT_SKILL_SPECS: dict[str, dict[str, str]] = {
    "Manager_Agent": {
        "skills_dir": "Manager_Agent/skills",
        "reload_path": "/api/internal/skills/reload",
    },
    "DB_Agent": {
        "skills_dir": "DB_Agent/skills",
        "reload_path": "/api/internal/skills/reload",
    },
    "RAG_Agent": {
        "skills_dir": "RAG_Agent/skills",
        "reload_path": "/api/internal/skills/reload",
    },
    "code_assistent_Agent": {
        "skills_dir": "CodePy_Agent/skills",
        "reload_path": "/api/health",
    },
    "CodePy_Agent": {
        "skills_dir": "CodePy_Agent/skills",
        "reload_path": "/api/health",
    },
    "Extractor_Agent": {
        "skills_dir": "Extractor_Agent/skills",
        "reload_path": "/api/internal/skills/reload",
    },
    "AI_admin_Agent": {
        "skills_dir": "AI_admin_Agent/skills",
        "reload_path": "/api/internal/skills/reload",
    },
}


def agent_skill_specs() -> dict[str, dict[str, str]]:
    """合并托管 Agent 列表，平台侧默认可写入 <Agent>/skills/（不依赖子 Agent reload API）。"""
    merged = dict(AGENT_SKILL_SPECS)
    ws = _workspace()
    for spec in managed_agent_specs():
        name = str(spec.get("name") or "").strip()
        if not name or name in merged:
            continue
        cwd = Path(str(spec.get("cwd") or ""))
        try:
            rel = cwd.resolve().relative_to(ws)
            skills_dir = (rel / "skills").as_posix()
        except (ValueError, OSError):
            skills_dir = f"{name}/skills"
        merged[name] = {
            "skills_dir": skills_dir,
            "reload_path": "/api/internal/skills/reload",
        }
    return merged


def _workspace() -> Path:
    return Path(settings.workspace_root or ".").resolve()


def _runtime_root() -> Path:
    root = Path(settings.runtime_root or ".local/runtime")
    if not root.is_absolute():
        root = Path(__file__).resolve().parent.parent / root
    return root


def agent_name_by_id(db: Session, agent_id: str) -> str:
    row = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if row and row.name:
        return row.name
    for spec in managed_agent_specs():
        if spec.get("name"):
            continue
    return ""


def resolve_agent_endpoint(db: Session, agent_id: str) -> tuple[str, str]:
    row = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if row:
        return row.name or "", row.endpoint or ""
    for spec in managed_agent_specs():
        if spec.get("name"):
            pass
    return "", ""


def _agent_endpoint_for_name(agent_name: str, db: Session | None = None) -> str:
    if db is not None:
        row = db.query(AgentRecord).filter(AgentRecord.name == agent_name).first()
        if row and row.endpoint:
            return row.endpoint
    for spec in managed_agent_specs():
        if spec.get("name") == agent_name:
            return spec.get("endpoint") or ""
    return ""


def _artifact_base_path(artifact: SkillArtifactRecord) -> Path:
    storage = Path(artifact.storage_path)
    if storage.is_file() and storage.name.lower() in ("skill.md", "skill.yaml", "skill.yml"):
        return storage.parent
    if storage.is_dir():
        return storage
    if storage.suffix.lower() == ".zip":
        return storage.parent
    return storage.parent if storage.parent.exists() else storage


def _detect_kind(artifact: SkillArtifactRecord, skill_id: str) -> str:
    base = _artifact_base_path(artifact)
    if (base / "skill.md").is_file():
        return "playbook"
    manifest = (artifact.manifest_text or "").lower()
    if "kind: playbook" in manifest or "stage:" in manifest and "entry:" not in manifest:
        return "playbook"
    return "executable"


def _copy_tree(src: Path, dst: Path) -> None:
    if src.resolve() == dst.resolve():
        return
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def _write_agent_env_skill_index(agent_name: str, skill_id: str, version: str) -> Path | None:
    if agent_name not in agent_skill_specs():
        return None
    env_rel = str(AGENT_ENV_SPECS.get(agent_name, {}).get("env_file") or "").strip()
    if not env_rel:
        return None
    env_path = _workspace() / env_rel
    if not env_path.is_file():
        return None
    key = normalize_env_skill_key(skill_id)
    lines = env_path.read_text(encoding="utf-8", errors="replace").splitlines()
    version_key = f"CLAWHIVE_SKILL_{key}_VERSION"
    invoke_key = f"CLAWHIVE_SKILL_{key}_INVOKE"
    found_v = found_i = False
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(f"{version_key}="):
            out.append(f"{version_key}={version}")
            found_v = True
            continue
        if stripped.startswith(f"{invoke_key}="):
            out.append(f"{invoke_key}=platform")
            found_i = True
            continue
        out.append(line)
    if not found_v:
        out.append(f"{version_key}={version}")
    if not found_i:
        out.append(f"{invoke_key}=platform")
    env_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return env_path


def _request_agent_reload(agent_name: str, endpoint: str) -> tuple[bool, str]:
    spec = agent_skill_specs().get(agent_name)
    if not spec:
        return True, "agent 未配置 reload，跳过"
    if not endpoint:
        return False, "agent endpoint 为空"
    token = str(getattr(settings, "clawhive_internal_token", "") or "").strip()
    if not token:
        return False, "CLAWHIVE_INTERNAL_TOKEN 未配置"
    url = endpoint.rstrip("/") + spec["reload_path"]
    timeout = max(3, int(getattr(settings, "skill_sync_reload_timeout_sec", 10) or 10))
    try:
        req = Request(
            url,
            data=b"{}",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-clawhive-internal-token": token,
            },
        )
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status >= 400:
                return False, f"reload HTTP {resp.status}: {body[:200]}"
            return True, "reload ok"
    except HTTPError as exc:
        return False, f"reload HTTP {exc.code}: {exc.read()[:200]!r}"
    except URLError as exc:
        return False, f"reload 连接失败: {exc.reason}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def sync_skill_to_agent(
    db: Session,
    *,
    skill_id: str,
    version: str,
    agent_id: str,
    kind: str = "",
) -> dict[str, Any]:
    agent = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if not agent:
        raise ValueError("目标 Agent 不存在")

    agent_name = agent.name or ""
    spec = agent_skill_specs().get(agent_name)
    if not spec:
        _record_sync_metric("unsupported_agent")
        return {
            "ok": False,
            "sync_status": "failed",
            "sync_path": "",
            "sync_error": f"Agent {agent_name} 尚未支持技能同步",
        }

    skill = (
        db.query(SkillRecord)
        .filter(SkillRecord.skill_id == skill_id, SkillRecord.version == version)
        .first()
    )
    artifact = (
        db.query(SkillArtifactRecord)
        .filter(SkillArtifactRecord.skill_id == skill_id, SkillArtifactRecord.version == version)
        .order_by(SkillArtifactRecord.created_at.desc())
        .first()
    )
    if not artifact:
        _record_sync_metric("no_artifact")
        return {
            "ok": False,
            "sync_status": "failed",
            "sync_path": "",
            "sync_error": "技能 artifact 不存在",
        }

    resolved_kind = (kind or _detect_kind(artifact, skill_id)).strip().lower()
    src_base = _artifact_base_path(artifact)
    sync_path = ""
    sync_error = ""

    try:
        if resolved_kind == "playbook":
            dst = (_workspace() / spec["skills_dir"] / skill_id).resolve()
            _copy_tree(src_base, dst)
            sync_path = str(dst)
        else:
            runtime_dst = _runtime_root() / "skills" / skill_id / version
            runtime_dst.mkdir(parents=True, exist_ok=True)
            if src_base.resolve() != runtime_dst.resolve():
                marker = runtime_dst / ".synced.ok"
                if marker.exists():
                    marker.unlink()
                _copy_tree(src_base, runtime_dst)
            env_written = _write_agent_env_skill_index(agent_name, skill_id, version)
            sync_path = str(runtime_dst if runtime_dst.exists() else src_base)
            if env_written:
                sync_path = f"{sync_path};env={env_written}"

        reload_msg = "reload skipped (platform mode)"
        if getattr(settings, "skill_sync_agent_reload", False):
            reload_ok, reload_msg = _request_agent_reload(agent_name, agent.endpoint or "")
            if not reload_ok:
                # 平台模式：文件已落盘即视为 synced，reload 失败仅记入 sync_error 供后续重试
                sync_error = reload_msg
        else:
            reload_ok = True

        install = (
            db.query(SkillInstallRecord)
            .filter(
                SkillInstallRecord.skill_id == skill_id,
                SkillInstallRecord.version == version,
                SkillInstallRecord.agent_id == agent_id,
                SkillInstallRecord.status == "installed",
            )
            .order_by(SkillInstallRecord.created_at.desc())
            .first()
        )
        if install:
            install.kind = resolved_kind
            if sync_error and getattr(settings, "skill_sync_agent_reload", False):
                install.sync_status = "synced_pending_reload"
                install.sync_error = sync_error
                install.last_synced_at = datetime.utcnow()
            elif sync_error:
                install.sync_status = "synced"
                install.sync_error = sync_error
                install.last_synced_at = datetime.utcnow()
            else:
                install.sync_status = "synced"
                install.sync_error = ""
                install.last_synced_at = datetime.utcnow()
            install.sync_path = sync_path
            db.add(install)
            db.commit()

        final_status = "synced"
        if sync_error and getattr(settings, "skill_sync_agent_reload", False):
            final_status = "synced_pending_reload"
        _record_sync_metric(final_status)
        return {
            "ok": True,
            "sync_status": final_status,
            "sync_path": sync_path,
            "sync_error": sync_error,
            "kind": resolved_kind,
            "reload": reload_msg,
            "skill_name": skill.name if skill else skill_id,
            "agent_name": agent_name,
        }
    except Exception as exc:  # noqa: BLE001
        install = (
            db.query(SkillInstallRecord)
            .filter(
                SkillInstallRecord.skill_id == skill_id,
                SkillInstallRecord.version == version,
                SkillInstallRecord.agent_id == agent_id,
                SkillInstallRecord.status == "installed",
            )
            .order_by(SkillInstallRecord.created_at.desc())
            .first()
        )
        if install:
            install.sync_status = "failed"
            install.sync_error = str(exc)
            install.sync_path = sync_path
            install.kind = resolved_kind or install.kind
            db.add(install)
            db.commit()
        _record_sync_metric("failed")
        return {
            "ok": False,
            "sync_status": "failed",
            "sync_path": sync_path,
            "sync_error": str(exc),
            "kind": resolved_kind,
        }


def remove_synced_skill_from_agent(
    db: Session,
    *,
    skill_id: str,
    agent_id: str,
    kind: str = "",
) -> dict[str, Any]:
    agent = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if not agent:
        return {"ok": False, "message": "agent not found"}
    spec = agent_skill_specs().get(agent.name or "")
    if not spec:
        return {"ok": True, "message": "skip remove"}
    target = _workspace() / spec["skills_dir"] / skill_id
    if kind == "playbook" or (target / "skill.md").exists():
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
    _request_agent_reload(agent.name or "", agent.endpoint or "")
    return {"ok": True, "removed": str(target)}


def list_effective_agent_skills(db: Session, agent_id: str) -> list[dict[str, Any]]:
    agent = db.query(AgentRecord).filter(AgentRecord.agent_id == agent_id).first()
    if not agent:
        return []
    spec = agent_skill_specs().get(agent.name or "")
    rows = (
        db.query(SkillInstallRecord)
        .filter(SkillInstallRecord.agent_id == agent_id, SkillInstallRecord.status == "installed")
        .order_by(SkillInstallRecord.created_at.desc())
        .all()
    )
    out = []
    for row in rows:
        on_disk = False
        if spec:
            p = _workspace() / spec["skills_dir"] / row.skill_id / "skill.md"
            on_disk = p.is_file()
        out.append(
            {
                "skill_id": row.skill_id,
                "version": row.version,
                "kind": row.kind or "",
                "sync_status": row.sync_status or "pending",
                "sync_path": row.sync_path or "",
                "sync_error": row.sync_error or "",
                "on_disk": on_disk,
                "installed_by": row.installed_by,
                "created_at": row.created_at.isoformat(),
                "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else "",
            }
        )
    return out
