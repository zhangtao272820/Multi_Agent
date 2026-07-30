"""托管 Agent 规格 SSOT（控制台启停 / desired·actual / Helm deployment 名）。

新专家接入须与 Manager executor、metrics/Prom **同 wave** 交付，见：
docs/Agent集群升级与面试对照.md §1.6b · Manage-platform_Agent/doc/企业级控制面升级方案.md §5.5
"""
import os

from sqlalchemy.orm import Session

from .config import get_settings
from .db_models import AgentRecord

settings = get_settings()


def _endpoint(host: str, port: str) -> str:
    return f"http://{host}:{port}"


def managed_agent_specs() -> list[dict[str, str]]:
    base = settings.workspace_root
    return [
        {
            "name": "DB_Agent",
            "category": "data",
            "endpoint": _endpoint(settings.db_agent_host, settings.db_agent_port),
            "docker_service": "db_agent",
            "k8s_deployment": "db_agent",
            "port": settings.db_agent_port,
            "cwd": os.path.join(base, "DB_Agent"),
            "run": f"npm run dev -- --port {settings.db_agent_port}",
            "runner": "node",
        },
        {
            "name": "RAG_Agent",
            "category": "rag",
            "endpoint": _endpoint(settings.rag_agent_host, settings.rag_agent_port),
            "docker_service": "rag_agent",
            "k8s_deployment": "rag_agent",
            "port": settings.rag_agent_port,
            "cwd": os.path.join(base, "RAG_Agent"),
            "run": f"npm run dev -- --port {settings.rag_agent_port}",
            "runner": "node",
        },
        {
            "name": "code_assistent_Agent",
            "category": "code",
            "endpoint": _endpoint(settings.code_agent_host, settings.code_agent_port),
            "docker_service": "code_assistent_agent",
            "k8s_deployment": "code_assistent_agent",
            "port": settings.code_agent_port,
            "cwd": os.path.join(base, "CodePy_Agent"),
            "run": f"python -m uvicorn app.main:app --host 0.0.0.0 --port {settings.code_agent_port}",
            "runner": "python",
        },
        {
            "name": "Extractor_Agent",
            "category": "crawler",
            "endpoint": _endpoint(settings.extractor_agent_host, settings.extractor_agent_port),
            "docker_service": "extractor_agent",
            "k8s_deployment": "extractor_agent",
            "port": settings.extractor_agent_port,
            "cwd": os.path.join(base, "Extractor_Agent"),
            "run": f"npm run dev -- --port {settings.extractor_agent_port}",
            "runner": "node",
        },
        {
            "name": "AI_admin_Agent",
            "category": "admin",
            "endpoint": _endpoint(settings.ai_admin_agent_host, settings.ai_admin_agent_port),
            "docker_service": "ai_admin_agent",
            "k8s_deployment": "ai_admin_agent",
            "port": settings.ai_admin_agent_port,
            "cwd": os.path.join(base, "AI_admin_Agent", "backend"),
            "run": f"python -m app.main (PORT={settings.ai_admin_agent_port})",
            "runner": "python",
        },
        {
            "name": "Manager_Agent",
            "category": "manager",
            "endpoint": _endpoint(settings.manager_agent_host, settings.manager_agent_port),
            "docker_service": "manager_agent",
            "k8s_deployment": "manager_agent",
            "port": settings.manager_agent_port,
            "cwd": os.path.join(base, "Manager_Agent"),
            "run": f"npm run dev -- --port {settings.manager_agent_port}",
            "runner": "node",
        },
        {
            "name": "Multimodal_Agent",
            "category": "multimodal",
            "endpoint": _endpoint(settings.multimodal_agent_host, settings.multimodal_agent_port),
            "docker_service": "multimodal_agent",
            "k8s_deployment": "multimodal_agent",
            "port": settings.multimodal_agent_port,
            "cwd": os.path.join(base, "Multimodal_Agent", "backend"),
            "run": f"uvicorn app.main:app --host 0.0.0.0 --port {settings.multimodal_agent_port}",
            "runner": "python",
        },
        {
            "name": "Lobster_Agent",
            "category": "lobster",
            "endpoint": _endpoint(settings.lobster_agent_host, settings.lobster_agent_port),
            "docker_service": "lobster_agent",
            "k8s_deployment": "lobster_agent",
            "port": settings.lobster_agent_port,
            "cwd": os.path.join(base, "Lobster_Agent"),
            "run": f"npm run dev -- --port {settings.lobster_agent_port}",
            "runner": "node",
        },
        {
            "name": "Tavern_Agent",
            "category": "tavern",
            "endpoint": _endpoint(settings.tavern_agent_host, settings.tavern_agent_port),
            "docker_service": "tavern_agent",
            "k8s_deployment": "tavern_agent",
            "port": settings.tavern_agent_port,
            "cwd": os.path.join(base, "Tavern_Agent"),
            "run": f"uvicorn app.main:app --host 0.0.0.0 --port {settings.tavern_agent_port}",
            "runner": "python",
        },
        {
            "name": "Music_Agent",
            "category": "music",
            "endpoint": _endpoint(
                os.getenv("MUSIC_AGENT_HOST", "localhost"),
                os.getenv("MUSIC_AGENT_PORT", "13110"),
            ),
            "docker_service": "music_agent",
            "k8s_deployment": "music_agent",
            "port": os.getenv("MUSIC_AGENT_PORT", "13110"),
            "cwd": os.path.join(base, "Music_Agent", "backend"),
            "run": f"uvicorn app.main:app --host 0.0.0.0 --port {os.getenv('MUSIC_AGENT_PORT', '13110')}",
            "runner": "python",
        },
        {
            "name": "Video_Agent",
            "category": "media",
            "endpoint": _endpoint(settings.video_agent_host, settings.video_agent_port),
            "docker_service": "video_agent",
            "k8s_deployment": "video_agent",
            "port": settings.video_agent_port,
            "cwd": os.path.join(base, "Video_Agent", "backend"),
            "run": f"uvicorn app.main:app --host 0.0.0.0 --port {settings.video_agent_port}",
            "runner": "python",
        },
        {
            "name": "AI_Agent",
            "category": "ai",
            "endpoint": _endpoint(settings.ai_agent_host, settings.ai_agent_port),
            "docker_service": "ai_agent",
            "k8s_deployment": "ai_agent",
            "port": settings.ai_agent_port,
            "cwd": os.path.join(base, "AI_Agent", "backend"),
            "run": "python -m app.main (容器内 API_PORT=8080，对外映射 13112)",
            "runner": "python",
        },
    ]


def seed_managed_agents(db: Session) -> None:
    # 13107 已由 Multimodal_Agent 接管，移除旧 Older_Agent 登记
    legacy = db.query(AgentRecord).filter(AgentRecord.name == "Older_Agent").first()
    if legacy:
        db.delete(legacy)
    for spec in managed_agent_specs():
        exists = db.query(AgentRecord).filter(AgentRecord.name == spec["name"]).first()
        if exists:
            exists.category = spec["category"]
            exists.endpoint = spec["endpoint"]
            db.add(exists)
            continue
        db.add(
            AgentRecord(
                name=spec["name"],
                category=spec["category"],
                endpoint=spec["endpoint"],
                status="offline",
            )
        )
    db.commit()
