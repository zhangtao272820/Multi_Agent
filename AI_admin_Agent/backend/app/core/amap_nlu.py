"""
高德地图语义理解：由大模型拆解路线/周边/地址等参数，配合浏览器定位。
禁止用正则从用户原话抽取地点与出行方式。
"""
from __future__ import annotations

import json
from typing import Any

from app.core.amap_context import (
    apply_client_location_to_tool_args,
    format_client_location_line,
)
from app.core.config import settings
from app.core.llm import qwen_llm

_VALID_MODES = {"driving", "transit", "walk", "bike"}
_VALID_QUERY_TYPES = {"route", "nearby", "place_search", "geocode", "suggest", "none"}
_TOOL_BY_QUERY = {
    "route": "get_travel_route",
    "nearby": "search_nearby_amap",
    "place_search": "search_places_amap",
    "geocode": "resolve_address_amap",
    "suggest": "suggest_address_amap",
}
_SCENARIO_BY_QUERY = {
    "route": "travel_route",
    "nearby": "amap_poi",
    "place_search": "amap_poi",
    "geocode": "amap_geocode",
    "suggest": "amap_geocode",
}


def scenario_id_for_query_type(query_type: str | None) -> str | None:
    """将 amap query_type 映射为 admin_scenario id（非 raw route/nearby）。"""
    qt = str(query_type or "").strip().lower()
    return _SCENARIO_BY_QUERY.get(qt)


def _extract_json_object(raw_text: str) -> dict[str, Any]:
    text = (raw_text or "").strip()
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    start_idx = text.find("{")
    if start_idx < 0:
        raise ValueError("No JSON object found.")
    depth = 0
    in_string = False
    escaped = False
    for idx in range(start_idx, len(text)):
        ch = text[idx]
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                parsed = json.loads(text[start_idx : idx + 1])
                if not isinstance(parsed, dict):
                    raise ValueError("Parsed JSON is not an object.")
                return parsed
    raise ValueError("No complete JSON object found.")


def should_resolve_amap_from_understanding(
    understanding: dict[str, Any] | None,
    scenario: str | None = None,
) -> bool:
    """根据语义理解/场景判断是否需要调用高德理解模型（不扫用户原话正则）。"""
    if isinstance(understanding, dict):
        intent = str(understanding.get("intent") or "").strip()
        if intent == "天气":
            return False
    if scenario in ("travel_route", "amap_poi", "amap_geocode"):
        return True
    if not isinstance(understanding, dict):
        return False
    if understanding.get("has_location_query") is True:
        return True
    qt = str(understanding.get("amap_query_type") or "").strip().lower()
    return bool(qt and qt != "none")


def detect_amap_scenario(
    understanding: dict[str, Any] | None,
    user_message: str,
    intent: str = "",
) -> str | None:
    """优先用模型标注的 amap_query_type / admin_scenario，其次 LLM+RAG 场景解析。"""
    if isinstance(understanding, dict):
        admin_sc = str(understanding.get("admin_scenario") or "").strip()
        if admin_sc in _SCENARIO_BY_QUERY.values():
            return admin_sc
        qt = str(understanding.get("amap_query_type") or "").strip().lower()
        if qt in _SCENARIO_BY_QUERY:
            return _SCENARIO_BY_QUERY[qt]
        resolved = understanding.get("resolved_amap")
        if isinstance(resolved, dict) and resolved.get("ok"):
            qt2 = str(resolved.get("query_type") or "").strip().lower()
            if qt2 in _SCENARIO_BY_QUERY:
                return _SCENARIO_BY_QUERY[qt2]
    from app.core.admin_nlu import resolve_admin_scenario

    sc = resolve_admin_scenario(user_message, intent=intent, understanding=understanding)
    if sc in _SCENARIO_BY_QUERY.values():
        return sc
    return None


def _normalize_mode(value: str) -> str:
    mode = str(value or "").strip().lower()
    if mode in ("compare", "all", "multi"):
        return "compare"
    if mode in _VALID_MODES:
        return mode
    return "driving"


def _normalize_tool_args(tool_name: str, raw_args: Any) -> dict[str, Any]:
    args = raw_args if isinstance(raw_args, dict) else {}
    if tool_name == "get_travel_route":
        mode = _normalize_mode(str(args.get("mode") or ""))
        compare_modes = bool(args.get("compare_modes")) or mode == "compare"
        return {
            "origin": str(args.get("origin") or "").strip(),
            "destination": str(args.get("destination") or "").strip(),
            "mode": "driving" if compare_modes else mode,
            "compare_modes": compare_modes,
        }
    if tool_name == "search_nearby_amap":
        return {
            "keywords": str(args.get("keywords") or "餐饮").strip() or "餐饮",
            "near_address": str(args.get("near_address") or "").strip(),
            "radius_m": int(args.get("radius_m") or 3000),
        }
    if tool_name == "search_places_amap":
        return {
            "keywords": str(args.get("keywords") or "").strip(),
            "city": str(args.get("city") or settings.ADMIN_AMAP_CITY or "").strip(),
        }
    if tool_name == "resolve_address_amap":
        return {
            "address": str(args.get("address") or "").strip(),
            "city": str(args.get("city") or settings.ADMIN_AMAP_CITY or "").strip(),
        }
    if tool_name == "suggest_address_amap":
        return {
            "keywords": str(args.get("keywords") or "").strip(),
            "city": str(args.get("city") or settings.ADMIN_AMAP_CITY or "").strip(),
        }
    return {k: v for k, v in args.items() if v is not None}


def _args_complete(tool_name: str, args: dict[str, Any], *, has_client_location: bool) -> bool:
    if tool_name == "get_travel_route":
        dest = str(args.get("destination") or "").strip()
        origin = str(args.get("origin") or "").strip()
        if not dest:
            return False
        return bool(origin or has_client_location)
    if tool_name == "search_nearby_amap":
        keywords = str(args.get("keywords") or "").strip()
        near = str(args.get("near_address") or "").strip()
        return bool(keywords and (near or has_client_location))
    if tool_name == "search_places_amap":
        return bool(str(args.get("keywords") or "").strip())
    if tool_name in ("resolve_address_amap", "suggest_address_amap"):
        key = "address" if tool_name == "resolve_address_amap" else "keywords"
        return bool(str(args.get(key) or "").strip())
    return False


def build_amap_tool_plan(
    resolved: dict[str, Any] | None,
    client_context: dict | None = None,
) -> dict[str, Any] | None:
    """把 resolved_amap 转为可执行的工具计划项。"""
    if not isinstance(resolved, dict) or not resolved.get("ok"):
        return None
    tool_name = str(resolved.get("tool_name") or "").strip()
    if not tool_name:
        qt = str(resolved.get("query_type") or "").strip().lower()
        tool_name = _TOOL_BY_QUERY.get(qt, "")
    if not tool_name:
        return None
    uses_here = bool(resolved.get("uses_current_location"))
    args = apply_client_location_to_tool_args(
        tool_name,
        _normalize_tool_args(tool_name, resolved.get("tool_args")),
        client_context,
        uses_current_location=uses_here,
    )
    has_loc = bool(format_client_location_line(client_context) != "（未共享）")
    if not _args_complete(tool_name, args, has_client_location=has_loc):
        return None
    return {"name": tool_name, "args": args}


def resolve_amap_with_llm(
    user_message: str,
    *,
    client_context: dict | None = None,
    scenario: str | None = None,
    understanding: dict | None = None,
) -> dict[str, Any]:
    """用大模型拆解高德相关工具参数。"""
    location_line = format_client_location_line(client_context)
    default_city = str(settings.ADMIN_AMAP_CITY or "").strip() or "全国"
    slots = {}
    hint_type = ""
    if isinstance(understanding, dict):
        hint_type = str(understanding.get("amap_query_type") or "").strip()
        slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}

    prompt = f"""你是高德地图语义解析器（中文 + 英文）。根据用户原话提取调用地图 API 所需的参数。
禁止编造用户未提及的地点；禁止凭常识估算路线耗时。

用户原话: "{user_message}"
场景提示（可能为空）: "{scenario or ""}"
初步 query 类型（可能为空）: "{hint_type}"
初步槽位（JSON，可能为空）: {json.dumps(slots, ensure_ascii=False)}
默认城市（POI 搜索可引用）: {default_city}
用户当前位置（浏览器共享，可能未授权）: {location_line}

规则:
1. route（路线/多久到/怎么去）→ tool_name=get_travel_route，填 origin、destination、mode。
   - mode 仅允许 driving|transit|walk|bike|compare；地铁/公交用 transit，步行 walk，骑行 bike，驾车 driving。
   - 用户**未指定**出行方式、或要求「对比/哪种最快/怎么走方便」时：mode=compare 或 compare_modes=true（将同时对比驾车、公交/地铁、步行）。
   - 用户明确说「开车/地铁/步行」等时只用对应 mode，不要 compare。
   - 用户说「从这/这里/当前位置」出发时 uses_current_location=true，origin 可留空。
2. nearby（附近/周边 POI）→ tool_name=search_nearby_amap，填 keywords、near_address。
   - 只说「附近咖啡」且已共享定位时 uses_current_location=true，near_address 可留空。
3. place_search（搜店名/地标）→ tool_name=search_places_amap，填 keywords，city 可空。
4. geocode（地址在哪/解析地址）→ tool_name=resolve_address_amap，填 address。
5. suggest（地址补全）→ tool_name=suggest_address_amap，填 keywords。
6. 与地图无关则 ok=false, query_type=none。
7. 缺关键信息（如路线无终点、周边无关键词）时 ok=false，reason 说明缺什么。

只输出一个 JSON（不要其它文字）:
{{
  "ok": true,
  "query_type": "route",
  "tool_name": "get_travel_route",
  "tool_args": {{"origin": "[起点]", "destination": "[终点]", "mode": "transit"}},
  "uses_current_location": false,
  "reason": ""
}}
"""
    try:
        raw = qwen_llm.chat_text_json([{"role": "user", "content": prompt}])
        data = _extract_json_object(raw)
    except Exception as e:
        return {"ok": False, "query_type": "none", "reason": f"地图语义理解失败: {e}"}

    if not data.get("ok"):
        return {
            "ok": False,
            "query_type": str(data.get("query_type") or "none"),
            "reason": str(data.get("reason") or "未能识别地图查询意图"),
        }

    query_type = str(data.get("query_type") or "").strip().lower()
    if query_type not in _VALID_QUERY_TYPES:
        query_type = "none"
    tool_name = str(data.get("tool_name") or _TOOL_BY_QUERY.get(query_type, "")).strip()
    uses_here = bool(data.get("uses_current_location"))
    tool_args = apply_client_location_to_tool_args(
        tool_name,
        _normalize_tool_args(tool_name, data.get("tool_args")),
        client_context,
        uses_current_location=uses_here,
    )
    has_loc = location_line != "（未共享）"
    if not _args_complete(tool_name, tool_args, has_client_location=has_loc):
        return {
            "ok": False,
            "query_type": query_type,
            "tool_name": tool_name,
            "tool_args": tool_args,
            "uses_current_location": uses_here,
            "reason": str(data.get("reason") or "缺少地点或终点，请补充说明或允许浏览器定位"),
        }

    return {
        "ok": True,
        "query_type": query_type,
        "tool_name": tool_name,
        "tool_args": tool_args,
        "uses_current_location": uses_here,
        "reason": str(data.get("reason") or "").strip(),
    }
