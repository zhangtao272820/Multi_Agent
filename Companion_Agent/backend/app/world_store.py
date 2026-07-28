"""世界存档：同一档全员 BondShelf + 日历日 + 回退检查点。"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .character import CharacterProfile, load_character_bases
from .config import PROJECT_ROOT, get_settings, user_db_dir
from .memory import MemoryFact
from .relationship import RelationshipState, init_relationship_state
from .social_graph import CharacterSocialDef, load_social_graph


def _db_path() -> Path:
    return user_db_dir() / "companion_save.db"


class CalendarState(BaseModel):
    day_index: int = 1
    weekday: int = 1  # 1=周一 … 7=周日
    period: str = "morning"  # morning|afternoon|evening|night


class DialogueTurn(BaseModel):
    turn_id: int
    role: str
    content: str
    ts: str = ""


class Preferences(BaseModel):
    likes: list[str] = Field(default_factory=list)
    dislikes: list[str] = Field(default_factory=list)
    habits: list[str] = Field(default_factory=list)


class BondLiving(BaseModel):
    """运行时「活人」状态：日终日志、主动消息、当日情绪基调。"""

    fatigue: int = Field(0, ge=0, le=100)
    last_offscreen_note: str = ""
    pending_ping: str = ""
    # P7：invite | drama | soft（空=普通）
    pending_ping_kind: str = ""
    day_mood_base: int | None = None
    day_mood_day: int = 0
    outfit_id: str = ""
    talked_day_index: int = 0
    # 当日接触场次（talk/date 计入；跨日由 ensure_scene_day_counter 重置）
    scenes_day_index: int = 0
    scenes_today: int = 0
    # 当日送礼次数（同角色每日上限 1）
    gift_day_index: int = 0
    gifts_today: int = 0
    # P2：长期状态（空串=无）；until 为世界 day_index（含当日）
    long_status: str = ""  # sick | exam_week | trip
    long_status_until_day: int = 0
    # P4：独处日记 / 恋爱时间锚 / 周回顾
    diary_lines: list[str] = Field(default_factory=list)
    first_met_day: int = 0
    first_date_day: int = 0
    last_week_review: str = ""
    # P7：爽约后 soft cold（until 含当日）
    soft_cold_until_day: int = 0
    # P10：闺蜜局 — 当晚 evening/night 不出场（= day_index）
    busy_tonight_day: int = 0


class WorldRumor(BaseModel):
    """小镇软传闻（不对玩家甩攻略数字）。"""

    day: int = 1
    about_id: str = ""
    text: str = ""
    source_id: str = ""


class WorldAppointment(BaseModel):
    """未来约会预约（锋利时间）。"""

    id: str = ""
    character_id: str = ""
    day_index: int = 1
    period: str = "evening"  # morning|afternoon|evening|night
    location_id: str = ""
    label: str = ""
    date_id: str = ""
    # date = 目录约会；talk = 普通谈话见面（无 date_id）
    kind: str = "date"
    status: str = "pending"  # pending|done|missed|cancelled


class WorldErrand(BaseModel):
    """共同待办：帮她办事（轻 quest）。"""

    id: str = ""
    errand_id: str = ""
    character_id: str = ""
    label: str = ""
    location_id: str = ""
    day_assigned: int = 1
    status: str = "pending"  # pending|done|expired
    ask_line: str = ""


class ProtagonistLife(BaseModel):
    """男主现实参数：职业、可见钱包、体力与当日生活计数。"""

    job_id: str = "office_junior"
    job_title: str = "普通公司职员"
    workplace_id: str = "office"
    money: int = 2800
    energy: int = Field(80, ge=0, le=100)
    worked_day_index: int = 0
    meals_today: int = 0
    # P7：当日简报计数（跨日由 ensure_day_counters / end_day 重置）
    brief_day: int = 0
    travels_today: int = 0
    spent_today: int = 0
    # P7：连续抠门约会计数
    stingy_date_streak: int = 0
    # P13：夜聊计数；日终若达标则标记次日简报日
    night_chat_turns: int = 0
    late_night_brief_day: int = 0


class BondShelf(BaseModel):
    character_id: str
    base_id: str = ""
    cast_kind: str = "romance"  # romance|neutral|npc
    social_role_to_pc: str = "陌生人"
    role_hint: str = ""
    profile: CharacterProfile
    relationship_state: RelationshipState
    preferences: Preferences = Field(default_factory=Preferences)
    memories: list[MemoryFact] = Field(default_factory=list)
    message_summary: str = ""
    messages: list[DialogueTurn] = Field(default_factory=list)
    next_turn_id: int = 1
    unlocked_endings: list[str] = Field(default_factory=list)
    living: BondLiving = Field(default_factory=BondLiving)


SaveKind = Literal["auto", "manual"]
MANUAL_SAVE_SOFT_LIMIT = 30


class WorldSave(BaseModel):
    save_id: str
    user_id: str
    kind: SaveKind = "auto"
    label: str = ""
    protagonist_name: str = "我"
    protagonist: ProtagonistLife = Field(default_factory=ProtagonistLife)
    calendar: CalendarState = Field(default_factory=CalendarState)
    action_points: int = 5
    action_points_max: int = 5
    world_flags: dict[str, bool] = Field(default_factory=dict)
    location_id: str = "home"
    bonds: dict[str, BondShelf] = Field(default_factory=dict)
    social_insight: dict[str, bool] = Field(default_factory=dict)
    rumors: list[WorldRumor] = Field(default_factory=list)
    appointments: list[WorldAppointment] = Field(default_factory=list)
    errands: list[WorldErrand] = Field(default_factory=list)
    unlocked_endings: list[str] = Field(default_factory=list)
    onboarding_step: str = "wake"
    # 本时段刚吃过饭时等于 calendar.period；推进时段 / 翻日后清空
    meal_context_period: str = ""
    updated_at: str = ""


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _normalize_kind(raw: Any) -> SaveKind:
    return "manual" if str(raw or "").strip().lower() == "manual" else "auto"


def _migrate_save_kinds(conn: sqlite3.Connection) -> None:
    """旧档无 kind / 0 或多条 auto → 每用户恰好一条 auto（最新），其余 manual。"""
    rows = conn.execute(
        "SELECT save_id, user_id, payload_json, updated_at FROM world_saves"
    ).fetchall()
    by_user: dict[str, list[tuple[str, str, str, WorldSave, bool]]] = {}
    for row in rows:
        try:
            raw = json.loads(row["payload_json"])
            save = WorldSave.model_validate(raw)
        except Exception:
            continue
        uid = str(row["user_id"] or save.user_id)
        missing_kind = "kind" not in raw
        by_user.setdefault(uid, []).append(
            (
                str(row["save_id"]),
                str(row["updated_at"] or save.updated_at or ""),
                str(row["payload_json"]),
                save,
                missing_kind,
            )
        )

    for uid, items in by_user.items():
        items.sort(key=lambda t: t[1], reverse=True)
        legacy = any(t[4] for t in items)
        autos = [t for t in items if not t[4] and _normalize_kind(t[3].kind) == "auto"]

        if legacy or len(autos) != 1:
            for i, (sid, _ts, _payload, save, _miss) in enumerate(items):
                new_kind: SaveKind = "auto" if i == 0 else "manual"
                updates: dict[str, Any] = {"kind": new_kind, "save_id": sid, "user_id": uid}
                if new_kind == "auto":
                    updates["label"] = ""
                save = save.model_copy(update=updates)
                conn.execute(
                    """
                    UPDATE world_saves
                    SET payload_json = ?, kind = ?, user_id = ?
                    WHERE save_id = ?
                    """,
                    (save.model_dump_json(), new_kind, uid, sid),
                )
        else:
            for sid, _ts, _payload, save, _miss in items:
                kind = _normalize_kind(save.kind)
                conn.execute(
                    "UPDATE world_saves SET kind = ?, user_id = ? WHERE save_id = ?",
                    (kind, uid, sid),
                )


def init_world_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS world_saves (
                save_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'auto'
            )
            """
        )
        cols = _table_columns(conn, "world_saves")
        if "kind" not in cols:
            conn.execute(
                "ALTER TABLE world_saves ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_world_saves_user ON world_saves(user_id, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_world_saves_user_kind ON world_saves(user_id, kind)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bond_checkpoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                save_id TEXT NOT NULL,
                character_id TEXT NOT NULL,
                turn_id INTEGER NOT NULL,
                bond_json TEXT NOT NULL,
                UNIQUE(save_id, character_id, turn_id)
            )
            """
        )
        _migrate_save_kinds(conn)
        conn.commit()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clear_bond_checkpoints(save_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM bond_checkpoints WHERE save_id = ?", (save_id,))
        conn.commit()


def _profile_for_character(character_id: str, social: CharacterSocialDef) -> tuple[CharacterProfile, str]:
    bases = load_character_bases()
    for base in bases:
        if str(base.get("id") or "") != social.base_id:
            continue
        for row in base.get("characters") or []:
            if str(row.get("id") or "") != character_id:
                continue
            cast_role = social.cast_kind if social.cast_kind in {"romance", "neutral", "npc"} else "romance"
            prof = CharacterProfile.model_validate(
                {
                    **(row.get("profile") or {}),
                    "character_id": character_id,
                    "relationship": social.role_to_pc,
                    "cast_role": cast_role,
                }
            )
            return prof, str(base.get("id") or social.base_id)
    # fallback empty-ish
    cast_role = social.cast_kind if social.cast_kind in {"romance", "neutral", "npc"} else "romance"
    prof = CharacterProfile(
        character_id=character_id,
        name=character_id,
        relationship=social.role_to_pc,
        cast_role=cast_role,
    )
    return prof, social.base_id


def build_bond_from_social(character_id: str, social: CharacterSocialDef) -> BondShelf:
    profile, base_id = _profile_for_character(character_id, social)
    rel = init_relationship_state(profile, character_id=character_id, base_id=base_id)
    # 陌生人起手略低，熟人/恋人保留 profile.initial_affinity
    if social.role_to_pc in {"陌生人", "网友", "偶遇的旅人", "笔友"}:
        rel = rel.model_copy(update={"affinity": min(rel.affinity, 18), "trust": min(rel.trust, 40)})
    elif social.role_to_pc in {"前女友", "前妻"}:
        rel = rel.model_copy(
            update={
                "affinity": 40,
                "trust": 32,
                "stage_id": "acquaintance",
                "stage_label": "熟人",
                "user_title": "你",
            }
        )
    elif social.cast_kind in {"neutral", "npc"}:
        # 中立/NPC：关系再亲也不能走到恋爱阶段
        if rel.stage_id in {"crush", "dating", "married"}:
            rel = rel.model_copy(update={"stage_id": "close_friend", "stage_label": "挚友"})
    prefs = Preferences(
        likes=list(social.preferences.likes),
        dislikes=list(social.preferences.dislikes),
        habits=list(social.preferences.habits),
    )
    return BondShelf(
        character_id=character_id,
        base_id=base_id,
        cast_kind=social.cast_kind,
        social_role_to_pc=social.role_to_pc,
        role_hint=social.role_hint,
        profile=profile,
        relationship_state=rel,
        preferences=prefs,
    )


def _build_blank_world(
    *,
    save_id: str,
    user_id: str,
    protagonist_name: str = "我",
    kind: SaveKind = "auto",
    label: str = "",
) -> WorldSave:
    settings = get_settings()
    ap_max = int(settings.companion_daily_ap_max or 5)
    if ap_max < 5:
        ap_max = 5
    graph = load_social_graph()
    bonds: dict[str, BondShelf] = {}
    for cid, social in graph.characters.items():
        bonds[cid] = build_bond_from_social(cid, social)
    from .china_calendar import day_info
    from .economy import default_protagonist_fields

    day1 = day_info(1)
    return WorldSave(
        save_id=save_id,
        user_id=user_id,
        kind=kind,
        label=(label or "").strip()[:48],
        protagonist_name=(protagonist_name or "我").strip()[:32] or "我",
        protagonist=ProtagonistLife.model_validate(default_protagonist_fields()),
        calendar=CalendarState(
            day_index=1,
            weekday=int(day1.get("weekday") or 1),
            period="morning",
        ),
        action_points=ap_max,
        action_points_max=ap_max,
        location_id="home",
        bonds=bonds,
        onboarding_step="wake",
        updated_at=_now_iso(),
    )


def get_auto_save(user_id: str) -> WorldSave | None:
    init_world_db()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT payload_json FROM world_saves
            WHERE user_id = ? AND kind = 'auto'
            ORDER BY updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    for row in rows:
        try:
            save = WorldSave.model_validate_json(row["payload_json"])
        except Exception:
            continue
        if _normalize_kind(save.kind) == "auto" and save.user_id == user_id:
            return save
    # 表列未同步时从 payload 兜底
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT payload_json FROM world_saves
            WHERE user_id = ?
            ORDER BY updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    for row in rows:
        try:
            save = WorldSave.model_validate_json(row["payload_json"])
        except Exception:
            continue
        if save.user_id == user_id and _normalize_kind(save.kind) == "auto":
            return save
    return None


def reset_auto_save(*, user_id: str, protagonist_name: str = "我") -> WorldSave:
    """新游戏：重置唯一自动档（保留 save_id）；无则新建。"""
    init_world_db()
    existing = get_auto_save(user_id)
    sid = existing.save_id if existing else uuid.uuid4().hex[:16]
    _clear_bond_checkpoints(sid)
    save = _build_blank_world(
        save_id=sid,
        user_id=user_id,
        protagonist_name=protagonist_name,
        kind="auto",
        label="",
    )
    upsert_world_save(save)
    return save


def ensure_auto_save(*, user_id: str, protagonist_name: str = "我") -> WorldSave:
    existing = get_auto_save(user_id)
    if existing:
        return existing
    return reset_auto_save(user_id=user_id, protagonist_name=protagonist_name)


def create_world_save(
    *,
    user_id: str,
    protagonist_name: str = "我",
) -> WorldSave:
    """新游戏入口：覆盖自动档。"""
    return reset_auto_save(user_id=user_id, protagonist_name=protagonist_name)


def create_manual_save(
    *,
    user_id: str,
    source_save_id: str,
    label: str = "",
) -> WorldSave:
    """把当前世界深拷贝为手动快照。"""
    init_world_db()
    source = get_world_save_for_user(source_save_id, user_id)
    if not source:
        raise ValueError("源存档不存在")
    manuals = [
        s
        for s in list_world_saves(user_id)
        if s.get("kind") == "manual"
    ]
    if len(manuals) >= MANUAL_SAVE_SOFT_LIMIT:
        raise ValueError(f"手动存档已达上限（{MANUAL_SAVE_SOFT_LIMIT}）")
    period = source.calendar.period
    default_label = f"第{source.calendar.day_index}天 · {period}"
    snap = source.model_copy(deep=True)
    snap.save_id = uuid.uuid4().hex[:16]
    snap.user_id = user_id
    snap.kind = "manual"
    snap.label = (label or "").strip()[:48] or default_label
    upsert_world_save(snap)
    return snap


def load_into_auto(*, user_id: str, source_save_id: str) -> WorldSave | None:
    """读档：将任意档内容写入唯一自动档并返回自动档。"""
    init_world_db()
    source = get_world_save_for_user(source_save_id, user_id)
    if not source:
        return None
    if _normalize_kind(source.kind) == "auto":
        return source
    auto = get_auto_save(user_id)
    auto_id = auto.save_id if auto else uuid.uuid4().hex[:16]
    _clear_bond_checkpoints(auto_id)
    loaded = source.model_copy(deep=True)
    loaded.save_id = auto_id
    loaded.user_id = user_id
    loaded.kind = "auto"
    loaded.label = ""
    upsert_world_save(loaded)
    return loaded


def upsert_world_save(save: WorldSave) -> None:
    init_world_db()
    save.kind = _normalize_kind(save.kind)
    save.updated_at = _now_iso()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO world_saves (save_id, user_id, payload_json, updated_at, kind)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(save_id) DO UPDATE SET
                user_id=excluded.user_id,
                payload_json=excluded.payload_json,
                updated_at=excluded.updated_at,
                kind=excluded.kind
            """,
            (
                save.save_id,
                save.user_id,
                save.model_dump_json(),
                save.updated_at,
                save.kind,
            ),
        )
        conn.commit()


def get_world_save(save_id: str) -> WorldSave | None:
    init_world_db()
    with _connect() as conn:
        row = conn.execute(
            "SELECT payload_json FROM world_saves WHERE save_id = ?", (save_id,)
        ).fetchone()
    if not row:
        return None
    return WorldSave.model_validate_json(row["payload_json"])


def get_world_save_for_user(save_id: str, user_id: str) -> WorldSave | None:
    save = get_world_save(save_id)
    if not save or save.user_id != user_id:
        return None
    return save


def list_world_saves(user_id: str) -> list[dict[str, Any]]:
    init_world_db()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT save_id, user_id, payload_json, updated_at, kind
            FROM world_saves WHERE user_id = ?
            ORDER BY CASE kind WHEN 'auto' THEN 0 ELSE 1 END, updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            save = WorldSave.model_validate_json(row["payload_json"])
        except Exception:
            continue
        kind = _normalize_kind(save.kind)
        met = 0
        for b in save.bonds.values():
            if b.relationship_state.turns > 0 or b.messages:
                met += 1
        out.append(
            {
                "save_id": save.save_id,
                "user_id": save.user_id,
                "kind": kind,
                "label": save.label or "",
                "protagonist_name": save.protagonist_name,
                "day_index": save.calendar.day_index,
                "period": save.calendar.period,
                "location_id": save.location_id,
                "bonds_met": met,
                "bonds_total": len(save.bonds),
                "updated_at": save.updated_at,
            }
        )
    autos = [s for s in out if s["kind"] == "auto"]
    manuals = sorted(
        [s for s in out if s["kind"] != "auto"],
        key=lambda s: s.get("updated_at") or "",
        reverse=True,
    )
    return autos[:1] + manuals


def delete_world_save(save_id: str, *, user_id: str | None = None) -> bool:
    init_world_db()
    save = get_world_save(save_id)
    if not save:
        return False
    if user_id and save.user_id != user_id:
        return False
    if _normalize_kind(save.kind) == "auto":
        raise ValueError("自动档不可删除，请使用「新游戏」覆盖")
    with _connect() as conn:
        if user_id:
            cur = conn.execute(
                "DELETE FROM world_saves WHERE save_id = ? AND user_id = ?",
                (save_id, user_id),
            )
        else:
            cur = conn.execute("DELETE FROM world_saves WHERE save_id = ?", (save_id,))
        conn.execute("DELETE FROM bond_checkpoints WHERE save_id = ?", (save_id,))
        conn.commit()
        return cur.rowcount > 0


def save_bond_checkpoint(save_id: str, bond: BondShelf) -> None:
    """在写入新一轮对话前快照当前 bond（按 next_turn_id-1 / 当前最大 turn）。"""
    init_world_db()
    turn_id = max(0, bond.next_turn_id - 1)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO bond_checkpoints (save_id, character_id, turn_id, bond_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(save_id, character_id, turn_id) DO UPDATE SET bond_json=excluded.bond_json
            """,
            (save_id, bond.character_id, turn_id, bond.model_dump_json()),
        )
        conn.commit()


def load_bond_checkpoint(save_id: str, character_id: str, turn_id: int) -> BondShelf | None:
    init_world_db()
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT bond_json FROM bond_checkpoints
            WHERE save_id = ? AND character_id = ? AND turn_id = ?
            """,
            (save_id, character_id, turn_id),
        ).fetchone()
    if not row:
        return None
    return BondShelf.model_validate_json(row["bond_json"])


def prune_checkpoints_after(save_id: str, character_id: str, turn_id: int) -> None:
    init_world_db()
    with _connect() as conn:
        conn.execute(
            """
            DELETE FROM bond_checkpoints
            WHERE save_id = ? AND character_id = ? AND turn_id > ?
            """,
            (save_id, character_id, turn_id),
        )
        conn.commit()


def public_bond_summary(
    bond: BondShelf,
    *,
    day_index: int | None = None,
    save: WorldSave | None = None,
) -> dict[str, Any]:
    from .social_life import soft_status_hint

    day = int(day_index or (save.calendar.day_index if save else 0) or 0)
    outfit = ""
    if save is not None:
        from .sprite_outfit import resolve_outfit_for_bond

        outfit = resolve_outfit_for_bond(save, bond)
    prof = bond.profile
    rel = bond.relationship_state
    met = int(rel.turns or 0) > 0 or len(bond.messages) > 0
    traits: dict[str, Any] = {}
    if met and getattr(prof, "traits", None) is not None:
        raw = prof.traits
        traits = raw.model_dump() if hasattr(raw, "model_dump") else dict(raw or {})
    # 看板用：谈过才揭性格；关系数值始终下发（前端用印象词）
    payload: dict[str, Any] = {
        "character_id": bond.character_id,
        "base_id": bond.base_id,
        "name": prof.name,
        "cast_kind": bond.cast_kind,
        "social_role_to_pc": bond.social_role_to_pc,
        "role_hint": bond.role_hint,
        "theme_color": prof.theme_color,
        "affinity": rel.affinity,
        "trust": rel.trust,
        "mood": int(getattr(rel, "mood", 0) or 0),
        "stage_id": rel.stage_id,
        "stage_label": rel.stage_label,
        "user_title": rel.user_title or "",
        "route_label": getattr(rel, "route_label", "") or "",
        "turns": rel.turns,
        "message_count": len(bond.messages),
        "status_hint": soft_status_hint(bond, day) if day else "",
        "sprite_outfit": outfit,
        "met": met,
    }
    if met:
        payload.update(
            {
                "age": int(getattr(prof, "age", 0) or 0) or None,
                "occupation": (prof.occupation or "").strip(),
                "personality": (prof.personality or "").strip()[:280],
                "appearance": (prof.appearance or "").strip()[:160],
                "mbti_type": (getattr(prof, "mbti_type", None) or "").strip(),
                "mbti_label": (getattr(prof, "mbti_label", None) or "").strip(),
                "speaking_style": (getattr(prof, "speaking_style", None) or "").strip(),
                "traits": traits,
            }
        )
    return payload


def public_protagonist(save: WorldSave) -> dict[str, Any]:
    from .economy import money_vibe

    p = save.protagonist
    return {
        "name": save.protagonist_name,
        "job_id": p.job_id,
        "job_title": p.job_title,
        "workplace_id": p.workplace_id,
        "money": p.money,
        "energy": p.energy,
        "money_vibe": money_vibe(p.money),
        "worked_today": p.worked_day_index == save.calendar.day_index,
        "meals_today": p.meals_today,
    }


def public_world(save: WorldSave, *, include_bonds_detail: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "save_id": save.save_id,
        "user_id": save.user_id,
        "kind": _normalize_kind(save.kind),
        "label": save.label or "",
        "protagonist_name": save.protagonist_name,
        "protagonist": public_protagonist(save),
        "calendar": save.calendar.model_dump(),
        "action_points": save.action_points,
        "action_points_max": save.action_points_max,
        "world_flags": save.world_flags,
        "location_id": save.location_id,
        "social_insight": save.social_insight,
        "unlocked_endings": save.unlocked_endings,
        "onboarding_step": save.onboarding_step,
        "updated_at": save.updated_at,
        "bonds": {
            cid: public_bond_summary(b, day_index=save.calendar.day_index, save=save)
            for cid, b in save.bonds.items()
        },
    }
    if include_bonds_detail:
        payload["bonds_full"] = {cid: b.model_dump() for cid, b in save.bonds.items()}
    return payload
