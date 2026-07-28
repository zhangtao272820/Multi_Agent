"""内存会话 + SQLite 存档同步 + GAL 事件/选项状态。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from .character import CharacterProfile, build_system_prompt, default_opening
from .config import get_settings
from .daily_encounter import (
    get_encounter,
    public_daily_state,
    public_encounter_catalog,
    refresh_daily_runtime,
    start_encounter,
)
from .event_engine import (
    GameEvent,
    apply_event_rewards,
    choice_effect_for_index,
    event_has_branch_choices,
    pick_active_event,
)
from .game_judge import JudgeResult, check_endings, judge_turn, load_ending_meta
from .memory import MemoryFact, extract_memories, merge_memories, public_memories
from .memory_llm import apply_preference_patches, extract_memories_llm, should_extract_memories_llm
from .relationship import (
    RelationshipState,
    apply_judge_to_state,
    init_relationship_state,
    public_relationship_state,
)
from .route_catalog import get_route
from .scene_run import public_scene_run
from .scenes import resolve_scene
from .quest_engine import evaluate_quest_progress, public_quest_state, quest_prompt_snippet
from .save_store import GameRuntime, create_save, get_save, upsert_save
from .social_graph import edge_prompt_bits
from .summary import build_summary, should_summarize, trim_messages_for_context
from .world_store import (
    DialogueTurn,
    Preferences,
    get_world_save,
    load_bond_checkpoint,
    prune_checkpoints_after,
    save_bond_checkpoint,
    upsert_world_save,
)
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class EventLogEntry:
    event_id: str
    label: str
    turn: int


@dataclass
class Session:
    id: str
    profile: CharacterProfile
    system_prompt: str
    relationship_state: RelationshipState
    memories: list[MemoryFact] = field(default_factory=list)
    messages: list[dict[str, str]] = field(default_factory=list)
    save_id: str | None = None
    base_id: str = ""
    message_summary: str = ""
    active_event: GameEvent | None = None
    event_log: list[EventLogEntry] = field(default_factory=list)
    pending_choices: list[str] = field(default_factory=list)
    pending_choice_event_id: str | None = None
    """soft=开场提示（只走 Judge）；branch=事件分支（可合并 choice_effects）。"""
    pending_choice_kind: str = "soft"
    last_event_fired: dict[str, Any] | None = None
    runtime: GameRuntime = field(default_factory=GameRuntime)
    daily_encounter_snippet: str = ""
    # 世界模式
    world_save_id: str | None = None
    active_character_id: str = ""
    date_snippet: str = ""
    preferences: dict[str, Any] = field(default_factory=dict)
    dialogue_turns: list[DialogueTurn] = field(default_factory=list)
    next_turn_id: int = 1
    # P5 软轨道
    scene_agenda: dict[str, Any] = field(default_factory=dict)
    off_agenda_streak: int = 0
    # P10：连续极短输入 → 沉默议程
    cold_input_streak: int = 0
    # 场次边界（世界 talk/date/ping）
    scene_run: dict[str, Any] = field(default_factory=dict)
    # 双人同场
    ensemble: dict[str, Any] = field(default_factory=dict)
    # 专属故事节拍（有 beats 时）
    story_beat_index: int = 0
    story_act_summary: str = ""
    story_event_id: str = ""

    def rebuild_prompt(self, *, user_text: str = "", event_snippet: str = "") -> None:
        from .cross_impression import cross_impression_prompt_line
        from .prompt_budget import PromptBlock, trim_blocks
        from .scene_agenda import SceneAgenda, agenda_prompt_block, build_scene_agenda
        from .story_beats import event_beats, format_story_snippet, is_story_event

        snippet = event_snippet
        if not snippet and self.date_snippet:
            snippet = self.date_snippet
        if not snippet and self.daily_encounter_snippet:
            snippet = self.daily_encounter_snippet
        if not snippet and self.active_event:
            if event_beats(self.active_event):
                snippet = format_story_snippet(
                    self.active_event,
                    beat_index=self.story_beat_index,
                    act_summary=self.story_act_summary,
                )
            else:
                snippet = self.active_event.prompt_snippet
        quest_snip = quest_prompt_snippet(
            character_id=self.profile.character_id or "",
            base_id=self.base_id,
            growth_mode=self.relationship_state.growth_mode,
            state=self.relationship_state,
            runtime=self.runtime,
        )
        blocks: list[PromptBlock] = []
        if is_story_event(self.active_event) and snippet.strip():
            # 故事当前拍单独成块且受保护，避免被传闻挤掉
            blocks.append(PromptBlock("story_beat", f"\n\n{snippet.strip()}"))
            snippet = ""
        if self.preferences:
            likes = "、".join((self.preferences.get("likes") or [])[:5])
            dislikes = "、".join((self.preferences.get("dislikes") or [])[:4])
            habits = "、".join((self.preferences.get("habits") or [])[:4])
            blocks.append(
                PromptBlock(
                    "prefs",
                    f"\n【她的喜好】喜欢：{likes or '未知'}；雷点：{dislikes or '未知'}；习惯：{habits or '未知'}",
                )
            )

        agenda = SceneAgenda.model_validate(self.scene_agenda) if self.scene_agenda else SceneAgenda()
        location_id = ""
        world = get_world_save(self.world_save_id) if self.world_save_id else None
        if world:
            from .china_calendar import anniversary_match, day_info as _di
            from .china_calendar import prompt_calendar_block
            from .economy import money_vibe
            from .relationship import mood_natural_phrase
            from .social_graph import load_social_graph
            from .social_life import (
                copresence_prompt_block,
                long_status_prompt_line,
                rumors_for_character,
            )
            from .world_engine import period_label, resolve_schedule, who_is_here

            location_id = world.location_id
            cid = self.profile.character_id or ""
            bond = world.bonds.get(cid)
            present_ids = who_is_here(world)
            agenda = build_scene_agenda(
                world,
                character_id=cid,
                bond=bond,
                date_mode=bool(self.date_snippet),
                quest_snip=quest_snip,
                cold_input_streak=int(self.cold_input_streak or 0),
                present_ids=present_ids,
            )
            self.scene_agenda = agenda.model_dump()
            pullback = self.off_agenda_streak >= 2
            from .scene_run import scene_prompt_block

            agenda_txt = agenda_prompt_block(agenda, pullback=pullback) + scene_prompt_block(
                self.scene_run
            )
            blocks.append(PromptBlock("agenda", agenda_txt))

            name_lookup = {
                bid: b.profile.name for bid, b in world.bonds.items() if b.profile.name
            }
            edge_bits = edge_prompt_bits(
                cid,
                insight=world.social_insight,
                name_lookup=name_lookup,
                limit=3,
            )
            if edge_bits:
                blocks.append(
                    PromptBlock("edges", f"\n【你与她圈子里已知的关系】{'；'.join(edge_bits)}")
                )
            if bond and bond.social_role_to_pc:
                id_line = f"\n【她对你的身份】{bond.social_role_to_pc}。{bond.role_hint}"
                if bond.cast_kind == "neutral":
                    id_line += "（中立线：可亲近、可拌嘴，禁止恋爱走向。）"
                elif bond.cast_kind == "npc":
                    id_line += "（周边配角：推动线索与日常即可，不必恋爱。）"
                blocks.append(PromptBlock("identity", id_line))

            if bond and bond.cast_kind == "romance":
                from .romance_policy import get_romance_policy, policy_prompt_line

                blocks.append(
                    PromptBlock("romance_policy", policy_prompt_line(get_romance_policy(cid)))
                )

            vibe = money_vibe(int(world.protagonist.money))
            job_title = (world.protagonist.job_title or "上班族").strip()
            blocks.append(
                PromptBlock(
                    "pc_status",
                    f"\n【对方近况】他是「{job_title}」，手头感觉{vibe}。"
                    "可用日常说法提工作/请客/手头紧，禁止念系统字段与精确余额。",
                )
            )
            from .life_briefs import heroine_situation_card, protagonist_day_brief_line

            pc_day = protagonist_day_brief_line(world)
            if pc_day:
                blocks.append(PromptBlock("pc_day", pc_day))
            if bond:
                situ = heroine_situation_card(world, character_id=cid, bond=bond)
                if situ:
                    blocks.append(PromptBlock("situation", situ))
            from .life_friction import outfit_prompt_line, soft_cold_prompt_line, weather_prompt_line
            from .world_facts import build_world_facts_block, weekly_focus_for_character

            weather = weather_prompt_line(world.calendar.day_index)
            if weather:
                blocks.append(PromptBlock("weather", weather))
            if bond:
                cold = soft_cold_prompt_line(bond, world.calendar.day_index)
                if cold:
                    blocks.append(PromptBlock("soft_cold", cold))
                from .sprite_outfit import meal_context_from_save, resolve_outfit_for_world
                from .social_life import active_long_status

                outfit_id = resolve_outfit_for_world(
                    day_index=world.calendar.day_index,
                    period=world.calendar.period,
                    location_id=world.location_id,
                    character_id=cid,
                    mood=int(bond.relationship_state.mood or 0),
                    on_date=bool(self.date_snippet),
                    affinity=int(bond.relationship_state.affinity or 0),
                    fatigue=int(bond.living.fatigue or 0),
                    meal_context=meal_context_from_save(world),
                    long_status=active_long_status(bond, world.calendar.day_index) or "",
                    stage_id=str(bond.relationship_state.stage_id or ""),
                )
                outfit = outfit_prompt_line(outfit_id)
                if outfit:
                    blocks.append(PromptBlock("outfit", outfit))
            from .errands import errand_prompt_line

            err_line = errand_prompt_line(world, cid)
            if err_line:
                blocks.append(PromptBlock("errand", err_line))

            graph = load_social_graph()
            social = graph.characters.get(cid)
            occ = (social.occupation if social else "") or self.profile.occupation or ""
            slots = []
            if social:
                slots = list(
                    resolve_schedule(social, world.calendar.day_index).get(world.calendar.period)
                    or []
                )
            place_hint = "、".join(slots[:3]) if slots else "行踪不定"
            mood_txt = mood_natural_phrase(int(self.relationship_state.mood or 0))
            period_txt = period_label(world.calendar.period)
            here_txt = next(
                (l.label for l in graph.locations if l.id == world.location_id),
                world.location_id,
            )
            info_day = _di(world.calendar.day_index)
            season_label = str(info_day.get("season_label") or "")
            # strip leading "【天气】…" style if present — weather_prompt_line may be full sentence
            weather_short = weather.replace("\n", " ").strip() if weather else ""
            if weather_short.startswith("【"):
                weather_short = weather_short.split("】", 1)[-1].strip()
            blocks.append(
                PromptBlock(
                    "world_facts",
                    build_world_facts_block(
                        day_index=world.calendar.day_index,
                        period_label=period_txt,
                        season_label=season_label,
                        location_label=here_txt,
                        weather_line=weather_short[:48],
                        stage_label=str(
                            getattr(self.relationship_state, "stage_label", None)
                            or getattr(self.relationship_state, "stage_id", "")
                            or ""
                        ),
                        is_weekly_focus=weekly_focus_for_character(world, cid),
                        cast_kind=bond.cast_kind if bond else (self.profile.cast_role or ""),
                    ),
                )
            )
            blocks.append(
                PromptBlock(
                    "calendar",
                    "\n"
                    + prompt_calendar_block(
                        world.calendar.day_index,
                        cast_kind=bond.cast_kind if bond else "",
                        occupation=occ,
                    ),
                )
            )
            blocks.append(
                PromptBlock(
                    "life_brief",
                    f"\n【生活简报】当前时段：{period_txt}；此刻所在：{here_txt}；"
                    f"她这段时间常见地点：{place_hint}；心境：{mood_txt}。"
                    "结合天气与穿着提示自然回应环境，禁止念出系统字段与数值。",
                )
            )
            if bond and (bond.living.last_offscreen_note or "").strip():
                blocks.append(
                    PromptBlock(
                        "offscreen",
                        f"\n【昨日她还做过】{bond.living.last_offscreen_note.strip()}"
                        "（可自然提起，勿整段复读。）",
                    )
                )
            if bond and bond.living.diary_lines:
                recent = "／".join(bond.living.diary_lines[-2:])
                blocks.append(
                    PromptBlock(
                        "diary",
                        f"\n【她最近的独处日记】{recent}（可轻描淡写带出，勿整段宣读。）",
                    )
                )
            if bond and (bond.living.last_week_review or "").strip():
                blocks.append(
                    PromptBlock(
                        "week_review",
                        f"\n【她对这一周的感觉】{bond.living.last_week_review.strip()}（可自然提起。）",
                    )
                )
            if bond and bond.living.fatigue >= 55:
                blocks.append(PromptBlock("fatigue", "\n她有点累，回话偏短，可能想早点回去。"))

            if bond:
                cur_day = world.calendar.day_index
                if bond.living.first_met_day:
                    gap = cur_day - bond.living.first_met_day
                    if gap > 0:
                        blocks.append(
                            PromptBlock(
                                "romance_anchor",
                                f"\n【相识以来】大约认识 {gap} 天了（勿念数字，可用‘认识一阵子了’）。",
                            )
                        )
                if bond.living.first_date_day:
                    if anniversary_match(cur_day, bond.living.first_date_day):
                        blocks.append(
                            PromptBlock(
                                "romance_anchor",
                                "\n【纪念日口吻】今天与你们某次重要见面同月同日，"
                                "可轻轻提起‘好像有一天也是这种天气’，勿直接说纪念日系统。",
                            )
                        )
                pending = [
                    a
                    for a in world.appointments
                    if a.status == "pending" and a.character_id == cid
                ]
                if pending:
                    a0 = sorted(pending, key=lambda x: x.day_index)[0]
                    ainfo = _di(a0.day_index)
                    blocks.append(
                        PromptBlock(
                            "appointment",
                            f"\n【你们还有未赴的约】约在{ainfo.get('label') or ''}的{a0.label}"
                            "（可提起期待或提醒，勿念预约 ID）。",
                        )
                    )

                status_line = long_status_prompt_line(bond, world.calendar.day_index)
                if status_line:
                    blocks.append(
                        PromptBlock(
                            "fatigue",
                            f"\n【这阵子状态】{status_line}（用口吻体现，勿念状态名。）",
                        )
                    )
                rumor_bits = rumors_for_character(world, cid, limit=2)
                if rumor_bits:
                    blocks.append(
                        PromptBlock(
                            "rumors",
                            "\n【你听过的闲话】"
                            + "／".join(rumor_bits)
                            + "（可轻描淡写提起或回避，勿当庭审。）",
                        )
                    )
                co = copresence_prompt_block(world, character_id=cid, present_ids=present_ids)
                if co:
                    blocks.append(PromptBlock("copresence", co))
                from .ensemble import ensemble_prompt_block

                ens_block = ensemble_prompt_block(self.ensemble)
                if ens_block:
                    blocks.append(PromptBlock("ensemble", ens_block))

            cross = cross_impression_prompt_line(world, character_id=cid)
            if cross:
                blocks.append(PromptBlock("cross_impression", cross))

            if social and (social.contact_style or social.boundary):
                blocks.append(
                    PromptBlock(
                        "boundary",
                        f"\n【相处边界】联系风格：{social.contact_style or '随心情'}；"
                        f"雷区：{social.boundary or '无'}。",
                    )
                )
            blocks.append(
                PromptBlock(
                    "free_play",
                    "\n【演绎自由】你是自由的人：在【世界事实】与日历、日记、关系、本场议程边界内，"
                    "自主决定忙不忙、想不想多聊；禁止编造未注入的他人行踪或改季节。"
                    "禁止复读上文条目；用自然口语演绎即可。",
                )
            )

        extra = trim_blocks(blocks)
        self.system_prompt = build_system_prompt(
            self.profile,
            relationship_state=self.relationship_state,
            memories=self.memories,
            message_summary=self.message_summary,
            user_text=user_text,
            event_snippet=(snippet or "") + extra,
            quest_snippet=quest_snip,
            agenda_goal=agenda.goal if agenda else "",
            location_id=location_id,
        )

    def user_turns(self) -> int:
        return len([m for m in self.messages if m.get("role") == "user"])

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "save_id": self.save_id,
            "profile": self.profile.model_dump(),
            "relationship_state": public_relationship_state(self.relationship_state),
            "memories": public_memories(self.memories),
            "message_summary": self.message_summary,
            "turns": self.user_turns(),
            "active_event": self._public_event(self.active_event),
            "event_log": [self._public_log_entry(e) for e in self.event_log[-12:]],
            "pending_choices": list(self.pending_choices),
            "pending_choice_kind": self.pending_choice_kind if self.pending_choices else "soft",
            "daily_state": public_daily_state(self.runtime),
            "daily_encounters": public_encounter_catalog(
                character_id=self.profile.character_id or "",
                base_id=self.base_id,
                state=self.relationship_state,
            ),
            "quest_state": public_quest_state(
                character_id=self.profile.character_id or "",
                base_id=self.base_id,
                growth_mode=self.relationship_state.growth_mode,
                state=self.relationship_state,
                runtime=self.runtime,
            ),
            "scene_run": public_scene_run(self.scene_run) if self.scene_run else None,
            "ensemble": (self.ensemble if self.ensemble.get("enabled") else None),
            "story_progress": self._public_story_progress(),
        }

    def _public_story_progress(self) -> dict[str, Any] | None:
        from .story_beats import public_story_progress

        return public_story_progress(
            self.active_event,
            beat_index=self.story_beat_index,
            act_summary=self.story_act_summary,
        )

    @staticmethod
    def _public_event(event: GameEvent | None) -> dict[str, Any] | None:
        if not event:
            return None
        from .story_beats import event_beats

        out: dict[str, Any] = {"id": event.id, "label": event.label, "scene_id": event.scene_id}
        if event_beats(event):
            out["beat_total"] = len(event.beats)
        return out

    @staticmethod
    def _public_log_entry(entry: EventLogEntry) -> dict[str, Any]:
        return {"event_id": entry.event_id, "label": entry.label, "turn": entry.turn}


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def create(
        self,
        profile: CharacterProfile,
        *,
        base_id: str = "",
        save_id: str | None = None,
        user_id: str = "default",
    ) -> Session:
        sid = uuid.uuid4().hex[:16]
        cid = (profile.character_id or "").strip()
        rel_state = init_relationship_state(profile, character_id=cid, base_id=base_id)

        persisted_save_id = save_id
        memories: list[MemoryFact] = []
        messages: list[dict[str, str]] = []
        summary = ""
        runtime = GameRuntime()

        if save_id:
            existing = get_save(save_id)
            if existing:
                rel_state = existing.relationship_state
                memories = list(existing.memories_l2)
                messages = list(existing.messages)
                summary = existing.message_summary
                runtime = refresh_daily_runtime(existing.runtime)
                persisted_save_id = existing.save_id
            else:
                game_save = create_save(profile, user_id=user_id, character_id=cid, base_id=base_id)
                persisted_save_id = game_save.save_id
                runtime = refresh_daily_runtime(game_save.runtime)
        else:
            game_save = create_save(profile, user_id=user_id, character_id=cid, base_id=base_id)
            persisted_save_id = game_save.save_id
            runtime = refresh_daily_runtime(game_save.runtime)

        session = Session(
            id=sid,
            profile=profile,
            relationship_state=rel_state,
            system_prompt="",
            messages=messages,
            memories=memories,
            save_id=persisted_save_id,
            base_id=base_id,
            message_summary=summary,
            runtime=runtime,
        )
        if not session.messages:
            session.rebuild_prompt()
            opening = default_opening(profile, relationship_state=rel_state)
            session.messages = [{"role": "assistant", "content": opening}]
        else:
            session.rebuild_prompt()
        self._sessions[sid] = session
        self._persist(session)
        return session

    def create_world_talk(
        self,
        *,
        world_save_id: str,
        character_id: str,
        date_snippet: str = "",
        scene_mode: str = "talk",
        guest_character_id: str = "",
    ) -> Session | None:
        world = get_world_save(world_save_id)
        if not world:
            return None
        bond = world.bonds.get(character_id)
        if not bond:
            return None
        from .scene_run import new_scene_run
        from .ensemble import build_ensemble, empty_ensemble
        from .sprite_outfit import meal_context_from_save, resolve_outfit_for_world

        mode = (scene_mode or "talk").strip().lower()
        if mode not in {"talk", "date", "ping"}:
            mode = "date" if date_snippet else "talk"
        sid = uuid.uuid4().hex[:16]
        messages = [{"role": m.role, "content": m.content} for m in bond.messages]
        scene = new_scene_run(
            mode=mode,
            character_id=character_id,
            day_index=int(world.calendar.day_index or 1),
        )

        def _cast_member(cid: str) -> dict[str, Any] | None:
            b = world.bonds.get(cid)
            if not b:
                return None
            outfit = resolve_outfit_for_world(
                day_index=world.calendar.day_index,
                period=world.calendar.period,
                location_id=world.location_id,
                character_id=cid,
                mood=int(b.relationship_state.mood or 0),
                on_date=False,
                affinity=int(b.relationship_state.affinity or 0),
                fatigue=int(b.living.fatigue or 0),
                meal_context=meal_context_from_save(world),
                long_status=str(b.living.long_status or ""),
                stage_id=str(b.relationship_state.stage_id or ""),
            )
            return {
                "character_id": cid,
                "name": b.profile.name or cid,
                "theme_color": b.profile.theme_color or "",
                "sprite_outfit": outfit,
            }

        guest = (guest_character_id or "").strip()
        ens = empty_ensemble()
        if guest and guest != character_id and guest in world.bonds:
            members = [m for m in (_cast_member(character_id), _cast_member(guest)) if m]
            guest_aff = int(world.bonds[guest].relationship_state.affinity or 0)
            ens = build_ensemble(
                focus_id=character_id,
                guest_id=guest,
                cast=members,
                guest_affinity_ok=guest_aff >= 0,
            )

        session = Session(
            id=sid,
            profile=bond.profile,
            relationship_state=bond.relationship_state,
            system_prompt="",
            messages=messages,
            memories=list(bond.memories),
            save_id=None,
            base_id=bond.base_id,
            message_summary=bond.message_summary,
            runtime=GameRuntime(
                affinity=bond.relationship_state.affinity,
                trust=bond.relationship_state.trust,
                mood=bond.relationship_state.mood,
                stage_id=bond.relationship_state.stage_id,
                flags=dict(bond.relationship_state.flags or {}),
            ),
            world_save_id=world_save_id,
            active_character_id=character_id,
            date_snippet=date_snippet,
            preferences=bond.preferences.model_dump(),
            dialogue_turns=list(bond.messages),
            next_turn_id=bond.next_turn_id,
            scene_run=scene.model_dump(),
            ensemble=ens.model_dump(),
        )
        if not session.messages:
            session.rebuild_prompt()
            opening = default_opening(bond.profile, relationship_state=bond.relationship_state)
            session.messages = [{"role": "assistant", "content": opening}]
            tid = session.next_turn_id
            turn = DialogueTurn(turn_id=tid, role="assistant", content=opening, ts=_now_iso())
            session.dialogue_turns = [turn]
            session.next_turn_id = tid + 1
        else:
            session.rebuild_prompt()
        from .life_briefs import soft_choices_for_agenda

        soft = soft_choices_for_agenda(session.scene_agenda)
        if soft:
            session.pending_choices = soft
            session.pending_choice_kind = "soft"
            session.pending_choice_event_id = None
        else:
            session.pending_choices = []
            session.pending_choice_kind = "soft"
            session.pending_choice_event_id = None
        self._sessions[sid] = session
        self._persist(session)
        return session

    def rollback_bond(self, session_id: str, turn_id: int) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session or not session.world_save_id or not session.active_character_id:
            return {"error": "仅世界对话支持回退"}
        restored = load_bond_checkpoint(session.world_save_id, session.active_character_id, turn_id)
        if not restored:
            # 回退到 turn_id 之前：裁剪 messages
            world = get_world_save(session.world_save_id)
            if not world:
                return {"error": "存档不存在"}
            bond = world.bonds.get(session.active_character_id)
            if not bond:
                return {"error": "角色不存在"}
            kept = [m for m in bond.messages if m.turn_id <= turn_id]
            bond.messages = kept
            bond.next_turn_id = turn_id + 1
            msgs = [{"role": m.role, "content": m.content} for m in kept]
            session.messages = msgs
            session.dialogue_turns = list(kept)
            session.next_turn_id = bond.next_turn_id
            session.relationship_state = bond.relationship_state
            session.memories = list(bond.memories)
            session.message_summary = bond.message_summary
            world.bonds[session.active_character_id] = bond
            upsert_world_save(world)
            prune_checkpoints_after(session.world_save_id, session.active_character_id, turn_id)
            session.rebuild_prompt()
            return {
                "ok": True,
                "turn_id": turn_id,
                "messages": [m.model_dump() for m in bond.messages],
                "relationship_state": public_relationship_state(session.relationship_state),
            }
        world = get_world_save(session.world_save_id)
        if not world:
            return {"error": "存档不存在"}
        world.bonds[session.active_character_id] = restored
        upsert_world_save(world)
        prune_checkpoints_after(session.world_save_id, session.active_character_id, turn_id)
        session.profile = restored.profile
        session.relationship_state = restored.relationship_state
        session.memories = list(restored.memories)
        session.message_summary = restored.message_summary
        session.messages = [{"role": m.role, "content": m.content} for m in restored.messages]
        session.dialogue_turns = list(restored.messages)
        session.next_turn_id = restored.next_turn_id
        session.preferences = restored.preferences.model_dump()
        session.rebuild_prompt()
        return {
            "ok": True,
            "turn_id": turn_id,
            "messages": [m.model_dump() for m in restored.messages],
            "relationship_state": public_relationship_state(session.relationship_state),
        }

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def reset(self, session_id: str) -> Session | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        session.relationship_state = init_relationship_state(
            session.profile,
            character_id=session.profile.character_id,
            base_id=session.base_id,
        )
        session.memories = []
        session.message_summary = ""
        session.active_event = None
        session.event_log = []
        session.pending_choices = []
        session.pending_choice_event_id = None
        session.pending_choice_kind = "soft"
        session.last_event_fired = None
        session.daily_encounter_snippet = ""
        session.story_beat_index = 0
        session.story_act_summary = ""
        session.story_event_id = ""
        session.rebuild_prompt()
        opening = default_opening(session.profile, relationship_state=session.relationship_state)
        session.messages = [{"role": "assistant", "content": opening}]
        self._persist(session)
        return session

    def prepare_turn(self, session_id: str, user_text: str) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        if session.scene_run and session.scene_run.get("ended"):
            return {"error": "这场见面已经结束，请告辞返回"}

        prev_event_id = session.active_event.id if session.active_event else None
        world_for_event = (
            get_world_save(session.world_save_id) if session.world_save_id else None
        )
        event = pick_active_event(
            state=session.relationship_state,
            character_id=session.profile.character_id,
            base_id=session.base_id,
            day_index=world_for_event.calendar.day_index if world_for_event else None,
        )
        session.active_event = event
        fired = None
        scene = resolve_scene(
            base_id=session.base_id,
            stage_id=session.relationship_state.stage_id,
            event_id=event.id if event else "",
            scene_id=event.scene_id if event else "",
        )
        if event and event.id != prev_event_id:
            from .scene_run import bump_scene_for_story
            from .story_beats import event_beats, is_story_event, soft_options_for_beat

            session.event_log.append(
                EventLogEntry(event_id=event.id, label=event.label, turn=session.user_turns() + 1)
            )
            fired = Session._public_event(event)
            session.story_beat_index = 0
            session.story_act_summary = ""
            session.story_event_id = event.id
            if is_story_event(event) and session.scene_run:
                bumped = bump_scene_for_story(session.scene_run)
                if bumped:
                    session.scene_run = bumped.model_dump()
            if event_beats(event):
                # 有节拍：奖励延后到末拍；首轮不下 last_event_fired
                session.last_event_fired = None
                opts = soft_options_for_beat(event, 0)
                if opts:
                    session.pending_choices = opts
                    session.pending_choice_kind = "branch" if event_has_branch_choices(event) else "soft"
                    session.pending_choice_event_id = event.id if event_has_branch_choices(event) else None
                if fired is not None:
                    fired["curtain"] = f"—— 专属故事 · {event.label or event.id} · 开幕 ——"
                    fired["story"] = True
            else:
                session.last_event_fired = fired
                if fired is not None and is_story_event(event):
                    fired["curtain"] = f"—— 专属故事 · {event.label or event.id} · 开幕 ——"
                    fired["story"] = True
        elif not event:
            session.story_beat_index = 0
            session.story_act_summary = ""
            session.story_event_id = ""

        from .life_friction import is_structurally_cold_input

        if is_structurally_cold_input(user_text):
            session.cold_input_streak = int(session.cold_input_streak or 0) + 1
        else:
            session.cold_input_streak = 0

        session.rebuild_prompt(user_text=user_text)
        settings = get_settings()
        from .prompt_budget import context_keep_pairs
        from .scene_run import public_scene_run

        limit = context_keep_pairs(world_mode=bool(session.world_save_id))
        if not session.world_save_id:
            limit = max(limit, settings.history_max_turns)
        trimmed = trim_messages_for_context(session.messages, keep_pairs=limit)
        session.daily_encounter_snippet = ""
        return {
            "messages": trimmed,
            "system_prompt": session.system_prompt,
            "event": fired,
            "scene": scene,
            "daily_state": public_daily_state(session.runtime),
            "scene_run": public_scene_run(session.scene_run) if session.scene_run else None,
            "story_progress": session._public_story_progress(),
            "pending_choices": list(session.pending_choices),
            "pending_choice_kind": session.pending_choice_kind if session.pending_choices else "soft",
        }

    def start_daily_encounter(self, session_id: str, encounter_id: str) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        settings = get_settings()
        if not settings.companion_daily_ap_enabled:
            return {"error": "日常行动力未启用"}
        enc = get_encounter(encounter_id)
        if not enc:
            return {"error": "未知日常活动"}
        available = public_encounter_catalog(
            character_id=session.profile.character_id or "",
            base_id=session.base_id,
            state=session.relationship_state,
        )
        if enc.id not in {row["id"] for row in available}:
            return {"error": "当前阶段不可选此活动"}
        try:
            session.runtime = start_encounter(session.runtime, enc)
        except ValueError as ex:
            return {"error": str(ex)}
        session.daily_encounter_snippet = enc.prompt_snippet
        scene = resolve_scene(
            base_id=session.base_id,
            stage_id=session.relationship_state.stage_id,
            scene_id=enc.scene_id,
        )
        self._persist(session)
        return {
            "encounter": {
                "id": enc.id,
                "label": enc.label,
                "description": enc.description,
                "scene_id": enc.scene_id,
            },
            "scene": scene,
            "daily_state": public_daily_state(session.runtime),
            "kickoff_text": f"（开始「{enc.label}」）",
        }

    def maybe_summarize(self, session_id: str) -> bool:
        session = self._sessions.get(session_id)
        if not session:
            return False
        settings = get_settings()
        turns = session.user_turns()
        if not should_summarize(turns, settings.companion_summary_every_turns):
            return False
        new_summary = build_summary(
            settings,
            existing_summary=session.message_summary,
            messages=session.messages,
            character_name=session.profile.name,
        )
        if new_summary == session.message_summary:
            return False
        session.message_summary = new_summary
        # 世界模式：全量对话保留，仅用 summary 压缩进 prompt；旧单角存档仍可裁剪
        if not session.world_save_id:
            from .prompt_budget import context_keep_pairs

            keep = max(context_keep_pairs(world_mode=False), settings.history_max_turns)
            session.messages = trim_messages_for_context(session.messages, keep_pairs=keep)
        session.rebuild_prompt()
        return True

    def _persist(self, session: Session) -> None:
        if session.world_save_id and session.active_character_id:
            world = get_world_save(session.world_save_id)
            if not world:
                return
            bond = world.bonds.get(session.active_character_id)
            if not bond:
                return
            bond.profile = session.profile
            bond.relationship_state = session.relationship_state
            bond.memories = session.memories
            bond.message_summary = session.message_summary
            bond.messages = list(session.dialogue_turns)
            bond.next_turn_id = session.next_turn_id
            if session.preferences:
                bond.preferences = Preferences.model_validate(session.preferences)
            if session.relationship_state.active_ending_id:
                eid = session.relationship_state.active_ending_id
                if eid not in bond.unlocked_endings:
                    bond.unlocked_endings.append(eid)
                if eid not in world.unlocked_endings:
                    world.unlocked_endings.append(eid)
            # P13：夜聊计数 + 同场见证记忆
            from .life_briefs import note_night_chat
            from .social_life import apply_witness_memories
            from .world_engine import who_is_here

            note_night_chat(world)
            bond.living.talked_day_index = world.calendar.day_index
            world.bonds[session.active_character_id] = bond
            world = apply_witness_memories(
                world,
                talking_id=session.active_character_id,
                present_ids=who_is_here(world),
            )
            upsert_world_save(world)
            return
        if not session.save_id:
            return
        save = get_save(session.save_id)
        if not save:
            return
        save.profile = session.profile
        save.relationship_state = session.relationship_state
        save.memories_l2 = session.memories
        save.messages = session.messages
        save.message_summary = session.message_summary
        save.runtime.affinity = session.relationship_state.affinity
        save.runtime.trust = session.relationship_state.trust
        save.runtime.mood = session.relationship_state.mood
        save.runtime.stage_id = session.relationship_state.stage_id
        save.runtime.flags = dict(session.relationship_state.flags)
        save.runtime.low_streak = session.relationship_state.low_streak
        save.runtime = refresh_daily_runtime(session.runtime)
        save.runtime.quest_steps_done = list(session.runtime.quest_steps_done)
        if session.runtime.active_quest_id:
            save.runtime.active_quest_id = session.runtime.active_quest_id
        if session.active_event:
            save.runtime.active_quest_id = session.active_event.id
        if session.relationship_state.active_ending_id:
            eid = session.relationship_state.active_ending_id
            if eid not in save.runtime.unlocked_endings:
                save.runtime.unlocked_endings.append(eid)
        upsert_save(save)

    def _settle_and_end_scene(self, session: Session, *, reason: str) -> dict[str, Any]:
        """离场结算印象池 → 写 Bond；返回 scene_ended 载荷字段。"""
        from .scene_run import (
            SceneRun,
            compute_settlement,
            farewell_line,
            mark_ended,
            public_scene_run,
        )
        from .world_engine import hub_public
        from .world_store import public_world

        if not session.scene_run:
            return {"ok": False, "error": "无场次"}
        run = SceneRun.model_validate(session.scene_run)
        if run.ended:
            return {
                "ok": True,
                "already_ended": True,
                "scene_run": public_scene_run(run),
                "closing_line": farewell_line(
                    reason=run.end_reason or reason,
                    character_name=session.profile.name,
                ),
                "affinity_delta": 0,
                "trust_delta": 0,
                "stage_changed": False,
                "settle_note": "",
                "relationship_state": public_relationship_state(session.relationship_state),
            }

        aff, trust, mood, settle_note = compute_settlement(run)
        prev_stage = session.relationship_state.stage_id
        session.relationship_state, applied_delta, stage_changed = apply_judge_to_state(
            session.relationship_state,
            affinity_delta=aff,
            trust_delta=trust,
            mood_delta=mood,
            new_flags={},
        )
        run = mark_ended(run, reason)
        # 清空池，避免重复结算
        run.affinity_pool = 0
        run.trust_pool = 0
        run.mood_pool = 0
        session.scene_run = run.model_dump()

        hub = None
        world_pub = None
        if session.world_save_id and session.active_character_id:
            world = get_world_save(session.world_save_id)
            if world:
                bond = world.bonds.get(session.active_character_id)
                if bond:
                    bond.relationship_state = session.relationship_state
                    bond.memories = list(session.memories)
                    bond.message_summary = session.message_summary
                    bond.messages = list(session.dialogue_turns)
                    bond.next_turn_id = session.next_turn_id
                    world.bonds[session.active_character_id] = bond
                    from .romance_policy import sync_world_romance_flags

                    sync_world_romance_flags(world)
                    upsert_world_save(world)
                    hub = hub_public(world)
                    world_pub = public_world(world)

        closing = farewell_line(reason=reason, character_name=session.profile.name)
        self._persist(session)
        out: dict[str, Any] = {
            "ok": True,
            "end_reason": reason,
            "closing_line": closing,
            "settle_note": settle_note,
            "affinity_delta": applied_delta,
            "trust_delta": trust,
            "mood_delta": mood,
            "stage_changed": stage_changed,
            "previous_stage_id": prev_stage if stage_changed else None,
            "relationship_state": public_relationship_state(session.relationship_state),
            "scene_run": public_scene_run(run),
            "hub": hub,
            "world": world_pub,
        }
        return out

    def leave_scene(self, session_id: str, *, reason: str = "farewell") -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        if not session.world_save_id:
            return {"ok": False, "error": "仅世界对话支持告辞"}
        if not session.scene_run:
            # 旧会话无 SceneRun：仍允许离开
            from .world_engine import hub_public
            from .world_store import public_world

            world = get_world_save(session.world_save_id)
            return {
                "ok": True,
                "end_reason": reason,
                "closing_line": "你离开了。",
                "settle_note": "",
                "affinity_delta": 0,
                "trust_delta": 0,
                "stage_changed": False,
                "relationship_state": public_relationship_state(session.relationship_state),
                "scene_run": None,
                "hub": hub_public(world) if world else None,
                "world": public_world(world) if world else None,
            }
        return self._settle_and_end_scene(session, reason=reason)

    def after_turn(
        self,
        session_id: str,
        *,
        user_text: str,
        assistant_text: str,
        judge: JudgeResult | None = None,
        choice_index: int | None = None,
        parsed_choices: list[str] | None = None,
    ) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session:
            return None

        settings = get_settings()
        # 世界模式：先 checkpoint 再写 turn
        if session.world_save_id and session.active_character_id:
            # 构造临时 bond 快照
            from .world_store import BondShelf

            snap = BondShelf(
                character_id=session.active_character_id,
                base_id=session.base_id,
                cast_kind="romance",
                social_role_to_pc="",
                profile=session.profile,
                relationship_state=session.relationship_state,
                preferences=Preferences.model_validate(session.preferences or {}),
                memories=list(session.memories),
                message_summary=session.message_summary,
                messages=list(session.dialogue_turns),
                next_turn_id=session.next_turn_id,
            )
            save_bond_checkpoint(session.world_save_id, snap)

        # 规则提取每轮都跑（零模型）；实质发言再偶发 aux 补质量
        new_memories = extract_memories(user_text, session.memories)
        turn_n = int(session.user_turns() or 0)
        if should_extract_memories_llm(settings, user_text=user_text, turn_n=turn_n):
            llm_mem = extract_memories_llm(
                settings,
                user_text=user_text,
                assistant_text=assistant_text,
                character_name=session.profile.name,
            )
            if llm_mem:
                new_memories = list(new_memories) + list(llm_mem)
        if new_memories:
            session.memories = merge_memories(session.memories, new_memories)
            session.preferences = apply_preference_patches(session.preferences or {}, new_memories)

        if session.world_save_id:
            # 把本轮 user+assistant 写入 dialogue_turns（assistant 可能已在 messages）
            # graph 已 append user 与 assistant 到 session.messages；补齐 turns
            ts = _now_iso()
            # 找到最新两条未入库的内容
            existing_n = len(session.dialogue_turns)
            sync_msgs = session.messages
            for m in sync_msgs[existing_n:]:
                tid = session.next_turn_id
                session.dialogue_turns.append(
                    DialogueTurn(
                        turn_id=tid,
                        role=str(m.get("role") or "assistant"),
                        content=str(m.get("content") or ""),
                        ts=ts,
                    )
                )
                session.next_turn_id = tid + 1
            world = get_world_save(session.world_save_id)
            if world and session.active_character_id:
                if world.onboarding_step in {"wake", "go_out", "meet"}:
                    world.onboarding_step = "talk"
                # 揭开关系边：普通边首聊可见；秘密边好感≥60
                from .social_graph import edges_for_character

                bond_aff = session.relationship_state.affinity
                for e in edges_for_character(session.active_character_id):
                    key = e.flag or f"edge:{e.a}:{e.b}"
                    if e.secret and bond_aff < 60:
                        continue
                    world.social_insight[key] = True
                upsert_world_save(world)

        agenda_goal = ""
        agenda_source = ""
        if session.scene_agenda:
            agenda_goal = str(session.scene_agenda.get("goal") or "")
            agenda_source = str(session.scene_agenda.get("source") or "")
        world_social: dict[str, Any] | None = None
        verdict = judge or JudgeResult()
        if judge is None:
            fatigue = 0
            cold_war = bool((session.relationship_state.flags or {}).get("cold_war_active"))
            if session.world_save_id and session.active_character_id:
                w0 = get_world_save(session.world_save_id)
                if w0 and session.active_character_id in w0.bonds:
                    fatigue = int(w0.bonds[session.active_character_id].living.fatigue or 0)
                    cold_war = bool(
                        (
                            w0.bonds[session.active_character_id].relationship_state.flags or {}
                        ).get("cold_war_active")
                    )
            from .scene_run import build_judge_scene_ctx

            scene_ctx = build_judge_scene_ctx(
                session.scene_run,
                fatigue=fatigue,
                cold_war=cold_war,
                agenda_source=agenda_source,
                character_id=session.active_character_id,
            )
            verdict = judge_turn(
                settings,
                user_text=user_text,
                assistant_text=assistant_text,
                state=session.relationship_state,
                profile=session.profile,
                mode=settings.companion_judge_mode,
                agenda_goal=agenda_goal,
                scene_ctx=scene_ctx,
            )
        if verdict.on_agenda:
            session.off_agenda_streak = 0
        else:
            session.off_agenda_streak = int(session.off_agenda_streak or 0) + 1

        choice_event = session.active_event
        # 仅 branch + 当前事件确有 choice_effects 时，才按 index 改数值
        if (
            choice_index is not None
            and session.pending_choices
            and session.pending_choice_kind == "branch"
            and event_has_branch_choices(choice_event)
            and session.pending_choice_event_id
            and choice_event
            and session.pending_choice_event_id == choice_event.id
        ):
            effect = choice_effect_for_index(choice_event, choice_index)
            merged_flags = dict(verdict.new_flags)
            merged_flags.update(effect.flags or {})
            verdict = verdict.model_copy(
                update={
                    "trust_delta": verdict.trust_delta + effect.trust_delta,
                    "affinity_delta": verdict.affinity_delta + effect.affinity_delta,
                    "mood_delta": verdict.mood_delta + effect.mood_delta,
                    "new_flags": merged_flags,
                    "reason": f"{verdict.reason}+choice[{choice_index}]",
                }
            )
        session.pending_choices = []
        session.pending_choice_event_id = None
        session.pending_choice_kind = "soft"

        # P6：自由对话 → relation_move → RomancePolicy 裁定（开放后宫）
        move = (getattr(verdict, "relation_move", None) or "none").strip().lower()
        if move and move != "none":
            from .romance_policy import (
                apply_relation_move,
            )

            world_for_move = (
                get_world_save(session.world_save_id) if session.world_save_id else None
            )
            romance = apply_relation_move(
                world_for_move,
                character_id=session.profile.character_id or session.active_character_id,
                move=move,
                state=session.relationship_state,
            )
            merged_flags = dict(verdict.new_flags or {})
            merged_flags.update(romance.new_flags)
            verdict = verdict.model_copy(
                update={
                    "affinity_delta": max(
                        -10, min(10, verdict.affinity_delta + romance.affinity_delta)
                    ),
                    "trust_delta": max(
                        -12, min(8, verdict.trust_delta + romance.trust_delta)
                    ),
                    "mood_delta": max(
                        -8, min(8, verdict.mood_delta + romance.mood_delta)
                    ),
                    "new_flags": merged_flags,
                    "reason": f"{verdict.reason}+romance[{romance.note or move}]",
                }
            )

        prev_stage = session.relationship_state.stage_id
        scene_active = bool(session.world_save_id and session.scene_run and not session.scene_run.get("ended"))
        applied_delta = 0
        stage_changed = False
        settle_note = ""
        scene_ended_payload: dict[str, Any] | None = None

        if scene_active:
            from .scene_run import SceneRun, pool_turn_deltas, tick_scene_turn

            run = SceneRun.model_validate(session.scene_run)
            run = pool_turn_deltas(
                run,
                affinity_delta=verdict.affinity_delta,
                trust_delta=verdict.trust_delta,
                mood_delta=verdict.mood_delta,
                on_agenda=bool(verdict.on_agenda),
            )
            # 场内只落 flags；数值进印象池，离场再结算
            session.relationship_state, _, _ = apply_judge_to_state(
                session.relationship_state,
                affinity_delta=0,
                trust_delta=0,
                mood_delta=0,
                new_flags=verdict.new_flags,
            )
            run = tick_scene_turn(run)
            session.scene_run = run.model_dump()
            applied_delta = 0
            end_now = False
            end_reason = "turns_exhausted"
            if bool(getattr(verdict, "end_scene", False)):
                end_now = True
                er = str(getattr(verdict, "end_scene_reason", None) or "she_leaves").strip()
                if er not in {"she_leaves", "busy", "awkward"}:
                    er = "she_leaves"
                end_reason = er
            elif run.turns_left <= 0:
                end_now = True
                end_reason = "turns_exhausted"
            if end_now:
                scene_ended_payload = self._settle_and_end_scene(
                    session, reason=end_reason
                )
                settle_note = str((scene_ended_payload or {}).get("settle_note") or "")
                stage_changed = bool((scene_ended_payload or {}).get("stage_changed"))
                applied_delta = int((scene_ended_payload or {}).get("affinity_delta") or 0)
                if stage_changed:
                    prev_stage = str(
                        (scene_ended_payload or {}).get("previous_stage_id") or prev_stage
                    )
        else:
            session.relationship_state, applied_delta, stage_changed = apply_judge_to_state(
                session.relationship_state,
                affinity_delta=verdict.affinity_delta,
                trust_delta=verdict.trust_delta,
                mood_delta=verdict.mood_delta,
                new_flags=verdict.new_flags,
            )

        if session.world_save_id:
            from .romance_policy import (
                is_romantic_partner,
                maybe_append_decision_echo,
                maybe_append_rivalry_rumor,
                sync_world_romance_flags,
            )
            from .social_actions import apply_social_action

            world = get_world_save(session.world_save_id)
            if world:
                cid = session.profile.character_id or session.active_character_id
                bond = world.bonds.get(cid)
                if bond:
                    bond.relationship_state = session.relationship_state
                    was_partner = bool(world.world_flags.get(f"partner:{cid}"))
                    sync_world_romance_flags(world)
                    if is_romantic_partner(bond) and not was_partner:
                        maybe_append_rivalry_rumor(
                            world, about_id=cid, source_id="romance"
                        )
                    maybe_append_decision_echo(
                        world,
                        about_id=cid,
                        new_flags=dict(verdict.new_flags or {}),
                    )
                    upsert_world_save(world)

                # 对话 → 世界动作（预约 / 吵架 / 冷战）
                sa = getattr(verdict, "social_action", None)
                if sa is not None:
                    world = get_world_save(session.world_save_id) or world
                    if world and cid:
                        world, social_result = apply_social_action(
                            world,
                            character_id=cid,
                            action=sa,
                            affinity_delta=verdict.affinity_delta,
                            trust_delta=verdict.trust_delta,
                        )
                        if social_result.get("relationship_patch"):
                            bond2 = world.bonds.get(cid)
                            if bond2:
                                session.relationship_state = bond2.relationship_state
                        agenda_patch = social_result.get("agenda")
                        if isinstance(agenda_patch, dict) and agenda_patch:
                            session.scene_agenda = {
                                **(session.scene_agenda or {}),
                                **agenda_patch,
                            }
                        world_social = {
                            k: social_result[k]
                            for k in (
                                "ok",
                                "error",
                                "note",
                                "kind",
                                "ui_tone",
                                "deferred_now",
                                "ask_date",
                                "scheduled",
                                "conflict",
                            )
                            if k in social_result
                        }
                        if social_result.get("ok") and world:
                            from .appointments import public_appointments
                            from .world_engine import hub_public
                            from .world_store import public_world

                            world_social["appointments"] = public_appointments(world, limit=8)
                            world_social["hub"] = hub_public(world)
                            world_social["world"] = public_world(world)

        event_applied = None
        from .story_beats import (
            advance_beat_index,
            append_act_summary,
            current_beat,
            event_beats,
            soft_options_for_beat,
        )

        if session.active_event and event_beats(session.active_event):
            # 本轮演绎的是推进前的当前拍
            played = current_beat(session.active_event, session.story_beat_index)
            session.story_act_summary = append_act_summary(session.story_act_summary, played)
            new_idx, completed = advance_beat_index(
                session.active_event, session.story_beat_index
            )
            session.story_beat_index = new_idx
            if completed:
                session.relationship_state = apply_event_rewards(
                    session.relationship_state, session.active_event
                )
                event_applied = Session._public_event(session.active_event)
                if event_applied is not None:
                    event_applied["curtain"] = (
                        f"—— 幕落 · {session.active_event.label or session.active_event.id} ——"
                    )
                    event_applied["story"] = True
                session.last_event_fired = None
                session.story_act_summary = ""
                session.story_event_id = ""
            # 下一拍软选项（末拍完成后清空，交给下方议程补齐）
            if not completed:
                opts = soft_options_for_beat(session.active_event, session.story_beat_index)
                if opts:
                    session.pending_choices = opts
                    if event_has_branch_choices(session.active_event):
                        session.pending_choice_kind = "branch"
                        session.pending_choice_event_id = session.active_event.id
                    else:
                        session.pending_choice_kind = "soft"
                        session.pending_choice_event_id = None
        elif (
            session.active_event
            and session.last_event_fired
            and session.last_event_fired.get("id") == session.active_event.id
        ):
            session.relationship_state = apply_event_rewards(session.relationship_state, session.active_event)
            event_applied = Session._public_event(session.active_event)
            session.last_event_fired = None

        if parsed_choices:
            session.pending_choices = parsed_choices
            if event_has_branch_choices(session.active_event):
                session.pending_choice_kind = "branch"
                session.pending_choice_event_id = (
                    session.active_event.id if session.active_event else None
                )
            else:
                # 女主偶发【选项】= 软提示，不绑事件数值
                session.pending_choice_kind = "soft"
                session.pending_choice_event_id = None
        elif not (
            session.active_event
            and event_beats(session.active_event)
            and session.story_beat_index < len(session.active_event.beats)
            and session.pending_choices
        ):
            # 美德式：每轮保证 soft 可选回复；故事拍已有系统选项则不覆盖
            from .life_briefs import soft_choices_for_agenda

            soft = soft_choices_for_agenda(session.scene_agenda)
            session.pending_choices = soft
            session.pending_choice_event_id = None
            session.pending_choice_kind = "soft"

        ending_id = verdict.ending_id
        if not ending_id:
            route = get_route(session.profile.character_id)
            runtime_flags = dict(session.relationship_state.flags or {})
            if session.world_save_id:
                world = get_world_save(session.world_save_id)
                if world:
                    runtime_flags.update(world.world_flags or {})
                    # 其他角色辅助旗：仅用「角色:flag」前缀；恋爱私有旗不污染当前线
                    _PRIVATE = {
                        "confessed",
                        "partner_confirmed",
                        "exclusive_offer",
                        "exclusive_accepted",
                        "exclusive_soft_reject",
                        "harem_proposed",
                        "harem_accepted",
                        "harem_rejected",
                        "broke_up",
                        "mentioned_other",
                        "jealousy_flare",
                    }
                    for other in world.bonds.values():
                        for fk, fv in (other.relationship_state.flags or {}).items():
                            if not fv:
                                continue
                            runtime_flags[f"{other.character_id}:{fk}"] = True
                            if fk not in _PRIVATE:
                                runtime_flags[fk] = runtime_flags.get(fk) or fv
            runtime = {
                "flags": runtime_flags,
                "trust": session.relationship_state.trust,
                "low_streak": session.relationship_state.low_streak,
                "cast_role": (route.cast_role if route else None)
                or getattr(session.profile, "cast_role", None)
                or "romance",
            }
            ending_id = check_endings(
                character_id=session.profile.character_id,
                state=session.relationship_state,
                runtime=runtime,
            )

        ending_meta = None
        if ending_id:
            session.relationship_state = session.relationship_state.model_copy(
                update={"active_ending_id": ending_id}
            )
            ending_meta = load_ending_meta(ending_id)

        session.rebuild_prompt(user_text=user_text)
        summarized = self.maybe_summarize(session_id)

        quest_result = evaluate_quest_progress(
            character_id=session.profile.character_id or "",
            base_id=session.base_id,
            growth_mode=session.relationship_state.growth_mode,
            state=session.relationship_state,
            runtime=session.runtime,
        )
        if quest_result.get("quest_steps_done") is not None:
            session.runtime = session.runtime.model_copy(
                update={"quest_steps_done": quest_result["quest_steps_done"]}
            )
        if quest_result.get("active_quest_id"):
            session.runtime = session.runtime.model_copy(
                update={"active_quest_id": str(quest_result["active_quest_id"])}
            )
        quest_notice = ""
        if quest_result.get("just_completed"):
            jc = quest_result["just_completed"]
            quest_notice = f"目标完成：{jc.get('label', '')}"

        self._persist(session)

        out: dict[str, Any] = {
            "relationship_state": public_relationship_state(session.relationship_state),
            "memories": public_memories(session.memories),
            "affinity_delta": applied_delta,
            "trust_delta": verdict.trust_delta if not scene_active else 0,
            "stage_changed": stage_changed,
            "previous_stage_id": prev_stage if stage_changed else None,
            "ending_id": ending_id,
            "ending": ending_meta,
            "judge_reason": verdict.reason,
            "event": session.last_event_fired,
            "event_applied": event_applied,
            "pending_choices": list(session.pending_choices),
            "pending_choice_kind": session.pending_choice_kind if session.pending_choices else "soft",
            "message_summary_updated": summarized,
            "event_log": [Session._public_log_entry(e) for e in session.event_log[-12:]],
            "story_progress": session._public_story_progress(),
            "scene_run": public_scene_run(session.scene_run) if session.scene_run else None,
            "scene": resolve_scene(
                base_id=session.base_id,
                stage_id=session.relationship_state.stage_id,
                event_id=session.active_event.id if session.active_event else "",
                scene_id=session.active_event.scene_id if session.active_event else "",
            ),
            "daily_state": public_daily_state(session.runtime),
            "quest_state": public_quest_state(
                character_id=session.profile.character_id or "",
                base_id=session.base_id,
                growth_mode=session.relationship_state.growth_mode,
                state=session.relationship_state,
                runtime=session.runtime,
            ),
            "quest_completed": quest_result.get("just_completed"),
            "quest_notice": quest_notice or None,
            "scene_run": public_scene_run(session.scene_run) if session.scene_run else None,
        }
        if scene_active and not scene_ended_payload:
            from .scene_run import SceneRun, impression_pool_hint

            hint = impression_pool_hint(SceneRun.model_validate(session.scene_run))
            if hint:
                out["scene_hint"] = hint
        if settle_note:
            out["settle_note"] = settle_note
        if scene_ended_payload:
            out["scene_ended"] = True
            out["closing_line"] = scene_ended_payload.get("closing_line")
            out["end_reason"] = scene_ended_payload.get("end_reason")
            if scene_ended_payload.get("hub") is not None:
                out["hub"] = scene_ended_payload["hub"]
            if scene_ended_payload.get("world") is not None:
                out["world"] = scene_ended_payload["world"]
            # 已结算：用结算后的 trust_delta
            out["trust_delta"] = int(scene_ended_payload.get("trust_delta") or 0)
        if world_social is not None:
            out["world_social"] = world_social
        from .llm_errors import consume_pending_aux_notice

        aux_notice = consume_pending_aux_notice()
        if aux_notice:
            out["aux_notice"] = aux_notice
        if session.world_save_id:
            out["dialogue"] = [m.model_dump() for m in session.dialogue_turns]
            out["world_save_id"] = session.world_save_id
        return out


store = SessionStore()
