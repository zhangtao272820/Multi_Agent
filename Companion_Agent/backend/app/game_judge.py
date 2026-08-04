"""回合结构化判定：好感 / 信任 / flags / 结局 / 议程对齐（P5）。"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import BaseModel, Field

from .character import CharacterProfile
from .config import Settings
from .prompt_budget import (
    JUDGE_ASSISTANT_CHARS,
    JUDGE_MAX_TOKENS,
    JUDGE_NOTE_CHARS,
    JUDGE_USER_CHARS,
)
from .config import aux_llm_model
from .qwen_character import chat_once_with_model
from .relationship import RelationshipState, stage_order
from .route_catalog import get_route
from .social_actions import SocialAction

logger = logging.getLogger(__name__)


class JudgeResult(BaseModel):
    affinity_delta: int = 0
    trust_delta: int = 0
    new_flags: dict[str, bool] = Field(default_factory=dict)
    mood_delta: int = 0
    ending_id: str | None = None
    reason: str = ""
    # P5：本轮是否仍贴着本场议程（True=在轨道上）
    on_agenda: bool = True
    # P6：关系决策意图（系统再按 RomancePolicy 裁定）
    # none|flirt|confess|ask_exclusive|propose_harem|mention_other|breakup
    relation_move: str = "none"
    # 对话→世界动作（预约/吵架/冷战）；闲聊保持 null
    social_action: SocialAction | None = None
    # 场次收束：女主想结束见面（系统再结算 SceneRun）
    end_scene: bool = False
    # she_leaves | busy | awkward | ""
    end_scene_reason: str = ""
    # 系统可挂起的恋爱递进意向（空/none=无）
    stage_offer: str = "none"
    # 女主主动：none|confess|ask_exclusive|cool_off
    heroine_initiative: str = "none"


_POSITIVE = (
    "喜欢", "爱", "谢谢", "开心", "高兴", "夸", "好看", "漂亮", "可爱", "陪",
    "想你", "想念", "约会", "抱抱", "牵手", "在一起", "永远", "宝贝",
    "亲爱的", "心动", "温暖", "感动", "信任", "相信", "对不起", "抱歉",
)
_NEGATIVE = (
    "讨厌", "滚", "烦", "分手", "无聊", "骗", "恶心", "闭嘴", "别烦", "走开",
    "恨", "失望", "冷漠", "拉黑", "再见", "撒谎", "背叛", "渣",
)
_CONFESS = ("表白", "交往", "在一起吧", "做我女朋友", "做我男友", "我喜欢你", "我爱你")
_HAREM = ("后宫", "也可以和其他", "不止你一个", "大家一起幸福", "三个人也可以", "多位恋人")
_EXCLUSIVE = ("只爱你", "只要你", "只对你", "只谈你", "只要我们两个", "我只要你一个", "我们专一")
_BREAKUP = ("分手", "我们结束", "不当男女朋友了", "做回朋友吧")
_MENTION_OTHER = ("和其他女生", "另一个女孩", "你情敌", "她怎么看")


_LINKED_BOND_FLAGS: dict[str, tuple[str, ...]] = {
    "shuli": ("sibling_talk_done", "bond_ally_done"),
    "jingning": ("cousin_watch_done", "bond_ally_done"),
    "youwei": ("studio_sketch_done", "bond_ally_done"),
    "yuxi": ("shift_cover_done", "bond_ally_done"),
    "lingke": ("boundary_guard_done", "bond_ally_done"),
    "aichen": ("friend_gate_done", "bond_ally_done"),
}


def _clip(text: str, n: int) -> str:
    t = (text or "").strip()
    if len(t) <= n:
        return t
    return t[: max(0, n - 1)] + "…"


def _infer_relation_move(user: str, *, cast_role: str) -> str:
    """规则兜底：抽出关系决策意图；正式路径以 LLM Judge 的 relation_move 为准。"""
    from .character_lores import is_linked_cast

    if not user:
        return "none"
    if any(k in user for k in _BREAKUP):
        return "breakup"
    if is_linked_cast(cast_role) or cast_role == "npc":
        if any(p in user for p in _CONFESS):
            return "confess"
        return "none"
    if any(k in user for k in _HAREM):
        return "propose_harem"
    if any(k in user for k in _EXCLUSIVE):
        return "ask_exclusive"
    if any(p in user for p in _CONFESS):
        return "confess"
    if any(k in user for k in _MENTION_OTHER):
        return "mention_other"
    if any(k in user for k in ("想你", "抱抱", "亲一下", "喜欢你")):
        return "flirt"
    return "none"


def _agenda_overlap(user_text: str, agenda_goal: str) -> bool:
    """轻量启发式：无议程或闲聊默认在轨；有议程时看是否有语义交集。"""
    goal = (agenda_goal or "").strip()
    user = (user_text or "").strip()
    if not goal:
        return True
    if not user:
        return True
    # 极短寒暄仍算可接受，不立刻判跑题
    if len(user) <= 6:
        return True
    # 从议程里抽 2 字以上片段做粗匹配（非意图路由，仅软轨计数）
    tokens = [goal[i : i + 2] for i in range(0, max(0, len(goal) - 1), 2)]
    hits = sum(1 for t in tokens if len(t) >= 2 and t in user)
    # 也看助手侧是否接住议程由常见词
    soft_keys = ("约", "忙", "节日", "周末", "见面", "最近", "今天", "记得", "天气")
    if any(k in goal and k in user for k in soft_keys):
        return True
    return hits >= 1


def _rules_judge(
    user_text: str,
    assistant_text: str,
    state: RelationshipState,
    *,
    character_id: str = "",
    cast_role: str = "romance",
    agenda_goal: str = "",
    scene_ctx: dict[str, Any] | None = None,
) -> JudgeResult:
    user = user_text.strip()
    if not user:
        return JudgeResult()

    aff_delta = 0
    trust_delta = 0
    mood_delta = 0
    flags: dict[str, bool] = {}

    for word in _POSITIVE:
        if word in user:
            aff_delta += 2
            trust_delta += 1
    for word in _NEGATIVE:
        if word in user:
            aff_delta -= 5
            trust_delta -= 4
            mood_delta -= 3
    if len(user) >= 40:
        aff_delta += 1
    if "?" in user or "？" in user:
        aff_delta += 1
    if any(w in assistant_text for w in ("开心", "谢谢", "喜欢", "心动", "害羞")):
        aff_delta += 1

    relation_move = _infer_relation_move(user, cast_role=cast_role)
    from .character_lores import is_linked_cast, linked_dating_unlocked

    if relation_move == "confess" and (
        cast_role == "npc"
        or (is_linked_cast(cast_role) and not linked_dating_unlocked(character_id, self_flags=dict(state.flags or {})))
    ):
        # 未破门告白：记同盟试探，不记成功恋爱
        flags["bond_ally_done"] = True
        flags["confess_blocked_gate"] = True
        aff_delta += 1
        trust_delta += 1

    if "骗" in user or "撒谎" in user:
        flags["trust_damaged"] = True
        trust_delta -= 6

    if is_linked_cast(cast_role) and character_id in _LINKED_BOND_FLAGS:
        if state.affinity + aff_delta >= 58 and state.turns >= 4:
            for f in _LINKED_BOND_FLAGS[character_id]:
                flags[f] = True

    aff_delta = max(-10, min(10, aff_delta))
    trust_delta = max(-12, min(8, trust_delta))
    mood_delta = max(-8, min(8, mood_delta))
    on_agenda = _agenda_overlap(user, agenda_goal)

    end_scene, end_reason = _infer_end_scene(
        assistant_text=assistant_text,
        state=state,
        agenda_goal=agenda_goal,
        scene_ctx=scene_ctx or {},
    )

    return JudgeResult(
        affinity_delta=aff_delta,
        trust_delta=trust_delta,
        mood_delta=mood_delta,
        new_flags=flags,
        reason="rules",
        on_agenda=on_agenda,
        relation_move=relation_move,
        end_scene=end_scene,
        end_scene_reason=end_reason,
    )


def _infer_end_scene(
    *,
    assistant_text: str,
    state: RelationshipState,
    agenda_goal: str,
    scene_ctx: dict[str, Any],
) -> tuple[bool, str]:
    """系统侧收束：疲劳/冷战/议程/剩余句数；助手道别句可加强。"""
    turns_left = int(scene_ctx.get("turns_left") if scene_ctx.get("turns_left") is not None else 99)
    fatigue = int(scene_ctx.get("fatigue") or 0)
    agenda_source = str(scene_ctx.get("agenda_source") or "")
    flags = dict(state.flags or {})
    if scene_ctx.get("cold_war"):
        flags["cold_war_active"] = True

    # 硬：最后一句必走
    if turns_left <= 0:
        return True, "she_leaves"
    if turns_left <= 1:
        return True, "she_leaves"

    # 议程 / 冷战 / 疲劳
    if agenda_source in {"busy", "quarrel"} and turns_left <= 3:
        return True, "busy" if agenda_source == "busy" else "awkward"
    if flags.get("cold_war_active") and turns_left <= 3:
        return True, "awkward"
    if fatigue >= 70 and turns_left <= 3:
        return True, "busy"
    if fatigue >= 85 and turns_left <= 4:
        return True, "busy"

    # 助手已在道别（规则启发，非意图路由主路径）
    bye_marks = ("我先走", "先这样", "下次再聊", "该走了", "有事先", "回头聊", "先回去")
    asst = assistant_text or ""
    if turns_left <= 2 and any(m in asst for m in bye_marks):
        return True, "she_leaves"

    # 低回合软概率：用确定性哈希避免 random 不稳定冒烟
    if turns_left <= 2:
        seed = f"{scene_ctx.get('character_id')}|{scene_ctx.get('turns_used')}|{agenda_goal[:8]}"
        h = sum(ord(c) for c in seed) % 100
        # turns_left==2 → 约 35%；结合疲劳加权
        thresh = 35 + (15 if fatigue >= 55 else 0)
        if h < thresh:
            return True, "she_leaves"

    return False, ""


def _llm_judge(
    settings: Settings,
    *,
    user_text: str,
    assistant_text: str,
    state: RelationshipState,
    profile: CharacterProfile,
    agenda_goal: str = "",
) -> JudgeResult | None:
    # 压缩 system + 截断输入；辅模型 + 低 max_tokens
    system = (
        "Gal关系裁决。只输出JSON。"
        "字段:affinity_delta(-10~10),trust_delta(-12~8),mood_delta(-8~8),"
        "new_flags(可选),ending_id(常null),on_agenda,"
        "relation_move(none|flirt|confess|ask_exclusive|propose_harem|mention_other|breakup),"
        "stage_offer(none|crush|dating|married),"
        "heroine_initiative(none|confess|ask_exclusive|cool_off),"
        "social_action(闲聊null;约见/吵架/冷战才填对象),"
        "end_scene,end_scene_reason(she_leaves|busy|awkward|),"
        f"reason(≤12字)。"
    )
    agenda_line = f"议程:{(agenda_goal or '闲聊')[:40]}"
    user = (
        f"{profile.name}|{state.stage_id}|好感{state.affinity}|信任{getattr(state, 'trust', 70)}\n"
        f"{agenda_line}\n"
        f"用户:{_clip(user_text, JUDGE_USER_CHARS)}\n"
        f"回复:{_clip(assistant_text, JUDGE_ASSISTANT_CHARS)}\n"
        "JSON:"
    )
    try:
        raw = chat_once_with_model(
            settings,
            model=aux_llm_model(settings),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=JUDGE_MAX_TOKENS,
            temperature=0.2,
        )
        m = re.search(r"\{[\s\S]*\}", raw)
        if not m:
            return None
        data = json.loads(m.group(0))
        # 规则兜底不做关键词抽 social_action；非法结构置 null
        sa = data.get("social_action")
        if sa is not None and not isinstance(sa, dict):
            data["social_action"] = None
        elif isinstance(sa, dict):
            from .social_actions import parse_social_action

            parsed = parse_social_action(sa)
            data["social_action"] = parsed.model_dump() if parsed else None
        return JudgeResult.model_validate(data)
    except Exception as ex:
        logger.warning("LLM judge failed: %s", ex)
        return None


def judge_turn(
    settings: Settings,
    *,
    user_text: str,
    assistant_text: str,
    state: RelationshipState,
    profile: CharacterProfile,
    mode: str = "rules",
    agenda_goal: str = "",
    scene_ctx: dict[str, Any] | None = None,
) -> JudgeResult:
    cast_role = getattr(profile, "cast_role", None) or "romance"
    cid = getattr(profile, "character_id", "") or ""
    rules = _rules_judge(
        user_text,
        assistant_text,
        state,
        character_id=cid,
        cast_role=str(cast_role),
        agenda_goal=agenda_goal,
        scene_ctx=scene_ctx,
    )
    if mode == "rules":
        return rules
    if mode == "llm":
        llm = _llm_judge(
            settings,
            user_text=user_text,
            assistant_text=assistant_text,
            state=state,
            profile=profile,
            agenda_goal=agenda_goal,
        )
        if not llm:
            return rules
        # 系统可强制收束；模型只能请求结束，不能否决系统硬结束
        if rules.end_scene and not llm.end_scene:
            return llm.model_copy(
                update={
                    "end_scene": True,
                    "end_scene_reason": rules.end_scene_reason or "she_leaves",
                }
            )
        if llm.end_scene and not llm.end_scene_reason:
            return llm.model_copy(update={"end_scene_reason": "she_leaves"})
        return llm
    # hybrid
    llm = _llm_judge(
        settings,
        user_text=user_text,
        assistant_text=assistant_text,
        state=state,
        profile=profile,
        agenda_goal=agenda_goal,
    )
    if not llm:
        return rules
    # 合并：数值取 LLM，end_scene 系统优先
    merged = llm.model_copy(
        update={
            "end_scene": bool(rules.end_scene or llm.end_scene),
            "end_scene_reason": rules.end_scene_reason
            or llm.end_scene_reason
            or ("she_leaves" if (rules.end_scene or llm.end_scene) else ""),
        }
    )
    return merged


def _stage_rank(stage_id: str) -> int:
    order = stage_order()
    if stage_id not in order:
        return -1
    return order.index(stage_id)


_GENERIC_FRIEND_ENDINGS = frozenset({"ending_friend", "ending_best_friend"})


def check_endings(
    *,
    character_id: str,
    state: RelationshipState,
    runtime: dict[str, Any],
) -> str | None:
    from .config import PROJECT_ROOT

    path = PROJECT_ROOT / "data" / "endings.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    route = get_route(character_id)
    allowed = set(route.allowed_endings if route else [])
    # 有 route 时：白名单为空 = 明确禁止任何结局（NPC）；无 route 才放行旧逻辑
    whitelist_strict = route is not None

    flags = runtime.get("flags") or state.flags or {}
    trust = int(runtime.get("trust", state.trust))
    affinity = state.affinity
    low_streak = int(runtime.get("low_streak", state.low_streak))

    type_order = {"secret": 0, "good": 1, "normal": 2, "bad": 3}

    def _ending_rank(ending: dict[str, Any]) -> tuple:
        eid = str(ending.get("id") or "")
        typ = type_order.get(str(ending.get("type") or ""), 9)
        char_ids = ending.get("character_ids") or []
        # 专属结局优先于泛用恋人/结婚，避免 ending_lover 抢在真线好结局之前
        specific = 0 if (char_ids and character_id in char_ids) else 1
        cond = ending.get("conditions") or {}
        flag_depth = len(cond.get("flags_all") or []) + len(cond.get("flags_any") or [])
        return (typ, specific, -flag_depth, eid)

    endings_sorted = sorted(data.get("endings") or [], key=_ending_rank)

    cast_role = "romance"
    if route is not None and getattr(route, "cast_role", None):
        cast_role = str(route.cast_role)
    else:
        cast_role = str(runtime.get("cast_role") or "romance")

    for ending in endings_sorted:
        eid = ending.get("id")
        if not eid:
            continue
        if whitelist_strict and eid not in allowed:
            continue
        roles = ending.get("cast_roles") or []
        if roles and cast_role not in roles:
            continue
        char_ids = ending.get("character_ids") or []
        if char_ids and character_id not in char_ids:
            continue
        cond = ending.get("conditions") or {}
        ok = True

        stage_min = cond.get("stage_min")
        if stage_min and _stage_rank(state.stage_id) < _stage_rank(str(stage_min)):
            ok = False
        stage_max = cond.get("stage_max")
        if stage_max and _stage_rank(state.stage_id) > _stage_rank(str(stage_max)):
            ok = False
        if cond.get("affinity_min") is not None and affinity < int(cond["affinity_min"]):
            ok = False
        if cond.get("affinity_max") is not None and affinity > int(cond["affinity_max"]):
            ok = False
        if cond.get("trust_min") is not None and trust < int(cond["trust_min"]):
            ok = False
        if cond.get("trust_max") is not None and trust > int(cond["trust_max"]):
            ok = False
        any_flags = cond.get("flags_any") or []
        if any_flags and not any(flags.get(str(f)) for f in any_flags):
            ok = False
        for flag in cond.get("flags_all") or []:
            if not flags.get(str(flag)):
                ok = False
                break
        for flag in cond.get("flags_present") or []:
            if not flags.get(str(flag)):
                ok = False
                break
        for flag in cond.get("flags_absent") or []:
            if flags.get(str(flag)):
                ok = False
                break
        if cond.get("low_streak_min") is not None and low_streak < int(cond["low_streak_min"]):
            ok = False

        # 通用朋友结局：romance 未 ready 不中途结算
        if ok and cast_role == "romance" and str(eid) in _GENERIC_FRIEND_ENDINGS:
            if not flags.get("ending_ready"):
                ok = False

        # 真结局守门（strict）
        if ok:
            from .route_difficulty import secret_gate_blocks

            if secret_gate_blocks(
                character_id,
                flags=flags,
                ending_type=str(ending.get("type") or ""),
            ):
                ok = False

        if ok:
            return str(eid)
    return None


def load_ending_meta(ending_id: str) -> dict[str, Any] | None:
    from .config import PROJECT_ROOT
    from .presentation import resolve_ending_presentation

    path = PROJECT_ROOT / "data" / "endings.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    for ending in data.get("endings") or []:
        if ending.get("id") == ending_id:
            row = dict(ending)
            chars = row.get("character_ids") or []
            cid = str(chars[0]) if chars else ""
            present = resolve_ending_presentation(
                str(ending_id),
                ending_type=str(row.get("type") or "good"),
                character_id=cid,
            )
            row["presentation"] = present
            return row
    return None
