from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import bgm as bgm_mod
from . import campus_engine
from . import sprites as sprites_mod
from .campus_store import store
from .config import data_dir, frontend_dist, is_desktop

app = FastAPI(title="Campus_Agent", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class NewGameBody(BaseModel):
    name: str = ""
    grade_tier: str = Field(..., min_length=1)
    mbti: str = Field(..., min_length=1)


class TravelBody(BaseModel):
    location_id: str = Field(..., min_length=1)


class StudyBody(BaseModel):
    subject_id: str = Field(..., min_length=1)


class TalkBody(BaseModel):
    target_id: str = Field(..., min_length=1)


class ChatBody(BaseModel):
    target_id: str = Field(..., min_length=1)
    text: str = Field(..., min_length=1)
    verb: str | None = None


class InteractBody(BaseModel):
    target_id: str = Field(..., min_length=1)
    verb: str = Field(..., min_length=1)
    text: str | None = None


class AskOutBody(BaseModel):
    target_id: str = Field(..., min_length=1)
    location_id: str = Field(..., min_length=1)


class ManualSaveBody(BaseModel):
    slot: int = Field(..., ge=1, le=10)
    title: str | None = None


class LoadSaveBody(BaseModel):
    save_id: str = Field(..., min_length=1)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "Campus_Agent",
        "has_save": store.active is not None,
        "desktop": is_desktop(),
    }


@app.get("/api/campus/meta")
def campus_meta() -> dict[str, Any]:
    return campus_engine.meta_public()


@app.post("/api/campus/new")
def campus_new(body: NewGameBody) -> dict[str, Any]:
    try:
        return campus_engine.create_new(
            name=body.name,
            grade_tier=body.grade_tier,
            mbti=body.mbti.upper(),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/api/campus/hub")
def campus_hub() -> dict[str, Any]:
    try:
        save = store.require_active()
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    return campus_engine.hub_public(save)


@app.post("/api/campus/travel")
def campus_travel(body: TravelBody) -> dict[str, Any]:
    try:
        return campus_engine.travel(body.location_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/advance")
def campus_advance() -> dict[str, Any]:
    try:
        return campus_engine.advance_period()
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e


class AdvanceSkipBody(BaseModel):
    max_steps: int | None = Field(default=None, ge=1, le=12)


@app.post("/api/campus/advance_skip")
def campus_advance_skip(body: AdvanceSkipBody = AdvanceSkipBody()) -> dict[str, Any]:
    try:
        return campus_engine.advance_until_actionable(max_steps=body.max_steps)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e


@app.post("/api/campus/study")
def campus_study(body: StudyBody) -> dict[str, Any]:
    try:
        return campus_engine.study(subject_id=body.subject_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/talk/prepare")
def campus_talk_prepare(body: TalkBody) -> dict[str, Any]:
    try:
        return campus_engine.prepare_talk(body.target_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/chat")
def campus_chat(body: ChatBody) -> dict[str, Any]:
    try:
        return campus_engine.chat_turn(target_id=body.target_id, text=body.text, verb=body.verb)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/interact")
def campus_interact(body: InteractBody) -> dict[str, Any]:
    try:
        return campus_engine.interact(target_id=body.target_id, verb=body.verb, text=body.text)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/club")
def campus_club() -> dict[str, Any]:
    try:
        return campus_engine.club_activity()
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


class SpotBody(BaseModel):
    action_id: str | None = None
    focus_id: str | None = None


@app.post("/api/campus/spot")
def campus_spot(body: SpotBody = SpotBody()) -> dict[str, Any]:
    try:
        return campus_engine.spot_activity(action_id=body.action_id, focus_id=body.focus_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/ask_out")
def campus_ask_out(body: AskOutBody) -> dict[str, Any]:
    try:
        return campus_engine.ask_out(target_id=body.target_id, location_id=body.location_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/weekend_roam")
def campus_weekend_roam() -> dict[str, Any]:
    try:
        return campus_engine.weekend_roam()
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/mock_exam")
def campus_mock_exam() -> dict[str, Any]:
    try:
        return campus_engine.run_mock_exam()
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e


@app.get("/api/campus/board")
def campus_board() -> dict[str, Any]:
    try:
        return campus_engine.board_public()
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e


@app.get("/api/campus/saves")
def campus_saves() -> dict[str, Any]:
    return {"saves": store.list_saves()}


@app.post("/api/campus/saves/manual")
def campus_manual_save(body: ManualSaveBody) -> dict[str, Any]:
    try:
        save = store.require_active()
        meta = store.persist(save, kind="manual", slot=body.slot, title=body.title)
        return {"ok": True, **meta}
    except LookupError as e:
        raise HTTPException(status_code=404, detail="no_active_save") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/campus/saves/load")
def campus_load(body: LoadSaveBody) -> dict[str, Any]:
    try:
        save = store.load_save(body.save_id)
        return campus_engine.hub_public(save)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="save_not_found") from e


@app.delete("/api/campus/saves/{save_id}")
def campus_delete_save(save_id: str) -> dict[str, Any]:
    ok = store.delete_save(save_id)
    if not ok:
        raise HTTPException(status_code=404, detail="save_not_found")
    return {"ok": True}


@app.get("/api/campus/sprite/{student_id}")
def campus_sprite(
    student_id: str,
    emotion: str = "neutral",
    action: str = "stand",
    outfit: str = "summer",
    kind: str = "sprite",
) -> dict[str, Any]:
    if kind == "q":
        return sprites_mod.resolve_q_sprite(student_id, emotion=emotion, action=action)
    return sprites_mod.resolve_student_sprite(student_id, outfit=outfit, action=action, emotion=emotion)


@app.get("/api/campus/bgm/catalog")
def campus_bgm_catalog() -> dict[str, Any]:
    return bgm_mod.public_bgm_catalog()


@app.get("/api/campus/bgm/{track_id}")
def campus_bgm_track(track_id: str) -> FileResponse:
    path = bgm_mod.resolve_bgm_file(track_id)
    if not path:
        raise HTTPException(status_code=404, detail="bgm_not_found")
    return FileResponse(path)


@app.get("/api/campus/assets/{asset_path:path}")
def campus_asset(asset_path: str) -> FileResponse:
    root = data_dir().resolve()
    path = (root / asset_path).resolve()
    if not str(path).startswith(str(root)) or not path.is_file():
        raise HTTPException(status_code=404, detail="asset_not_found")
    return FileResponse(path)


@app.websocket("/ws")
async def campus_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "detail": "invalid_json"})
                continue
            mtype = msg.get("type")
            try:
                if mtype == "enter_talk":
                    data = campus_engine.prepare_talk(str(msg.get("target_id", "")))
                    await ws.send_json({"type": "talk_ready", **data})
                elif mtype == "chat":
                    data = campus_engine.chat_turn(
                        target_id=str(msg.get("target_id", "")),
                        text=str(msg.get("text", "")),
                        verb=str(msg["verb"]) if msg.get("verb") else None,
                    )
                    await ws.send_json({"type": "chat_result", **data})
                elif mtype == "interact":
                    data = campus_engine.interact(
                        target_id=str(msg.get("target_id", "")),
                        verb=str(msg.get("verb", "")),
                        text=str(msg["text"]) if msg.get("text") else None,
                    )
                    await ws.send_json({"type": "chat_result", **data})
                elif mtype == "club":
                    data = campus_engine.club_activity()
                    await ws.send_json({"type": "hub", **data})
                elif mtype == "ping":
                    await ws.send_json({"type": "pong"})
                else:
                    await ws.send_json({"type": "error", "detail": f"unknown_type:{mtype}"})
            except (LookupError, ValueError) as e:
                await ws.send_json({"type": "error", "detail": str(e)})
    except WebSocketDisconnect:
        return


_dist = frontend_dist()
if _dist and _dist.is_dir():
    assets = _dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_dist / "index.html")

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str) -> FileResponse:
        candidate = _dist / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
