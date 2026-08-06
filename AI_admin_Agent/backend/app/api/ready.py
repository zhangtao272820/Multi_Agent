from fastapi import APIRouter
from app.core.config import settings
from app.core.llm import qwen_llm
from app.core.rag_client import rag_agent_configured
from app.core.web_search import resolve_search_provider, search_mock_enabled, is_searxng_configured, searxng_base_url
from app.core.webhook_notify import webhook_configured
from app.core.mcp_bridge import mcp_summary
from app.core.langgraph_checkpointer import is_admin_langgraph_checkpointer_enabled
from app.core.db_client import db_agent_configured
from app.core.lobster_client import lobster_agent_configured
from app.core.amap_client import amap_configured
from app.core.feishu_notify import feishu_webhook_configured
from app.core.integrations_registry import get_integrations_payload
from app.core.mcp_playground import check_mcp_gateway, default_mcp_servers_json, mcp_gateway_base_url
from app.core.playground_catalog import playground_summary
from app.db.database import engine

router = APIRouter()


@router.get("/api/ready")
async def ready_check():
    checks: dict = {}
    ok = True

    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
        checks["database"] = {"ok": True}
    except Exception as e:
        checks["database"] = {"ok": False, "error": str(e)}
        ok = False

    llm = qwen_llm.validate_config()
    checks["llm"] = llm
    if not llm.get("ok"):
        ok = False

    checks["smtp"] = {"configured": bool(settings.SMTP_USER and settings.SMTP_PASS)}
    checks["imap"] = {
        "configured": bool(
            (settings.IMAP_USER or settings.SMTP_USER)
            and (settings.IMAP_PASS or settings.SMTP_PASS)
        ),
    }
    checks["mailbox_binding"] = {
        "per_user": True,
        "allow_global_fallback": bool(getattr(settings, "ADMIN_MAIL_ALLOW_GLOBAL_FALLBACK", False)),
        "hint": "用户可在「连接邮箱」绑定国内 IMAP/SMTP 授权码",
    }
    checks["weather"] = {
        "configured": bool(settings.WEATHER_API_KEY and settings.WEATHER_API_HOST),
        "has_key": bool(settings.WEATHER_API_KEY),
        "has_host": bool(settings.WEATHER_API_HOST),
    }
    checks["rag"] = {
        "configured": rag_agent_configured(),
        "url": settings.RAG_AGENT_URL or None,
    }
    checks["web_search"] = {
        "provider": resolve_search_provider(),
        "mock": search_mock_enabled(),
        "searxngConfigured": is_searxng_configured(),
        "searxngUrl": searxng_base_url() or None,
    }
    checks["webhook"] = {"configured": webhook_configured()}
    checks["mcp"] = mcp_summary()
    checks["checkpointer"] = {"enabled": is_admin_langgraph_checkpointer_enabled()}
    checks["db"] = {
        "configured": db_agent_configured(),
        "url": settings.DB_AGENT_HTTP_URL or None,
        "dbId": settings.DB_AGENT_DB_ID or None,
    }
    checks["collaboration"] = {
        "wecom_webhook": bool(settings.ADMIN_WEBHOOK_URL or settings.ADMIN_WECOM_WEBHOOK_URL),
        "dingtalk_webhook": bool(settings.ADMIN_DINGTALK_WEBHOOK_URL),
        "webhook_format": settings.ADMIN_WEBHOOK_FORMAT,
    }
    checks["lobster"] = {
        "configured": lobster_agent_configured(),
        "url": settings.LOBSTER_AGENT_HTTP_URL or None,
    }
    checks["amap"] = {"configured": amap_configured()}
    checks["feishu_calendar"] = {
        "configured": bool(settings.ADMIN_FEISHU_ICS_URL or settings.ADMIN_CALENDAR_ICS_URL),
    }
    checks["feishu_bot"] = {"configured": feishu_webhook_configured()}
    checks["calendar_multi"] = {"configured": bool(settings.ADMIN_CALENDAR_SUBSCRIPTIONS)}
    integrations = get_integrations_payload()
    checks["integrations"] = integrations.get("summary")
    checks["playground"] = playground_summary()
    checks["mcp_gateway"] = {
        **check_mcp_gateway(),
        "defaultServersJson": default_mcp_servers_json(),
        "baseUrl": mcp_gateway_base_url(),
    }

    return {
        "ok": ok,
        "status": "ok" if ok else "degraded",
        "checks": checks,
        "timezone": settings.TIMEZONE,
    }
