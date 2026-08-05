"""SQLite campus saves + in-memory active session."""

from __future__ import annotations

import copy
import json
import sqlite3
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Literal

from .config import save_db_path

SaveKind = Literal["auto", "manual"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@dataclass
class CampusSave:
    save_id: str
    day_index: int
    weekday: int
    day_kind: str
    period_id: str
    weather_id: str
    location_id: str
    protagonist: dict[str, Any]
    students: list[dict[str, Any]]
    seating: list[dict[str, Any]] = field(default_factory=list)
    scores: dict[str, dict[str, float]] = field(default_factory=dict)
    edges: list[dict[str, Any]] = field(default_factory=list)
    memories: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    locations_now: dict[str, str] = field(default_factory=dict)
    chat_actions_left: int = 3
    note_actions_left: int = 2
    active_event: dict[str, Any] | None = None
    last_mock: dict[str, Any] | None = None
    pending_intents: list[dict[str, Any]] = field(default_factory=list)
    talk_log: list[dict[str, str]] = field(default_factory=list)
    # student_id -> {mood, thought, event_take, updated_day, updated_period}
    npc_minds: dict[str, dict[str, Any]] = field(default_factory=dict)
    # D-0 高考结算后为 True；ending 为结算 payload
    ended: bool = False
    ending: dict[str, Any] | None = None
    # invite stick: student_id -> {location_id, ttl} — force location for ttl refreshes
    invite_stick: dict[str, dict[str, Any]] = field(default_factory=dict)
    # club activity used this period (reset on free/free_day action refill)
    club_action_used: bool = False
    # location spot action used this period (playground/cafeteria/…)
    spot_action_used: bool = False
    # weekend date short scene: {target_id, location_id} while period lasts
    active_date: dict[str, Any] | None = None
    # last social tick blurbs (NPC↔NPC), for period_recap / board
    world_events: list[dict[str, Any]] = field(default_factory=list)
    title: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CampusSave:
        known = {f.name for f in fields(cls)}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)


class CampusStore:
    def __init__(self) -> None:
        self._active: CampusSave | None = None
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        path = save_db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS campus_saves (
                  save_id TEXT PRIMARY KEY,
                  kind TEXT NOT NULL,
                  slot INTEGER,
                  title TEXT NOT NULL DEFAULT '',
                  updated_at TEXT NOT NULL,
                  payload TEXT NOT NULL
                )
                """
            )
            conn.commit()

    @property
    def active(self) -> CampusSave | None:
        return self._active

    def require_active(self) -> CampusSave:
        if self._active is None:
            raise LookupError("no_active_save")
        return self._active

    def set_active(self, save: CampusSave) -> CampusSave:
        self._active = save
        return save

    def clear(self) -> None:
        self._active = None

    def persist(
        self,
        save: CampusSave,
        *,
        kind: SaveKind = "auto",
        slot: int | None = None,
        title: str | None = None,
    ) -> dict[str, Any]:
        save.updated_at = _now_iso()
        if title:
            save.title = title
        elif not save.title:
            save.title = f"{save.protagonist.get('name', '主角')} · D-{101 - save.day_index}"
        payload = json.dumps(save.to_dict(), ensure_ascii=False)
        with self._connect() as conn:
            if kind == "auto":
                conn.execute("DELETE FROM campus_saves WHERE kind = 'auto'")
                conn.execute(
                    "INSERT INTO campus_saves (save_id, kind, slot, title, updated_at, payload) VALUES (?,?,?,?,?,?)",
                    (save.save_id, "auto", None, save.title, save.updated_at, payload),
                )
            else:
                if slot is None:
                    raise ValueError("manual_slot_required")
                row = conn.execute(
                    "SELECT save_id FROM campus_saves WHERE kind='manual' AND slot=?",
                    (slot,),
                ).fetchone()
                # manual slots use their own save_id (PK cannot share auto id)
                sid = row["save_id"] if row else new_save_id()
                snap = CampusSave.from_dict(save.to_dict())
                snap.save_id = sid
                snap.updated_at = save.updated_at
                snap.title = save.title
                payload = json.dumps(snap.to_dict(), ensure_ascii=False)
                conn.execute("DELETE FROM campus_saves WHERE kind='manual' AND slot=?", (slot,))
                conn.execute(
                    "INSERT INTO campus_saves (save_id, kind, slot, title, updated_at, payload) VALUES (?,?,?,?,?,?)",
                    (sid, "manual", slot, snap.title, snap.updated_at, payload),
                )
                conn.commit()
                return {
                    "save_id": sid,
                    "kind": kind,
                    "slot": slot,
                    "title": snap.title,
                    "updated_at": snap.updated_at,
                }
            conn.commit()
        return {
            "save_id": save.save_id,
            "kind": kind,
            "slot": slot,
            "title": save.title,
            "updated_at": save.updated_at,
        }

    def list_saves(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT save_id, kind, slot, title, updated_at, payload FROM campus_saves ORDER BY updated_at DESC"
            ).fetchall()
        out = []
        for r in rows:
            cover = {}
            try:
                data = json.loads(r["payload"])
                cover = {
                    "day_index": data.get("day_index"),
                    "weather_id": data.get("weather_id"),
                    "period_id": data.get("period_id"),
                    "protagonist_name": (data.get("protagonist") or {}).get("name"),
                    "days_left": 101 - int(data.get("day_index") or 1),
                }
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
            out.append(
                {
                    "save_id": r["save_id"],
                    "kind": r["kind"],
                    "slot": r["slot"],
                    "title": r["title"],
                    "updated_at": r["updated_at"],
                    "cover": cover,
                }
            )
        return out

    def load_save(self, save_id: str) -> CampusSave:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM campus_saves WHERE save_id=?", (save_id,)
            ).fetchone()
        if not row:
            raise LookupError("save_not_found")
        data = json.loads(row["payload"])
        save = CampusSave.from_dict(data)
        self._active = save
        return save

    def delete_save(self, save_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM campus_saves WHERE save_id=?", (save_id,))
            conn.commit()
            return cur.rowcount > 0


store = CampusStore()


def new_save_id() -> str:
    return uuid.uuid4().hex[:12]


def clone_students(template: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return copy.deepcopy(template)
