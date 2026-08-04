"""SQLite 持久存档：GameSave CRUD。"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .character import CharacterProfile
from .config import PROJECT_ROOT, get_settings, user_db_dir
from .memory import MemoryFact, merge_memories, public_memories
from .relationship import RelationshipState, init_relationship_state, public_relationship_state


def _db_path() -> Path:
    return user_db_dir() / "companion_save.db"


class GameRuntime(BaseModel):
    affinity: int = Field(50, ge=0, le=100)
    trust: int = Field(70, ge=0, le=100)
    mood: int = Field(0, ge=-100, le=100)
    stage_id: str = "dating"
    flags: dict[str, bool] = Field(default_factory=dict)
    counters: dict[str, int] = Field(default_factory=dict)
    unlocked_endings: list[str] = Field(default_factory=list)
    active_quest_id: str | None = None
    day_index: int = 0
    low_streak: int = 0
    action_points: int = 3
    action_points_max: int = 3
    last_play_date: str = ""
    daily_encounter_id: str | None = None
    daily_encounters_done: list[str] = Field(default_factory=list)
    quest_steps_done: list[str] = Field(default_factory=list)
    # 单机存档：专属故事幕进度（与 BondShelf 对称）
    story_event_id: str = ""
    story_beat_index: int = 0
    story_act_summary: str = ""


class GameSave(BaseModel):
    save_id: str
    user_id: str = "default"
    tenant_id: str = "default"
    character_id: str
    base_id: str = ""
    profile: CharacterProfile
    runtime: GameRuntime = Field(default_factory=GameRuntime)
    relationship_state: RelationshipState
    memories_l2: list[MemoryFact] = Field(default_factory=list)
    message_summary: str = ""
    messages: list[dict[str, str]] = Field(default_factory=list)
    updated_at: str = ""


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS game_saves (
                save_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                character_id TEXT NOT NULL,
                base_id TEXT NOT NULL DEFAULT '',
                profile_json TEXT NOT NULL,
                runtime_json TEXT NOT NULL,
                relationship_json TEXT NOT NULL,
                memories_json TEXT NOT NULL DEFAULT '[]',
                message_summary TEXT NOT NULL DEFAULT '',
                messages_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            )
            """
        )
        cols = {r[1] for r in conn.execute("PRAGMA table_info(game_saves)").fetchall()}
        if "tenant_id" not in cols:
            conn.execute(
                "ALTER TABLE game_saves ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_saves_user ON game_saves(user_id, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_saves_tenant_user ON game_saves(tenant_id, user_id, updated_at DESC)"
        )
        conn.commit()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _runtime_from_relationship(rel: RelationshipState, *, trust: int = 70) -> GameRuntime:
    return GameRuntime(
        affinity=rel.affinity,
        trust=trust,
        stage_id=rel.stage_id,
    )


def _sync_runtime_to_relationship(runtime: GameRuntime, rel: RelationshipState) -> RelationshipState:
    return rel.model_copy(
        update={
            "affinity": runtime.affinity,
            "stage_id": runtime.stage_id,
        }
    )


def create_save(
    profile: CharacterProfile,
    *,
    user_id: str = "default",
    tenant_id: str = "default",
    character_id: str = "",
    base_id: str = "",
) -> GameSave:
    init_db()
    cid = (character_id or profile.character_id or "").strip()
    rel = init_relationship_state(profile, character_id=cid, base_id=base_id)
    settings = get_settings()
    ap_max = int(settings.companion_daily_ap_max or 3)
    runtime = _runtime_from_relationship(rel)
    runtime = runtime.model_copy(update={"action_points": ap_max, "action_points_max": ap_max})
    sid = uuid.uuid4().hex[:16]
    save = GameSave(
        save_id=sid,
        user_id=user_id,
        tenant_id=(tenant_id or "default").strip() or "default",
        character_id=cid,
        base_id=base_id,
        profile=profile,
        runtime=runtime,
        relationship_state=rel,
        updated_at=_now_iso(),
    )
    upsert_save(save)
    return save


def upsert_save(save: GameSave) -> None:
    init_db()
    save.updated_at = _now_iso()
    tid = (save.tenant_id or "default").strip() or "default"
    save.tenant_id = tid
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO game_saves (
                save_id, user_id, tenant_id, character_id, base_id,
                profile_json, runtime_json, relationship_json,
                memories_json, message_summary, messages_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(save_id) DO UPDATE SET
                user_id=excluded.user_id,
                tenant_id=excluded.tenant_id,
                profile_json=excluded.profile_json,
                runtime_json=excluded.runtime_json,
                relationship_json=excluded.relationship_json,
                memories_json=excluded.memories_json,
                message_summary=excluded.message_summary,
                messages_json=excluded.messages_json,
                updated_at=excluded.updated_at
            """,
            (
                save.save_id,
                save.user_id,
                tid,
                save.character_id,
                save.base_id,
                save.profile.model_dump_json(),
                save.runtime.model_dump_json(),
                save.relationship_state.model_dump_json(),
                json.dumps([m.model_dump() for m in save.memories_l2], ensure_ascii=False),
                save.message_summary,
                json.dumps(save.messages, ensure_ascii=False),
                save.updated_at,
            ),
        )
        conn.commit()


def get_save(save_id: str) -> GameSave | None:
    init_db()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM game_saves WHERE save_id = ?", (save_id,)
        ).fetchone()
    if not row:
        return None
    return _row_to_save(row)


def list_saves(user_id: str = "default", tenant_id: str = "default") -> list[dict[str, Any]]:
    init_db()
    tid = (tenant_id or "default").strip() or "default"
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT save_id, user_id, tenant_id, character_id, base_id, profile_json,
                   relationship_json, updated_at
            FROM game_saves WHERE user_id = ? AND tenant_id = ?
            ORDER BY updated_at DESC
            """,
            (user_id, tid),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        profile = json.loads(row["profile_json"])
        rel = json.loads(row["relationship_json"])
        out.append(
            {
                "save_id": row["save_id"],
                "user_id": row["user_id"],
                "tenant_id": row["tenant_id"] if "tenant_id" in row.keys() else tid,
                "character_id": row["character_id"],
                "base_id": row["base_id"],
                "character_name": profile.get("name", ""),
                "route_label": profile.get("relationship", ""),
                "stage_label": rel.get("stage_label", ""),
                "affinity": rel.get("affinity", 0),
                "updated_at": row["updated_at"],
            }
        )
    return out


def delete_save(
    save_id: str, *, user_id: str | None = None, tenant_id: str | None = None
) -> bool:
    init_db()
    tid = (tenant_id or "default").strip() or "default" if tenant_id is not None else None
    with _connect() as conn:
        if user_id and tid is not None:
            cur = conn.execute(
                "DELETE FROM game_saves WHERE save_id = ? AND user_id = ? AND tenant_id = ?",
                (save_id, user_id, tid),
            )
        elif user_id:
            cur = conn.execute(
                "DELETE FROM game_saves WHERE save_id = ? AND user_id = ?",
                (save_id, user_id),
            )
        else:
            cur = conn.execute("DELETE FROM game_saves WHERE save_id = ?", (save_id,))
        conn.commit()
        return cur.rowcount > 0


def get_save_for_user(
    save_id: str, user_id: str, tenant_id: str | None = None
) -> GameSave | None:
    save = get_save(save_id)
    if not save or save.user_id != user_id:
        return None
    if tenant_id is not None:
        tid = (tenant_id or "default").strip() or "default"
        if (save.tenant_id or "default") != tid:
            return None
    return save


def _row_to_save(row: sqlite3.Row) -> GameSave:
    rel = RelationshipState.model_validate(json.loads(row["relationship_json"]))
    runtime = GameRuntime.model_validate(json.loads(row["runtime_json"]))
    memories_raw = json.loads(row["memories_json"] or "[]")
    messages = json.loads(row["messages_json"] or "[]")
    keys = row.keys()
    tid = row["tenant_id"] if "tenant_id" in keys else "default"
    return GameSave(
        save_id=row["save_id"],
        user_id=row["user_id"],
        tenant_id=tid or "default",
        character_id=row["character_id"],
        base_id=row["base_id"] or "",
        profile=CharacterProfile.model_validate(json.loads(row["profile_json"])),
        runtime=runtime,
        relationship_state=rel,
        memories_l2=[MemoryFact.model_validate(m) for m in memories_raw],
        message_summary=row["message_summary"] or "",
        messages=messages,
        updated_at=row["updated_at"],
    )


def save_to_public(save: GameSave) -> dict[str, Any]:
    return {
        "save_id": save.save_id,
        "user_id": save.user_id,
        "tenant_id": save.tenant_id,
        "character_id": save.character_id,
        "base_id": save.base_id,
        "profile": save.profile.model_dump(),
        "runtime": save.runtime.model_dump(),
        "relationship_state": public_relationship_state(save.relationship_state),
        "memories": public_memories(save.memories_l2),
        "message_summary": save.message_summary,
        "turns": len([m for m in save.messages if m.get("role") == "user"]),
        "updated_at": save.updated_at,
    }


def apply_turn_to_save(
    save: GameSave,
    *,
    user_text: str,
    assistant_text: str,
    relationship_state: RelationshipState,
    memories: list[MemoryFact],
    runtime_patch: dict[str, Any] | None = None,
    messages: list[dict[str, str]] | None = None,
    message_summary: str | None = None,
) -> GameSave:
    save.relationship_state = relationship_state
    save.runtime = save.runtime.model_copy(
        update={
            "affinity": relationship_state.affinity,
            "stage_id": relationship_state.stage_id,
            **(runtime_patch or {}),
        }
    )
    save.memories_l2 = merge_memories(save.memories_l2, memories)
    if messages is not None:
        save.messages = messages
    if message_summary is not None:
        save.message_summary = message_summary
    upsert_save(save)
    return save
