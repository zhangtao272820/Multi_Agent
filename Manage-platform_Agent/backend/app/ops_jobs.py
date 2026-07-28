"""运维 Job：部署状态 / recreate / 回滚 / PG 备份恢复（封装现有 scripts）。"""

from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import get_settings
from .env_file_io import parse_env_file
from .managed_agents import managed_agent_specs

settings = get_settings()


def _platform_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _workspace() -> Path:
    return Path(settings.workspace_root or ".").resolve()


def _scripts_dir() -> Path:
    return _platform_dir() / "scripts"


def _is_windows() -> bool:
    return sys.platform.startswith("win")


def _run_script(script_stem: str, args: list[str] | None = None, *, timeout: int = 600) -> dict[str, Any]:
    scripts = _scripts_dir()
    args = args or []
    if _is_windows():
        ps1 = scripts / f"{script_stem}.ps1"
        if not ps1.is_file():
            raise FileNotFoundError(f"缺少脚本: {ps1}")
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(ps1),
            *args,
        ]
    else:
        sh = scripts / f"{script_stem}.sh"
        if not sh.is_file():
            raise FileNotFoundError(f"缺少脚本: {sh}")
        cmd = ["bash", str(sh), *args]
    started = datetime.now(timezone.utc).isoformat()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(_platform_dir()),
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[-8000:],
            "stderr": (proc.stderr or "")[-4000:],
            "cmd": " ".join(cmd),
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "exit_code": -1,
            "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
            "stderr": f"timeout after {timeout}s",
            "cmd": " ".join(cmd),
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }


def get_deploy_status() -> dict[str, Any]:
    lan = _platform_dir() / ".env.agents-lan"
    env = parse_env_file(lan) if lan.is_file() else {}
    image_tag = (
        str(env.get("CLAWHIVE_IMAGE_TAG") or "").strip()
        or str(settings.clawhive_image_tag or "prod").strip()
        or "prod"
    )
    offline_dir = _platform_dir() / "offline"
    tar_path = offline_dir / "images.tar"
    sha_path = offline_dir / "SHA256SUMS"
    sha_preview = ""
    if sha_path.is_file():
        sha_preview = sha_path.read_text(encoding="utf-8", errors="replace")[:500]

    agents = []
    for spec in managed_agent_specs():
        agents.append(
            {
                "agent_name": spec.get("name") or spec.get("agent_name"),
                "docker_service": spec.get("docker_service"),
                "category": spec.get("category"),
            }
        )

    return {
        "ok": True,
        "image_tag": image_tag,
        "control_mode": settings.agent_control_mode,
        "compose_file": settings.compose_file_path,
        "offline": {
            "dir_exists": offline_dir.is_dir(),
            "images_tar_exists": tar_path.is_file(),
            "images_tar_size": tar_path.stat().st_size if tar_path.is_file() else 0,
            "sha256sums_exists": sha_path.is_file(),
            "sha256sums_preview": sha_preview,
        },
        "agents": agents,
        "scripts": {
            "rollback": "rollback-agents",
            "backup": "backup-postgres",
            "restore": "restore-postgres",
        },
    }


def run_rollback(image_tag: str) -> dict[str, Any]:
    tag = str(image_tag or "").strip()
    if not tag:
        raise ValueError("image_tag required")
    if _is_windows():
        return _run_script("rollback-agents", ["-Tag", tag], timeout=900)
    return _run_script("rollback-agents", [tag], timeout=900)


_ALLOWED_PLATFORM_SERVICES = frozenset(
    {
        "clawhive_backend",
        "clawhive_frontend",
        "clawhive_postgres",
        "clawhive_redis",
        "searxng",
        "prometheus",
        "grafana",
        "alertmanager",
        "tempo",
        "loki",
        "langfuse",
    }
)


def run_recreate(
    *,
    agent_names: list[str] | None = None,
    services: list[str] | None = None,
    build: bool = False,
) -> dict[str, Any]:
    """对指定 Agent 或 compose 服务 force-recreate。"""
    from .process_control import restart_agent_process
    from .runners import compose_runner as cr

    started = datetime.now(timezone.utc).isoformat()
    results: list[dict[str, Any]] = []
    errors: list[str] = []

    for name in agent_names or []:
        name = str(name or "").strip()
        if not name:
            continue
        try:
            out = restart_agent_process(name, build=build, force_recreate=True)
            results.append({"agent_name": name, "ok": True, "detail": out})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            results.append({"agent_name": name, "ok": False, "error": str(exc)})

    known_agent_svcs = {
        str(s.get("docker_service") or "").strip() for s in managed_agent_specs() if s.get("docker_service")
    }
    # 若只传了 agent_names，对应 docker_service 已由 restart_agent_process 处理；
    # services 用于平台服务或额外 compose 名。
    extra_services: list[str] = []
    for svc in services or []:
        svc = str(svc or "").strip()
        if not svc:
            continue
        if svc in _ALLOWED_PLATFORM_SERVICES or svc in known_agent_svcs:
            extra_services.append(svc)
        else:
            errors.append(f"拒绝未登记服务: {svc}")

    if extra_services:
        args = ["up", "-d"]
        if build:
            args.append("--build")
        args.append("--force-recreate")
        args.extend(extra_services)
        cmd = cr._compose_cmd(*args)
        out = cr._run_cmd(cmd, cwd=settings.workspace_root)
        ok = out.returncode == 0
        detail = (out.stderr or out.stdout or "").strip()[:2000]
        results.append({"services": extra_services, "ok": ok, "detail": detail})
        if not ok:
            errors.append(detail or "compose recreate failed")

    if not (agent_names or extra_services):
        raise ValueError("请指定 agent_names 或 services")

    return {
        "ok": not errors,
        "results": results,
        "errors": errors,
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }



def list_backups() -> dict[str, Any]:
    backup_dir = _platform_dir() / "backups"
    items: list[dict[str, Any]] = []
    if backup_dir.is_dir():
        for p in sorted(backup_dir.glob("clawhive-pg-*"), key=lambda x: x.stat().st_mtime, reverse=True):
            if not p.is_file():
                continue
            items.append(
                {
                    "name": p.name,
                    "path": str(p.relative_to(_platform_dir())),
                    "size": p.stat().st_size,
                    "mtime": datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(),
                }
            )
    return {"ok": True, "backup_dir": "Manage-platform_Agent/backups", "items": items[:50]}


def run_backup() -> dict[str, Any]:
    return _run_script("backup-postgres", timeout=600)


def run_restore(filename: str, *, confirm: bool = False) -> dict[str, Any]:
    if not confirm:
        raise ValueError("restore 需要 confirm=true")
    name = Path(str(filename or "").strip()).name
    if not name or ".." in name or not name.startswith("clawhive-pg-"):
        raise ValueError("非法备份文件名")
    path = _platform_dir() / "backups" / name
    if not path.is_file():
        raise FileNotFoundError(f"备份不存在: {name}")
    if _is_windows():
        return _run_script("restore-postgres", ["-Backup", str(path), "-Yes"], timeout=900)
    return _run_script("restore-postgres", [str(path), "--yes"], timeout=900)
