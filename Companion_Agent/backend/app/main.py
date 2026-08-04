from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .character import (
    CharacterProfile,
    legacy_presets_from_roles,
    load_character_bases,
    load_presets,
    load_relationship_stages,
)
from .config import PROJECT_ROOT, api_key, get_settings, resolve_frontend_dist
from .daily_encounter import load_daily_catalog, public_encounter_catalog
from .emotions import apply_mood_arc_to_avatar, parse_character_reply
from .endings_catalog import collect_unlocked_endings, public_endings_catalog
from .event_engine import public_events_catalog
from .graph import create_session, run_chat_turn, synthesize_greeting_tts, synthesize_turn_tts
from .quest_engine import public_quest_catalog
from .route_catalog import load_archetype_caps, public_routes
from .save_store import create_save, delete_save, get_save, get_save_for_user, init_db, list_saves, save_to_public
from .scenes import public_scenes, resolve_bg_file, resolve_scene
from .presentation import public_presentation, resolve_ending_presentation
from .bgm import public_bgm_catalog, resolve_bgm_file
from .session_store import store
from .sprite_catalog import public_sprite_roster
from .tts_cache import reset_session_stats, session_stats
from .user_store import authenticate_user, get_user, init_users_db, register_user
from .voice_profile import list_voices, resolve_voice
from .world_store import (
    create_manual_save,
    create_world_save,
    delete_world_save,
    ensure_auto_save,
    get_world_save_for_user,
    init_world_db,
    list_world_saves,
    load_into_auto,
    public_world,
    upsert_world_save,
)
from .world_engine import (
    apply_date_rewards_for_day,
    advance_period,
    advance_period_action,
    do_work,
    eat_meal,
    end_day,
    get_date_def,
    hub_public,
    list_available_dates,
    load_date_catalog,
    travel,
    who_is_here,
)
from .social_graph import public_locations, visible_edges


def _session_talk_extras(session: Any) -> dict[str, Any]:
    pub = session.to_public()
    return {
        "pending_choices": list(pub.get("pending_choices") or []),
        "pending_choice_kind": pub.get("pending_choice_kind") or "soft",
        "quest_state": pub.get("quest_state"),
        "scene_run": pub.get("scene_run"),
        "ensemble": pub.get("ensemble"),
        "story_progress": pub.get("story_progress"),
        "sprite_outfit": pub.get("sprite_outfit") or "",
    }


def _sprite_outfit_for_session(session: Any, save: Any | None = None) -> str:
    """会话立绘：含专属故事当前拍 sprite_hint 强制换装。"""
    try:
        return str(session.resolve_sprite_outfit(save) or "")
    except Exception:
        return ""


def _season_for_save(save: Any) -> str:
    try:
        from .china_calendar import day_info

        return str(day_info(int(save.calendar.day_index or 1)).get("season") or "")
    except Exception:
        return ""


def _resolve_scene_seasoned(save: Any | None = None, **kwargs: Any) -> dict[str, Any]:
    season = kwargs.pop("season", None)
    if season is None and save is not None:
        season = _season_for_save(save)
    if season:
        kwargs["season"] = season
    return resolve_scene(**kwargs)


def _gate_and_note_scene(bond: Any, day_index: int, *, mode: str) -> tuple[Any, str | None]:
    """日接触上限；返回 (bond, error)。"""
    from .scene_run import can_start_scene, counts_toward_daily_limit, note_scene_started

    counts = counts_toward_daily_limit(mode)
    ok, err = can_start_scene(bond, day_index, counts_toward_limit=counts)
    if not ok:
        return bond, err
    return note_scene_started(bond, day_index, counts_toward_limit=counts), None


def _avatar_for_world(raw: str, save: Any, character_id: str) -> dict[str, Any]:
    parsed = parse_character_reply(raw)
    bond = save.bonds.get(character_id) if save else None
    day_mood = None
    if bond and bond.living.day_mood_day == save.calendar.day_index:
        day_mood = bond.living.day_mood_base
    return apply_mood_arc_to_avatar(parsed, day_mood_base=day_mood)


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Companion Agent API", version="0.3.0")
settings = get_settings()
init_db()
init_users_db()
init_world_db()
reset_session_stats()

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["http://localhost:5175"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_frontend_dist = resolve_frontend_dist()


@app.get("/api/health")
def health():
    from .config import USER_DATA_ROOT

    return {
        "ok": True,
        "model": settings.companion_llm_model,
        "has_key": bool(api_key(settings)),
        "judge_mode": settings.companion_judge_mode,
        "memory_llm": bool(settings.companion_memory_llm_enabled),
        "context_keep_pairs": int(settings.companion_context_keep_pairs),
        "user_data": str(USER_DATA_ROOT),
        "avatar_mode": "sprite",
        "tts_enabled": settings.companion_tts_enabled,
        "tts_mode": settings.companion_tts_mode,
        "tts_model": settings.companion_tts_model,
        "character_count": sum(
            len(b.get("characters") or []) for b in load_character_bases()
        ),
        **session_stats(),
    }


@app.get("/api/voices")
def voices():
    return {"voices": list_voices(), "tts_enabled": settings.companion_tts_enabled}


@app.get("/api/presets")
def presets():
    return {
        "presets": legacy_presets_from_roles("cheerful_sun") or load_presets(),
        "character_bases": load_character_bases(),
        "relationship_stages": load_relationship_stages(),
        "routes": public_routes(),
        "archetype_caps": load_archetype_caps(),
        "events": public_events_catalog(),
        "scenes": public_scenes(),
        "sprites": public_sprite_roster(),
        "endings": public_endings_catalog(),
        "voices": list_voices(),
        "tts_enabled": settings.companion_tts_enabled,
        "tts_mode": settings.companion_tts_mode,
        "tts_fallback": settings.companion_tts_fallback,
        "daily_ap_enabled": settings.companion_daily_ap_enabled,
        "daily_ap_max": settings.companion_daily_ap_max,
        "tts_browser_fallback": settings.companion_tts_fallback == "browser",
        "quests": public_quest_catalog(),
        "avatar_mode": "sprite",
    }


class SaveCreateIn(BaseModel):
    profile: CharacterProfile
    base_id: str = ""
    user_id: str = "default"


class AuthIn(BaseModel):
    username: str = Field(..., min_length=2, max_length=24)
    password: str = Field(..., min_length=4, max_length=64)
    display_name: str = ""


@app.post("/api/auth/register")
def auth_register(body: AuthIn):
    try:
        user = register_user(body.username, body.password, body.display_name)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"ok": True, "user": user}


@app.post("/api/auth/login")
def auth_login(body: AuthIn):
    user = authenticate_user(body.username, body.password)
    if not user:
        raise HTTPException(401, "用户名或密码错误")
    return {"ok": True, "user": user}


@app.get("/api/auth/me")
def auth_me(user_id: str = ""):
    if not user_id.strip():
        raise HTTPException(401, "未登录")
    user = get_user(user_id.strip())
    if not user:
        raise HTTPException(401, "用户不存在")
    return {"ok": True, "user": user}


@app.get("/api/endings")
def endings_catalog():
    return {"endings": public_endings_catalog()}


@app.get("/api/endings/unlocked")
def endings_unlocked(user_id: str = "default"):
    return collect_unlocked_endings(user_id)


@app.get("/api/scenes")
def scenes_api():
    return {"scenes": public_scenes()}


@app.get("/api/quests")
def quests_api():
    return {"quests": public_quest_catalog()}


@app.get("/api/daily-encounters")
def daily_encounters_api(
    character_id: str = "",
    base_id: str = "",
    stage_id: str = "dating",
):
    from .relationship import RelationshipState

    state = RelationshipState(stage_id=stage_id or "dating")
    return {
        "ap_max": load_daily_catalog().get("ap_max") or settings.companion_daily_ap_max,
        "encounters": public_encounter_catalog(character_id=character_id, base_id=base_id, state=state),
    }


@app.get("/api/sprites/gallery")
def sprites_gallery(
    save_id: str = "",
    user_id: str = "default",
    mode: str = "pick",
):
    from .cast_pick import build_gallery_payload

    return build_gallery_payload(save_id=save_id, user_id=user_id, mode=mode)


@app.get("/api/cast-pick")
def cast_pick_get():
    from .cast_pick import load_cast_pick_draft

    return load_cast_pick_draft()


class CastPickIn(BaseModel):
    picks: dict[str, Any] = Field(default_factory=dict)


@app.put("/api/cast-pick")
def cast_pick_put(body: CastPickIn):
    from .cast_pick import save_cast_pick_draft

    try:
        draft = save_cast_pick_draft(body.picks)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"ok": True, "draft": draft}


@app.post("/api/cast-pick/apply")
def cast_pick_apply():
    from .cast_pick import apply_cast_pick_to_social_graph

    try:
        return apply_cast_pick_to_social_graph()
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex


@app.get("/api/calendar/today")
def calendar_for_day(day_index: int = 1):
    from .china_calendar import day_info

    return day_info(day_index)


@app.get("/api/sprites/background/{location}/{filename}")
def background_sprite_asset(location: str, filename: str):
    """路人/NPC 杂图背景层；仅 _background/{location}/{filename}。"""
    from .background_extras import resolve_background_file

    loc = location.replace("\\", "").replace("/", "").replace("..", "")
    name = filename.replace("\\", "").replace("/", "").replace("..", "")
    if not loc or not name.endswith(".png"):
        raise HTTPException(404)
    path = resolve_background_file(f"{loc}/{name}")
    if not path:
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")


def _sprite_png_response(path: Path) -> FileResponse:
    """Serve character sprites as static PNG (unified RGBA on disk; no runtime chroma)."""
    if not path or not path.is_file():
        raise HTTPException(404)
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/sprites/{character_id}/{emotion}.png")
def sprite_asset(character_id: str, emotion: str):
    """emotion 可为 stock 名或 outfit_emotion / outfit_state_emotion。
    磁盘分档：data/sprites/{romance|neutral}/{id}/（路人见 /api/sprites/background/…）
    缺图时：同 outfit 换中性情绪 → 去 outfit 留情绪 → neutral。
    正式图应为统一 1024×1536 RGBA；直出文件，不做运行时抠图。
    """
    from .sprite_catalog import resolve_sprite_file

    safe = emotion.replace("\\", "").replace("/", "").replace("..", "")
    path = resolve_sprite_file(character_id, f"{safe}.png")
    if path:
        return _sprite_png_response(path)
    parts = safe.split("_")
    tail = parts[-1] if parts else safe
    # 同 outfit 试 neutral
    if len(parts) >= 2 and tail != "neutral":
        outfit_prefix = "_".join(parts[:-1])
        alt = resolve_sprite_file(character_id, f"{outfit_prefix}_neutral.png")
        if alt:
            return _sprite_png_response(alt)
    # 裸情绪
    fallback = resolve_sprite_file(character_id, f"{tail}.png")
    if fallback:
        return _sprite_png_response(fallback)
    neutral = resolve_sprite_file(character_id, "neutral.png")
    if neutral:
        return _sprite_png_response(neutral)
    raise HTTPException(404)


@app.get("/api/bgs/{name}")
def scene_bg_asset(name: str):
    path = resolve_bg_file(name)
    if not path:
        raise HTTPException(404)
    media = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return FileResponse(path, media_type=media)


@app.get("/api/presentation")
def presentation_catalog():
    return public_presentation()


@app.get("/api/bgm/catalog")
def bgm_catalog():
    return public_bgm_catalog()


@app.get("/api/bgm/{track_id}")
def bgm_asset(track_id: str):
    path = resolve_bgm_file(track_id)
    if not path:
        raise HTTPException(404)
    suffix = path.suffix.lower()
    media = {
        ".ogg": "audio/ogg",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
    }.get(suffix, "application/octet-stream")
    return FileResponse(path, media_type=media)


@app.get("/api/saves")
def saves_list(user_id: str = "default"):
    return {"saves": list_saves(user_id)}


@app.post("/api/saves")
def saves_create(body: SaveCreateIn):
    if not body.user_id.strip() or body.user_id == "default":
        raise HTTPException(401, "请先登录后再创建存档")
    if not get_user(body.user_id):
        raise HTTPException(401, "用户无效，请重新登录")
    profile = body.profile
    if not profile.character_id.strip() and body.base_id:
        for base in load_character_bases():
            if str(base.get("id") or "") != body.base_id:
                continue
            for row in base.get("characters") or []:
                prof = row.get("profile") or {}
                if prof.get("name") == profile.name:
                    profile = profile.model_copy(update={"character_id": str(row.get("id") or "")})
                    break
    save = create_save(
        profile,
        user_id=body.user_id,
        character_id=profile.character_id,
        base_id=body.base_id,
    )
    return save_to_public(save)


@app.get("/api/saves/{save_id}")
def saves_get(save_id: str, user_id: str = ""):
    if user_id.strip():
        save = get_save_for_user(save_id, user_id.strip())
    else:
        save = get_save(save_id)
    if not save:
        raise HTTPException(404, "存档不存在或无权访问")
    return save_to_public(save)


@app.delete("/api/saves/{save_id}")
def saves_delete(save_id: str, user_id: str = ""):
    uid = user_id.strip()
    if not uid:
        raise HTTPException(401, "请先登录")
    if not delete_save(save_id, user_id=uid):
        raise HTTPException(404, "存档不存在或无权删除")
    return {"ok": True}


class WorldCreateIn(BaseModel):
    user_id: str
    protagonist_name: str = "我"


class WorldManualSaveIn(BaseModel):
    user_id: str
    save_id: str
    label: str = ""


@app.get("/api/world/locations")
def world_locations():
    return {"locations": public_locations()}


@app.get("/api/world/saves")
def world_saves_list(user_id: str = ""):
    if not user_id.strip():
        raise HTTPException(401, "请先登录")
    return {"saves": list_world_saves(user_id.strip())}


@app.post("/api/world/saves")
def world_saves_create(body: WorldCreateIn):
    """新游戏：重置唯一自动档。"""
    if not body.user_id.strip() or body.user_id == "default":
        raise HTTPException(401, "请先登录后再创建存档")
    if not get_user(body.user_id):
        raise HTTPException(401, "用户无效，请重新登录")
    save = create_world_save(user_id=body.user_id, protagonist_name=body.protagonist_name)
    return {"ok": True, "world": public_world(save), "hub": hub_public(save)}


@app.post("/api/world/saves/manual")
def world_saves_manual(body: WorldManualSaveIn):
    """手动存档：深拷贝当前世界。"""
    if not body.user_id.strip() or body.user_id == "default":
        raise HTTPException(401, "请先登录")
    if not get_user(body.user_id):
        raise HTTPException(401, "用户无效，请重新登录")
    try:
        save = create_manual_save(
            user_id=body.user_id.strip(),
            source_save_id=body.save_id.strip(),
            label=body.label or "",
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "ok": True,
        "save_id": save.save_id,
        "kind": save.kind,
        "label": save.label,
        "saves": list_world_saves(body.user_id.strip()),
    }


@app.get("/api/world/saves/{save_id}")
def world_saves_get(save_id: str, user_id: str = ""):
    if not user_id.strip():
        raise HTTPException(401, "请先登录")
    save = get_world_save_for_user(save_id, user_id.strip())
    if not save:
        raise HTTPException(404, "世界存档不存在或无权访问")
    return {"world": public_world(save), "hub": hub_public(save)}


@app.delete("/api/world/saves/{save_id}")
def world_saves_delete(save_id: str, user_id: str = ""):
    if not user_id.strip():
        raise HTTPException(401, "请先登录")
    try:
        ok = delete_world_save(save_id, user_id=user_id.strip())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not ok:
        raise HTTPException(404, "世界存档不存在或无权删除")
    return {"ok": True}


@app.get("/api/world/saves/{save_id}/hub")
def world_hub(save_id: str, user_id: str = ""):
    if not user_id.strip():
        raise HTTPException(401, "请先登录")
    save = get_world_save_for_user(save_id, user_id.strip())
    if not save:
        raise HTTPException(404, "世界存档不存在或无权访问")
    return hub_public(save)


@app.get("/api/world/saves/{save_id}/dates")
def world_dates(save_id: str, character_id: str, user_id: str = ""):
    if not user_id.strip():
        raise HTTPException(401, "请先登录")
    save = get_world_save_for_user(save_id, user_id.strip())
    if not save:
        raise HTTPException(404, "世界存档不存在或无权访问")
    return {"dates": list_available_dates(save, character_id)}


class SessionIn(BaseModel):
    profile: CharacterProfile
    base_id: str = ""
    save_id: str | None = None
    user_id: str = "default"


@app.post("/api/sessions")
def create_session_http(body: SessionIn):
    if not body.user_id.strip() or body.user_id == "default":
        raise HTTPException(401, "请先登录后再开始游戏")
    if not get_user(body.user_id):
        raise HTTPException(401, "用户无效，请重新登录")
    if body.save_id:
        owned = get_save_for_user(body.save_id, body.user_id)
        if not owned:
            raise HTTPException(404, "存档不存在或无权读取")
    session = create_session(
        body.profile,
        base_id=body.base_id,
        save_id=body.save_id,
        user_id=body.user_id,
    )
    opening = session.messages[0]["content"]
    parsed = parse_character_reply(opening)
    return {
        "session_id": session.id,
        "save_id": session.save_id,
        "greeting": opening,
        "avatar": parsed,
        "profile": session.profile.model_dump(),
        "relationship_state": session.relationship_state.model_dump(),
        "memories": [m.model_dump() for m in session.memories],
    }


class ChatIn(BaseModel):
    session_id: str
    text: str = Field(..., min_length=1, max_length=4000)
    choice_index: int | None = None


@app.post("/api/chat")
def chat_http(body: ChatIn):
    if not api_key(settings):
        raise HTTPException(503, "未配置 DASHSCOPE_API_KEY")
    try:
        result = run_chat_turn(
            settings,
            session_id=body.session_id,
            user_text=body.text,
            choice_index=body.choice_index,
        )
    except Exception as ex:
        logger.exception("chat failed")
        raise HTTPException(500, str(ex)) from ex
    if result.get("error"):
        raise HTTPException(400, str(result["error"]))
    parsed = result.get("parsed") or {}
    return {
        "reply": result.get("reply_raw", ""),
        "spoken": parsed.get("spoken", ""),
        "avatar": parsed,
        "choices": parsed.get("choices") or [],
    }


@app.websocket("/ws")
async def websocket_chat(ws: WebSocket):
    await ws.accept()
    try:
        await ws.send_json(
            {
                "type": "ready",
                "payload": {
                    "model": settings.companion_llm_model,
                    "presets": legacy_presets_from_roles("cheerful_sun") or load_presets(),
                    "character_bases": load_character_bases(),
                    "relationship_stages": load_relationship_stages(),
                    "routes": public_routes(),
                    "archetype_caps": load_archetype_caps(),
                    "events": public_events_catalog(),
                    "avatar_mode": "sprite",
                    "voices": list_voices(),
                    "tts_enabled": settings.companion_tts_enabled,
                },
            }
        )
    except Exception:
        return

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "payload": {"message": "JSON 无效"}})
                continue

            mtype = msg.get("type")
            payload = msg.get("payload") or {}

            if mtype == "world_start":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                if not user_id or not get_user(user_id):
                    await ws.send_json({"type": "error", "payload": {"message": "请先登录"}})
                    continue
                if save_id:
                    # 读档：手动档灌回自动档；自动档直接加载
                    save = load_into_auto(user_id=user_id, source_save_id=save_id)
                    if not save:
                        await ws.send_json({"type": "error", "payload": {"message": "世界存档不存在"}})
                        continue
                else:
                    save = ensure_auto_save(
                        user_id=user_id,
                        protagonist_name=str(payload.get("protagonist_name") or "我"),
                    )
                await ws.send_json(
                    {
                        "type": "world_ready",
                        "payload": {"world": public_world(save), "hub": hub_public(save)},
                    }
                )
                continue

            if mtype == "world_travel":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                loc = str(payload.get("location_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                save, result = travel(save, loc)
                if not result.get("ok"):
                    await ws.send_json({"type": "error", "payload": {"message": result.get("error") or "无法前往"}})
                    continue
                await ws.send_json(
                    {
                        "type": "world_traveled",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "world_end_day":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                save, result = end_day(save)
                await ws.send_json(
                    {
                        "type": "world_day_ended",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "do_work":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                save, result = do_work(save)
                if not result.get("ok"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "无法上班"}}
                    )
                    continue
                await ws.send_json(
                    {
                        "type": "work_done",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "complete_errand":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                from .errands import complete_errand

                save, result = complete_errand(save)
                if not result.get("ok"):
                    await ws.send_json(
                        {
                            "type": "error",
                            "payload": {"message": result.get("error") or "无法完成待办"},
                        }
                    )
                    continue
                upsert_world_save(save)
                await ws.send_json(
                    {
                        "type": "errand_done",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "eat_meal":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                meal_id = str(payload.get("meal_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                save, result = eat_meal(save, meal_id=meal_id)
                if not result.get("ok"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "无法用餐"}}
                    )
                    continue
                await ws.send_json(
                    {
                        "type": "meal_done",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "advance_period":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                save, result = advance_period_action(save)
                if not result.get("ok"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "无法推进时段"}}
                    )
                    continue
                await ws.send_json(
                    {
                        "type": "period_advanced",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "jump_waypoint":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                waypoint_id = str(payload.get("waypoint_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                from .season_waypoints import jump_to_next_waypoint, jump_to_waypoint

                if waypoint_id:
                    save, result = jump_to_waypoint(save, waypoint_id)
                else:
                    save, result = jump_to_next_waypoint(save)
                if not result.get("ok"):
                    await ws.send_json(
                        {
                            "type": "error",
                            "payload": {"message": result.get("error") or "无法跳到下一季"},
                        }
                    )
                    continue
                await ws.send_json(
                    {
                        "type": "waypoint_jumped",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "settle_friend_ending":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                character_id = str(payload.get("character_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                from .life_friction import settle_friend_ending

                save, result = settle_friend_ending(save, character_id)
                if not result.get("ok"):
                    await ws.send_json(
                        {
                            "type": "error",
                            "payload": {"message": result.get("error") or "无法结算"},
                        }
                    )
                    continue
                out: dict = {
                    "type": "friend_ending_settled",
                    "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                }
                await ws.send_json(out)
                if result.get("ending"):
                    await ws.send_json({"type": "game_ending", "payload": result["ending"]})
                continue

            if mtype == "leave_scene":
                sid = str(payload.get("session_id") or "").strip()
                reason = str(payload.get("reason") or "farewell").strip() or "farewell"
                if reason not in {"farewell", "turns_exhausted", "busy", "she_leaves", "awkward"}:
                    reason = "farewell"
                result = store.leave_scene(sid, reason=reason)
                if not result:
                    await ws.send_json({"type": "error", "payload": {"message": "会话不存在"}})
                    continue
                if result.get("ok") is False:
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "无法告辞"}}
                    )
                    continue
                await ws.send_json({"type": "scene_ended", "payload": result})
                continue

            if mtype == "schedule_date":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                character_id = str(payload.get("character_id") or "").strip()
                date_id = str(payload.get("date_id") or "").strip()
                when = str(payload.get("when") or "weekend").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                date_def = get_date_def(date_id)
                if not save or not date_def or character_id not in save.bonds:
                    await ws.send_json({"type": "error", "payload": {"message": "无法预约"}})
                    continue
                avail_map = {d["id"]: d for d in list_available_dates(save, character_id)}
                if date_id not in avail_map:
                    await ws.send_json({"type": "error", "payload": {"message": "还未达到约会条件"}})
                    continue
                soft = avail_map[date_id]
                if soft.get("soft_reject"):
                    await ws.send_json(
                        {
                            "type": "error",
                            "payload": {"message": soft.get("reject_reason") or "她不太方便"},
                        }
                    )
                    continue
                from .appointments import schedule_appointment

                save, result = schedule_appointment(
                    save,
                    character_id=character_id,
                    date_id=date_id,
                    label=date_def.label,
                    location_id=date_def.location_id,
                    when=when,
                )
                if not result.get("ok"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "预约失败"}}
                    )
                    continue
                await ws.send_json(
                    {
                        "type": "date_scheduled",
                        "payload": {**result, "hub": hub_public(save), "world": public_world(save)},
                    }
                )
                continue

            if mtype == "fulfill_appointment":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                appointment_id = str(payload.get("appointment_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                from .appointments import fulfill_appointment

                save, result = fulfill_appointment(save, appointment_id=appointment_id)
                if not result.get("ok"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "无法赴约"}}
                    )
                    continue
                character_id = str(result.get("character_id") or "")
                date_id = str(result.get("date_id") or "")
                ap_kind = str(result.get("kind") or ("talk" if not date_id else "date"))
                if character_id not in save.bonds:
                    await ws.send_json({"type": "error", "payload": {"message": "角色不在存档中"}})
                    continue

                # 谈话预约：无 date_id → 普通 enter_talk（扣 talk_cost）
                if ap_kind == "talk" or not date_id:
                    cat = load_date_catalog()
                    talk_cost = int(cat.talk_cost)
                    loc_id = str(result.get("location_id") or save.location_id)
                    if loc_id and save.location_id != loc_id:
                        save, tr = travel(save, loc_id)
                        if not tr.get("ok"):
                            await ws.send_json(
                                {
                                    "type": "error",
                                    "payload": {"message": tr.get("error") or "无法前往"},
                                }
                            )
                            continue
                    if save.action_points < talk_cost:
                        await ws.send_json(
                            {"type": "error", "payload": {"message": "行动力不足"}}
                        )
                        continue
                    bond_gate, gate_err = _gate_and_note_scene(
                        save.bonds[character_id], save.calendar.day_index, mode="talk"
                    )
                    if gate_err:
                        await ws.send_json({"type": "error", "payload": {"message": gate_err}})
                        continue
                    save.bonds[character_id] = bond_gate
                    save.action_points -= talk_cost
                    from .living_sim import lock_day_mood, mark_talked

                    bond = lock_day_mood(save.bonds[character_id], save.calendar.day_index)
                    bond = mark_talked(bond, save.calendar.day_index)
                    save.bonds[character_id] = bond
                    save = advance_period(save, allow_day_roll=False)
                    upsert_world_save(save)
                    session = store.create_world_talk(
                        world_save_id=save_id, character_id=character_id, scene_mode="talk"
                    )
                    if not session:
                        await ws.send_json(
                            {"type": "error", "payload": {"message": "创建会话失败"}}
                        )
                        continue
                    opening = session.messages[-1]["content"] if session.messages else ""
                    parsed = _avatar_for_world(opening, save, character_id)
                    from .social_graph import location_index

                    loc = location_index().get(save.location_id)
                    scene = _resolve_scene_seasoned(
                        save, scene_id=(loc.scene_id if loc else "") or save.location_id
                    )
                    outfit = _sprite_outfit_for_session(session, save)
                    await ws.send_json(
                        {
                            "type": "session_created",
                            "payload": {
                                "session_id": session.id,
                                "save_id": save_id,
                                "world_save_id": save_id,
                                "character_id": character_id,
                                "greeting": opening,
                                "avatar": parsed,
                                "profile": session.profile.model_dump(),
                                "relationship_state": session.relationship_state.model_dump(),
                                "memories": [m.model_dump() for m in session.memories],
                                "dialogue": [m.model_dump() for m in session.dialogue_turns],
                                "scene": scene,
                                "mode": "talk",
                                "hub": hub_public(save),
                                "sprite_outfit": outfit,
                                **_session_talk_extras(session),
                            },
                        }
                    )
                    continue

                date_def = get_date_def(date_id)
                if not date_def:
                    await ws.send_json({"type": "error", "payload": {"message": "约会内容丢失"}})
                    continue
                cat = load_date_catalog()
                cost = int(cat.date_cost)
                if save.location_id != date_def.location_id:
                    save, tr = travel(save, date_def.location_id)
                    if not tr.get("ok"):
                        await ws.send_json(
                            {"type": "error", "payload": {"message": tr.get("error") or "无法前往"}}
                        )
                        continue
                if save.action_points < cost:
                    await ws.send_json({"type": "error", "payload": {"message": "行动力不足"}})
                    continue
                bond_gate, gate_err = _gate_and_note_scene(
                    save.bonds[character_id], save.calendar.day_index, mode="date"
                )
                if gate_err:
                    await ws.send_json({"type": "error", "payload": {"message": gate_err}})
                    continue
                save.bonds[character_id] = bond_gate
                save.action_points -= cost
                money = 0
                from .life_friction import note_date_spend_friction

                save = note_date_spend_friction(save, character_id, money_spent=money)
                from .living_sim import lock_day_mood, mark_talked

                bond = apply_date_rewards_for_day(
                    save.bonds[character_id], date_def, save.calendar.day_index
                )
                bond = lock_day_mood(bond, save.calendar.day_index)
                bond = mark_talked(bond, save.calendar.day_index)
                save.bonds[character_id] = bond
                save = advance_period(save, allow_day_roll=False)
                upsert_world_save(save)
                session = store.create_world_talk(
                    world_save_id=save_id,
                    character_id=character_id,
                    date_snippet=date_def.prompt_snippet,
                    scene_mode="date",
                )
                if not session:
                    await ws.send_json({"type": "error", "payload": {"message": "创建约会会话失败"}})
                    continue
                opening = session.messages[-1]["content"] if session.messages else ""
                parsed = _avatar_for_world(opening, save, character_id)
                scene = _resolve_scene_seasoned(
                    save, scene_id=date_def.scene_id or date_def.location_id
                )
                outfit = _sprite_outfit_for_session(session, save)
                await ws.send_json(
                    {
                        "type": "session_created",
                        "payload": {
                            "session_id": session.id,
                            "save_id": save_id,
                            "world_save_id": save_id,
                            "character_id": character_id,
                            "greeting": opening,
                            "avatar": parsed,
                            "profile": session.profile.model_dump(),
                            "relationship_state": session.relationship_state.model_dump(),
                            "memories": [m.model_dump() for m in session.memories],
                            "dialogue": [m.model_dump() for m in session.dialogue_turns],
                            "scene": scene,
                            "mode": "date",
                            "date": {"id": date_def.id, "label": date_def.label},
                            "hub": hub_public(save),
                            "sprite_outfit": outfit,
                            **_session_talk_extras(session),
                        },
                    }
                )
                continue

            if mtype == "enter_talk":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                character_id = str(payload.get("character_id") or "").strip()
                guest_character_id = str(payload.get("guest_character_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save or character_id not in save.bonds:
                    await ws.send_json({"type": "error", "payload": {"message": "无法开始对话"}})
                    continue
                present = who_is_here(save)
                if character_id not in present:
                    await ws.send_json({"type": "error", "payload": {"message": "她现在不在这里"}})
                    continue
                if guest_character_id:
                    if guest_character_id == character_id or guest_character_id not in present:
                        await ws.send_json(
                            {"type": "error", "payload": {"message": "同场对象现在不在这里"}}
                        )
                        continue
                cat = load_date_catalog()
                talk_cost = int(cat.talk_cost)
                if save.action_points < talk_cost:
                    await ws.send_json({"type": "error", "payload": {"message": "行动力不足"}})
                    continue
                bond_gate = save.bonds[character_id]
                bond_gate, gate_err = _gate_and_note_scene(
                    bond_gate, save.calendar.day_index, mode="talk"
                )
                if gate_err:
                    await ws.send_json({"type": "error", "payload": {"message": gate_err}})
                    continue
                save.bonds[character_id] = bond_gate
                save.action_points -= talk_cost
                if save.onboarding_step in {"wake", "go_out"}:
                    save.onboarding_step = "meet"
                from .living_sim import lock_day_mood, mark_talked

                bond = lock_day_mood(save.bonds[character_id], save.calendar.day_index)
                bond = mark_talked(bond, save.calendar.day_index)
                save.bonds[character_id] = bond
                # 每次深度交谈推进一个时段，夜晚之后仍由 end_day 翻日
                save = advance_period(save, allow_day_roll=False)
                upsert_world_save(save)
                session = store.create_world_talk(
                    world_save_id=save_id,
                    character_id=character_id,
                    scene_mode="talk",
                    guest_character_id=guest_character_id,
                )
                if not session:
                    await ws.send_json({"type": "error", "payload": {"message": "创建会话失败"}})
                    continue
                opening = session.messages[-1]["content"] if session.messages else ""
                parsed = _avatar_for_world(opening, save, character_id)
                from .social_graph import location_index

                loc = location_index().get(save.location_id)
                scene = _resolve_scene_seasoned(
                    save,
                    scene_id=(loc.scene_id if loc else "") or save.location_id,
                )
                outfit = _sprite_outfit_for_session(session, save)
                await ws.send_json(
                    {
                        "type": "session_created",
                        "payload": {
                            "session_id": session.id,
                            "save_id": save_id,
                            "world_save_id": save_id,
                            "character_id": character_id,
                            "greeting": opening,
                            "avatar": parsed,
                            "profile": session.profile.model_dump(),
                            "relationship_state": session.relationship_state.model_dump(),
                            "memories": [m.model_dump() for m in session.memories],
                            "dialogue": [m.model_dump() for m in session.dialogue_turns],
                            "scene": scene,
                            "mode": "talk",
                            "hub": hub_public(save),
                            "dates": list_available_dates(save, character_id),
                            "edges": visible_edges(character_id, insight=save.social_insight),
                            "sprite_outfit": outfit,
                            **_session_talk_extras(session),
                        },
                    }
                )
                continue

            if mtype == "reply_ping":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                character_id = str(payload.get("character_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save or character_id not in save.bonds:
                    await ws.send_json({"type": "error", "payload": {"message": "无法回复消息"}})
                    continue
                bond = save.bonds[character_id]
                ping_text = (bond.living.pending_ping or "").strip()
                if not ping_text:
                    await ws.send_json({"type": "error", "payload": {"message": "没有待回复的消息"}})
                    continue
                from .living_sim import lock_day_mood, mark_talked

                bond = lock_day_mood(bond, save.calendar.day_index)
                bond = mark_talked(bond, save.calendar.day_index)
                # ping 不计入日接触上限，但仍有场次回合预算
                bond, _ = _gate_and_note_scene(bond, save.calendar.day_index, mode="ping")
                save.bonds[character_id] = bond
                # 回消息不扣旅途心力；不强制人在场
                upsert_world_save(save)
                session = store.create_world_talk(
                    world_save_id=save_id,
                    character_id=character_id,
                    date_snippet=(
                        f"她主动发来消息：「{ping_text}」。请自然接上这条消息的语气，"
                        "不要念系统设定。"
                    ),
                    scene_mode="ping",
                )
                if not session:
                    await ws.send_json({"type": "error", "payload": {"message": "创建会话失败"}})
                    continue
                opening = session.messages[-1]["content"] if session.messages else ""
                parsed = _avatar_for_world(opening, save, character_id)
                from .social_graph import location_index
                from .sprite_outfit import meal_context_from_save, resolve_outfit_for_world
                loc = location_index().get(save.location_id)
                scene = _resolve_scene_seasoned(
                    save, scene_id=(loc.scene_id if loc else "") or save.location_id
                )
                outfit = _sprite_outfit_for_session(session, save)
                await ws.send_json(
                    {
                        "type": "session_created",
                        "payload": {
                            "session_id": session.id,
                            "save_id": save_id,
                            "world_save_id": save_id,
                            "character_id": character_id,
                            "greeting": opening,
                            "avatar": parsed,
                            "profile": session.profile.model_dump(),
                            "relationship_state": session.relationship_state.model_dump(),
                            "memories": [m.model_dump() for m in session.memories],
                            "dialogue": [m.model_dump() for m in session.dialogue_turns],
                            "scene": scene,
                            "mode": "ping",
                            "hub": hub_public(save),
                            "sprite_outfit": outfit,
                            "ping_text": ping_text,
                            **_session_talk_extras(session),
                        },
                    }
                )
                continue

            if mtype == "buy_gift":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                character_id = str(payload.get("character_id") or "").strip()
                gift_id = str(payload.get("gift_id") or "").strip()
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                if not save:
                    await ws.send_json({"type": "error", "payload": {"message": "存档无效"}})
                    continue
                from .gifts import buy_gift as do_buy_gift

                save, result = do_buy_gift(save, character_id=character_id, gift_id=gift_id)
                if not result.get("ok"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": result.get("error") or "购买失败"}}
                    )
                    continue
                await ws.send_json(
                    {
                        "type": "gift_bought",
                        "payload": {
                            **result,
                            "hub": hub_public(save),
                            "world": public_world(save),
                        },
                    }
                )
                continue

            if mtype == "ask_date":
                user_id = str(payload.get("user_id") or "").strip()
                save_id = str(payload.get("save_id") or "").strip()
                character_id = str(payload.get("character_id") or "").strip()
                date_id = str(payload.get("date_id") or "").strip()
                when = str(payload.get("when") or "now").strip() or "now"
                save = get_world_save_for_user(save_id, user_id) if user_id else None
                date_def = get_date_def(date_id)
                if not save or not date_def or character_id not in save.bonds:
                    await ws.send_json({"type": "error", "payload": {"message": "约会不可用"}})
                    continue
                avail_map = {d["id"]: d for d in list_available_dates(save, character_id)}
                if date_id not in avail_map:
                    await ws.send_json({"type": "error", "payload": {"message": "还未达到约会条件"}})
                    continue
                soft = avail_map[date_id]
                if soft.get("soft_reject"):
                    await ws.send_json(
                        {
                            "type": "error",
                            "payload": {
                                "message": soft.get("reject_reason") or "她今天不太方便",
                            },
                        }
                    )
                    continue
                # 预约将来时段
                if when not in {"", "now"}:
                    from .appointments import schedule_appointment

                    save, result = schedule_appointment(
                        save,
                        character_id=character_id,
                        date_id=date_id,
                        label=date_def.label,
                        location_id=date_def.location_id,
                        when=when,
                    )
                    if not result.get("ok"):
                        await ws.send_json(
                            {"type": "error", "payload": {"message": result.get("error") or "预约失败"}}
                        )
                        continue
                    await ws.send_json(
                        {
                            "type": "date_scheduled",
                            "payload": {
                                **result,
                                "hub": hub_public(save),
                                "world": public_world(save),
                            },
                        }
                    )
                    continue
                cat = load_date_catalog()
                cost = int(cat.date_cost)
                if save.location_id != date_def.location_id:
                    save, tr = travel(save, date_def.location_id)
                    if not tr.get("ok"):
                        await ws.send_json({"type": "error", "payload": {"message": tr.get("error") or "无法前往约会地点"}})
                        continue
                if save.action_points < cost:
                    await ws.send_json({"type": "error", "payload": {"message": "行动力不足"}})
                    continue
                bond_gate, gate_err = _gate_and_note_scene(
                    save.bonds[character_id], save.calendar.day_index, mode="date"
                )
                if gate_err:
                    await ws.send_json({"type": "error", "payload": {"message": gate_err}})
                    continue
                save.bonds[character_id] = bond_gate
                save.action_points -= cost
                money = 0
                from .life_friction import note_date_spend_friction

                save = note_date_spend_friction(save, character_id, money_spent=money)
                from .living_sim import lock_day_mood, mark_talked

                bond = apply_date_rewards_for_day(
                    save.bonds[character_id], date_def, save.calendar.day_index
                )
                bond = lock_day_mood(bond, save.calendar.day_index)
                bond = mark_talked(bond, save.calendar.day_index)
                save.bonds[character_id] = bond
                save = advance_period(save, allow_day_roll=False)
                upsert_world_save(save)
                session = store.create_world_talk(
                    world_save_id=save_id,
                    character_id=character_id,
                    date_snippet=date_def.prompt_snippet,
                    scene_mode="date",
                )
                if not session:
                    await ws.send_json({"type": "error", "payload": {"message": "创建约会会话失败"}})
                    continue
                opening = session.messages[-1]["content"] if session.messages else ""
                parsed = _avatar_for_world(opening, save, character_id)
                scene = _resolve_scene_seasoned(
                    save, scene_id=date_def.scene_id or date_def.location_id
                )
                outfit = _sprite_outfit_for_session(session, save)
                await ws.send_json(
                    {
                        "type": "session_created",
                        "payload": {
                            "session_id": session.id,
                            "save_id": save_id,
                            "world_save_id": save_id,
                            "character_id": character_id,
                            "greeting": opening,
                            "avatar": parsed,
                            "profile": session.profile.model_dump(),
                            "relationship_state": session.relationship_state.model_dump(),
                            "memories": [m.model_dump() for m in session.memories],
                            "dialogue": [m.model_dump() for m in session.dialogue_turns],
                            "scene": scene,
                            "mode": "date",
                            "date": {"id": date_def.id, "label": date_def.label},
                            "hub": hub_public(save),
                            "sprite_outfit": outfit,
                            **_session_talk_extras(session),
                        },
                    }
                )
                continue

            if mtype == "rollback_turn":
                session_id = str(payload.get("session_id") or "")
                turn_id = int(payload.get("turn_id") or 0)
                result = store.rollback_bond(session_id, turn_id)
                if not result or result.get("error"):
                    await ws.send_json(
                        {"type": "error", "payload": {"message": (result or {}).get("error") or "回退失败"}}
                    )
                    continue
                await ws.send_json({"type": "rollback_done", "payload": result})
                continue

            if mtype == "session_start":
                try:
                    profile = CharacterProfile.model_validate(payload.get("profile") or {})
                except Exception as ex:
                    await ws.send_json({"type": "error", "payload": {"message": f"角色参数无效: {ex}"}})
                    continue
                base_id = str(payload.get("base_id") or "")
                save_id = payload.get("save_id")
                user_id = str(payload.get("user_id") or "").strip() or "default"
                if user_id != "default" and not get_user(user_id):
                    await ws.send_json({"type": "error", "payload": {"message": "用户无效，请重新登录"}})
                    continue
                if user_id == "default":
                    await ws.send_json({"type": "error", "payload": {"message": "请先登录后再开始游戏"}})
                    continue
                if save_id and user_id != "default":
                    owned = get_save_for_user(str(save_id), user_id)
                    if not owned:
                        await ws.send_json({"type": "error", "payload": {"message": "存档不存在或无权读取"}})
                        continue
                if not profile.character_id.strip():
                    cid = str(payload.get("character_id") or "")
                    if cid:
                        profile = profile.model_copy(update={"character_id": cid})
                session = create_session(
                    profile,
                    base_id=base_id,
                    save_id=str(save_id) if save_id else None,
                    user_id=user_id,
                )
                opening = session.messages[0]["content"]
                parsed = parse_character_reply(opening)
                voice = resolve_voice(profile)
                created_pl: dict[str, Any] = {
                    "session_id": session.id,
                    "save_id": session.save_id,
                    "greeting": opening,
                    "avatar": parsed,
                    "profile": session.profile.model_dump(),
                    "relationship_state": session.relationship_state.model_dump(),
                    "memories": [m.model_dump() for m in session.memories],
                    "scene": resolve_scene(
                        base_id=base_id,
                        stage_id=session.relationship_state.stage_id,
                    ),
                    "daily_state": session.to_public().get("daily_state"),
                    "daily_encounters": session.to_public().get("daily_encounters"),
                    "quest_state": session.to_public().get("quest_state"),
                    "tts_voice": voice,
                }
                if api_key(settings) and settings.companion_tts_enabled:
                    try:
                        tts_pl = await asyncio.to_thread(
                            synthesize_greeting_tts, settings, profile, opening
                        )
                        created_pl.update(tts_pl)
                    except Exception as ex:
                        logger.warning("greeting TTS failed: %s", ex)
                        created_pl["tts_error"] = str(ex)
                await ws.send_json({"type": "session_created", "payload": created_pl})
                if created_pl.get("tts_audio_b64"):
                    await ws.send_json(
                        {
                            "type": "tts_audio",
                            "payload": {
                                "mime": created_pl.get("tts_mime", "audio/wav"),
                                "base64": created_pl["tts_audio_b64"],
                                "voice": voice,
                            },
                        }
                    )
                elif created_pl.get("tts_browser_text"):
                    await ws.send_json(
                        {
                            "type": "tts_browser",
                            "payload": {"text": created_pl["tts_browser_text"], "voice": voice},
                        }
                    )
                elif created_pl.get("tts_error"):
                    await ws.send_json(
                        {"type": "tts_error", "payload": {"message": created_pl["tts_error"]}}
                    )
                continue

            if mtype == "reset":
                sid = str(payload.get("session_id") or "")
                session = store.reset(sid)
                if not session:
                    await ws.send_json({"type": "error", "payload": {"message": "会话不存在"}})
                    continue
                opening = session.messages[0]["content"]
                parsed = parse_character_reply(opening)
                await ws.send_json(
                    {
                        "type": "session_reset",
                        "payload": {
                            "session_id": sid,
                            "greeting": opening,
                            "avatar": parsed,
                            "relationship_state": session.relationship_state.model_dump(),
                            "memories": [m.model_dump() for m in session.memories],
                        },
                    }
                )
                continue

            if mtype == "daily_encounter":
                sid = str(payload.get("session_id") or "")
                enc_id = str(payload.get("encounter_id") or "")
                result = await asyncio.to_thread(store.start_daily_encounter, sid, enc_id)
                if not result:
                    await ws.send_json({"type": "error", "payload": {"message": "会话不存在"}})
                    continue
                if result.get("error"):
                    await ws.send_json({"type": "error", "payload": {"message": result["error"]}})
                    continue
                await ws.send_json({"type": "daily_encounter_started", "payload": result})
                if result.get("scene"):
                    await ws.send_json({"type": "game_scene", "payload": result["scene"]})
                continue

            if mtype != "chat":
                await ws.send_json({"type": "error", "payload": {"message": f"未知 type: {mtype}"}})
                continue

            sid = str(payload.get("session_id") or "")
            text = str(payload.get("text") or "").strip()
            choice_raw = payload.get("choice_index")
            choice_index: int | None = None
            if choice_raw is not None and choice_raw != "":
                try:
                    choice_index = int(choice_raw)
                except (TypeError, ValueError):
                    choice_index = None
            if not text:
                await ws.send_json({"type": "error", "payload": {"message": "消息为空"}})
                continue
            if not api_key(settings):
                await ws.send_json({"type": "error", "payload": {"message": "未配置 DASHSCOPE_API_KEY"}})
                continue

            await ws.send_json({"type": "reply_start", "payload": {"session_id": sid}})
            loop = asyncio.get_running_loop()
            outbound: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()

            def on_delta(delta: str, full: str) -> None:
                loop.call_soon_threadsafe(
                    outbound.put_nowait,
                    ("reply_delta", {"delta": delta, "text": full}),
                )

            async def forward() -> None:
                while True:
                    event, pl = await outbound.get()
                    await ws.send_json({"type": event, "payload": pl})
                    if event == "_stop":
                        return

            forwarder = asyncio.create_task(forward())

            def work() -> dict[str, Any]:
                try:
                    return run_chat_turn(
                        settings,
                        session_id=sid,
                        user_text=text,
                        choice_index=choice_index,
                        on_delta=on_delta,
                    )
                except Exception as ex:
                    return {"error": str(ex)}

            result = await asyncio.to_thread(work)
            loop.call_soon_threadsafe(outbound.put_nowait, ("_stop", {}))
            await forwarder

            if result.get("error"):
                await ws.send_json({"type": "error", "payload": {"message": result["error"]}})
                continue

            parsed = result.get("parsed") or {}
            if parsed.get("choices"):
                parsed = {**parsed, "choices": parsed["choices"]}
            await ws.send_json(
                {
                    "type": "reply",
                    "payload": {
                        "text": result.get("reply_raw", ""),
                        "spoken": parsed.get("spoken", ""),
                        "avatar": parsed,
                        "choices": parsed.get("choices") or [],
                        "speaker_id": parsed.get("speaker_id") or "",
                        "guest_reaction": parsed.get("guest_reaction") or "",
                        "ensemble": (
                            (store.get(sid).ensemble if store.get(sid) else None)
                            if sid
                            else None
                        ),
                    },
                }
            )
            await ws.send_json({"type": "avatar_state", "payload": parsed})
            if parsed.get("choices"):
                await ws.send_json(
                    {
                        "type": "choices",
                        "payload": {
                            "choices": parsed["choices"],
                            "kind": (result.get("relationship_update") or {}).get(
                                "pending_choice_kind"
                            )
                            or "soft",
                        },
                    }
                )
            rel_update = result.get("relationship_update")
            if rel_update:
                await ws.send_json({"type": "relationship_state", "payload": rel_update})
                if rel_update.get("scene"):
                    await ws.send_json({"type": "game_scene", "payload": rel_update["scene"]})
                if rel_update.get("daily_state"):
                    await ws.send_json({"type": "daily_state", "payload": rel_update["daily_state"]})
                if rel_update.get("quest_notice"):
                    await ws.send_json(
                        {"type": "quest_toast", "payload": {"message": rel_update["quest_notice"]}}
                    )
                if rel_update.get("aux_notice"):
                    await ws.send_json(
                        {
                            "type": "system_toast",
                            "payload": {
                                "message": rel_update["aux_notice"].get("message")
                                or "后台能力降级",
                                "code": rel_update["aux_notice"].get("code") or "",
                                "tone": rel_update["aux_notice"].get("tone") or "warn",
                            },
                        }
                    )
                if rel_update.get("scene_ended"):
                    await ws.send_json(
                        {
                            "type": "scene_ended",
                            "payload": {
                                "ok": True,
                                "end_reason": rel_update.get("end_reason") or "turns_exhausted",
                                "closing_line": rel_update.get("closing_line"),
                                "settle_note": rel_update.get("settle_note"),
                                "affinity_delta": rel_update.get("affinity_delta"),
                                "trust_delta": rel_update.get("trust_delta"),
                                "stage_changed": rel_update.get("stage_changed"),
                                "previous_stage_id": rel_update.get("previous_stage_id"),
                                "relationship_state": rel_update.get("relationship_state"),
                                "scene_run": rel_update.get("scene_run"),
                                "hub": rel_update.get("hub"),
                                "world": rel_update.get("world"),
                            },
                        }
                    )
                if rel_update.get("event"):
                    await ws.send_json({"type": "event_toast", "payload": rel_update["event"]})
                if rel_update.get("ending"):
                    await ws.send_json({"type": "game_ending", "payload": rel_update["ending"]})
            # 先结束等待态，TTS 不挡下一句输入
            await ws.send_json({"type": "done", "payload": {}})

            tts_pl = await asyncio.to_thread(synthesize_turn_tts, settings, result)
            if tts_pl.get("tts_audio_b64"):
                await ws.send_json(
                    {
                        "type": "tts_audio",
                        "payload": {
                            "mime": tts_pl.get("tts_mime", "audio/wav"),
                            "base64": tts_pl["tts_audio_b64"],
                            "voice": tts_pl.get("tts_voice", ""),
                        },
                    }
                )
            elif tts_pl.get("tts_browser_text"):
                await ws.send_json(
                    {
                        "type": "tts_browser",
                        "payload": {
                            "text": tts_pl["tts_browser_text"],
                            "voice": tts_pl.get("tts_voice", ""),
                        },
                    }
                )
            elif tts_pl.get("tts_error") and settings.companion_tts_enabled:
                if settings.companion_tts_fallback == "browser":
                    spoken = str(parsed.get("spoken") or result.get("reply_raw") or "")
                    if spoken.strip():
                        await ws.send_json(
                            {"type": "tts_browser", "payload": {"text": spoken.strip()}}
                        )
                    else:
                        await ws.send_json(
                            {"type": "tts_error", "payload": {"message": str(tts_pl["tts_error"])}}
                        )
                else:
                    await ws.send_json(
                        {"type": "tts_error", "payload": {"message": str(tts_pl["tts_error"])}}
                    )

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")


def _mount_static() -> None:
    if not _frontend_dist.is_dir():
        return
    assets = _frontend_dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="frontend_assets")
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")


_mount_static()
