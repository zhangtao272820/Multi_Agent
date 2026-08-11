"""言情声纹卡：短块常驻，控 token。"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import PROJECT_ROOT

VOICE_MAX = 80


@lru_cache(maxsize=1)
def load_voice_cards() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "romance_voice_cards.json"
    if not path.is_file():
        return {"cards": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def reload_voice_cards() -> dict[str, Any]:
    load_voice_cards.cache_clear()
    return load_voice_cards()


def voice_card_for(character_id: str) -> dict[str, Any] | None:
    cid = (character_id or "").strip()
    if not cid:
        return None
    return (load_voice_cards().get("cards") or {}).get(cid)


def voice_prompt_block(character_id: str) -> str:
    card = voice_card_for(character_id)
    if not card:
        return ""
    voice = (card.get("voice") or "").strip()
    if not voice:
        return ""
    if len(voice) > VOICE_MAX:
        voice = voice[:VOICE_MAX]
    genre = (card.get("genre") or "").strip()
    do = [str(x).strip() for x in (card.get("do") or [])[:3] if str(x).strip()]
    dont = [str(x).strip() for x in (card.get("dont") or [])[:3] if str(x).strip()]
    bits = [f"气质：{genre}"] if genre else []
    bits.append(voice)
    if do:
        bits.append("口语倾向：" + "、".join(do))
    if dont:
        bits.append("避免：" + "、".join(dont))
    # keep full block modest; voice itself already ≤80
    body = " ".join(bits)
    if len(body) > 160:
        body = voice if genre == "" else f"{genre}。{voice}"
        if len(body) > 100:
            body = body[:100]
    return f"\n【声纹】{body}"
