"""Gaokao ending matrix: grade band × romance stage (zero LLM)."""

from __future__ import annotations

from typing import Any

# rank bands
GRADE_TOP = "top"  # 1-3
GRADE_GOOD = "good"  # 4-10
GRADE_MID = "mid"  # 11-20
GRADE_LOW = "low"  # 21+

# romance buckets for matrix (coarse)
ROM_NONE = "none"
ROM_FRIEND = "friend"
ROM_CLOSE = "close"
ROM_CRUSH = "crush"
ROM_DATING = "dating"

_MATRIX: dict[tuple[str, str], dict[str, str]] = {
    (GRADE_TOP, ROM_DATING): {
        "ending_id": "gold_couple",
        "title": "金榜 · 并肩",
        "tone": "金榜题名·双人终章",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数与感情都落在高处——你和{name}约好了，夏天之后仍要见面。",
    },
    (GRADE_TOP, ROM_CRUSH): {
        "ending_id": "gold_crush",
        "title": "金榜 · 未说出口",
        "tone": "金榜题名·心动未告白",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。你站在最前列，却把对{name}的话留在了高考铃响之后。",
    },
    (GRADE_TOP, ROM_CLOSE): {
        "ending_id": "gold_close",
        "title": "金榜 · 挚友",
        "tone": "金榜题名·挚友同行",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。顶尖成绩之外，{name}是百日里最稳的并肩者。",
    },
    (GRADE_TOP, ROM_FRIEND): {
        "ending_id": "gold_friend",
        "title": "金榜 · 同学录",
        "tone": "金榜题名·浅淡友谊",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。你冲到了最前，同学录上{name}写下「加油」。",
    },
    (GRADE_TOP, ROM_NONE): {
        "ending_id": "gold_solo",
        "title": "金榜 · 独行",
        "tone": "金榜题名",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。百日冲刺收官，你站在了最前列。感情线尚浅，故事仍可重开。",
    },
    (GRADE_GOOD, ROM_DATING): {
        "ending_id": "steady_couple",
        "title": "稳中有进 · 恋人",
        "tone": "稳中有进·恋爱终章",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。成绩扎实，前路可期——而{name}已经握住了你的手。",
    },
    (GRADE_GOOD, ROM_CRUSH): {
        "ending_id": "steady_crush",
        "title": "稳中有进 · 心动",
        "tone": "稳中有进·心动未定",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数稳住了，对{name}的心意却还悬在半空。",
    },
    (GRADE_GOOD, ROM_CLOSE): {
        "ending_id": "steady_close",
        "title": "稳中有进 · 亲近",
        "tone": "稳中有进·亲近同行",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。你与{name}的距离近到可以分享错题本。",
    },
    (GRADE_GOOD, ROM_FRIEND): {
        "ending_id": "steady_friend",
        "title": "稳中有进 · 朋友",
        "tone": "稳中有进·友谊线",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。成绩扎实；与{name}的友谊，是冲刺路上的缓冲带。",
    },
    (GRADE_GOOD, ROM_NONE): {
        "ending_id": "steady_solo",
        "title": "稳中有进",
        "tone": "稳中有进",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。成绩扎实，前路可期。感情线尚浅，故事仍可重开。",
    },
    (GRADE_MID, ROM_DATING): {
        "ending_id": "ordinary_couple",
        "title": "普通发挥 · 恋人",
        "tone": "普通发挥·恋爱优先",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数不算惊艳，但你撑过了这 100 天——{name}说，够了。",
    },
    (GRADE_MID, ROM_CRUSH): {
        "ending_id": "ordinary_crush",
        "title": "普通发挥 · 心动",
        "tone": "普通发挥·心动余温",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。考场外，你仍惦记着{name}转头看你的那一瞬。",
    },
    (GRADE_MID, ROM_CLOSE): {
        "ending_id": "ordinary_close",
        "title": "普通发挥 · 亲近",
        "tone": "普通发挥·亲近收束",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。不算惊艳，但你与{name}把百日过成了彼此记得的夏天。",
    },
    (GRADE_MID, ROM_FRIEND): {
        "ending_id": "ordinary_friend",
        "title": "普通发挥 · 朋友",
        "tone": "普通发挥·友谊收束",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。你撑过了这 100 天；同学录里{name}的字迹很工整。",
    },
    (GRADE_MID, ROM_NONE): {
        "ending_id": "ordinary_solo",
        "title": "普通发挥",
        "tone": "普通发挥",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。不算惊艳，但你撑过了这 100 天。感情线尚浅，故事仍可重开。",
    },
    (GRADE_LOW, ROM_DATING): {
        "ending_id": "road_couple",
        "title": "仍在路上 · 恋人",
        "tone": "仍在路上·感情托底",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数之外，{name}记得你的夏天——那或许比名次更重。",
    },
    (GRADE_LOW, ROM_CRUSH): {
        "ending_id": "road_crush",
        "title": "仍在路上 · 心动",
        "tone": "仍在路上·心动未竟",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数之外，还有对{name}没说完的话。",
    },
    (GRADE_LOW, ROM_CLOSE): {
        "ending_id": "road_close",
        "title": "仍在路上 · 亲近",
        "tone": "仍在路上·亲近余温",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数之外，{name}仍记得你的夏天。",
    },
    (GRADE_LOW, ROM_FRIEND): {
        "ending_id": "road_friend",
        "title": "仍在路上 · 朋友",
        "tone": "仍在路上·友谊余温",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数之外，还有人记得你——比如{name}。",
    },
    (GRADE_LOW, ROM_NONE): {
        "ending_id": "road_solo",
        "title": "仍在路上",
        "tone": "仍在路上",
        "blurb": "班级第 {rank} 名，总分 {total:.0f}。分数之外，故事仍可重开。",
    },
}


def grade_band(pc_rank: int) -> str:
    if pc_rank <= 3:
        return GRADE_TOP
    if pc_rank <= 10:
        return GRADE_GOOD
    if pc_rank <= 20:
        return GRADE_MID
    return GRADE_LOW


def romance_bucket(stage: str | None, affinity: float) -> str:
    if affinity < 35 or not stage:
        return ROM_NONE
    if stage == "dating":
        return ROM_DATING
    if stage == "crush":
        return ROM_CRUSH
    if stage == "close":
        return ROM_CLOSE
    if stage in {"friend", "acquaintance"}:
        return ROM_FRIEND
    return ROM_NONE


def resolve_ending(
    *,
    pc_rank: int,
    pc_total: float,
    romance: dict[str, Any] | None,
) -> dict[str, Any]:
    band = grade_band(pc_rank)
    if romance:
        # 前任不按 dating 桶，走 close/friend
        if romance.get("was_dating") and str(romance.get("stage") or "") != "dating":
            stage_for_bucket = "close" if float(romance.get("affinity") or 0) >= 55 else "friend"
        else:
            stage_for_bucket = str(romance.get("stage") or "")
        bucket = romance_bucket(stage_for_bucket, float(romance.get("affinity") or 0))
        name = str(romance.get("name") or "那个人")
    else:
        bucket = ROM_NONE
        name = ""
    tpl = _MATRIX.get((band, bucket)) or _MATRIX[(band, ROM_NONE)]
    blurb = tpl["blurb"].format(rank=pc_rank, total=pc_total, name=name or "同学")
    return {
        "ending_id": tpl["ending_id"],
        "title": tpl["title"],
        "tone": tpl["tone"],
        "blurb": blurb,
        "grade_band": band,
        "romance_bucket": bucket,
    }


def fallback_verdict_from_matrix(ending_id: str, *, romance: dict[str, Any] | None) -> dict[str, Any]:
    """Deterministic verdict when ending LLM unavailable."""
    eid = ending_id or ""
    dating = bool(romance) and str(romance.get("stage") or "") == "dating"
    was_ex = bool(romance) and bool(romance.get("was_dating")) and not dating
    if eid.startswith("gold_") and dating:
        verdict, with_you = "true", True
        line = "金榜旁还有并肩的人——这算难得的好结局。"
    elif eid.startswith("gold_"):
        verdict, with_you = "good", bool(romance) and not was_ex
        line = "成绩落在高处；感情线或许还留白，但夏天记住了你。"
    elif eid.startswith("steady_") and dating:
        verdict, with_you = "good", True
        line = "分数稳住了，也握住了手——算是好好过完了这百日。"
    elif eid.startswith("steady_"):
        verdict, with_you = "good" if romance else "soft", bool(romance) and not was_ex
        line = "稳中有进的收束；有人记得你，就不算独行。"
    elif eid.startswith("ordinary_") and dating:
        verdict, with_you = "soft", True
        line = "名次普通，但有人说够了——软一点的好结局。"
    elif eid.startswith("road_") and dating:
        verdict, with_you = "soft", True
        line = "分数之外，感情托了一把底。"
    elif was_ex:
        verdict, with_you = "soft", False
        line = "有过并肩，也有过告别——余温还在，但算不上圆满。"
    elif eid.startswith("road_"):
        verdict, with_you = "bad", False
        line = "仍在路上；分数与感情都还差一口气。"
    else:
        verdict, with_you = "soft", bool(romance)
        line = "百日收官。故事可以重开，也可以就此记住。"
    return {
        "verdict": verdict,
        "with_you_ok": with_you,
        "epilogue_line": line,
        "judgment": "matrix_fallback",
        "source": "matrix",
    }
