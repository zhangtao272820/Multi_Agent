"""
日程/待办/邮件/地图等确定性规划：NLU + 时间模型已填槽，或总管 manager_task 已对齐时跳过 planning LLM。
"""
from __future__ import annotations

import os
import re
from typing import Any


def is_admin_plan_fastpath_enabled() -> bool:
    from .admin_env_modes import resolve_admin_nlu_mode

    mode = resolve_admin_nlu_mode()
    if mode == "legacy":
        return False
    explicit = os.getenv("ADMIN_PLAN_FASTPATH", "").strip().lower()
    if explicit in ("off", "0", "false", "no", "disabled"):
        return False
    if explicit in ("on", "1", "true", "yes", "fastpath"):
        return True
    return mode in ("full", "fast")


def is_admin_memory_fast_enabled() -> bool:
    return os.getenv("ADMIN_MEMORY_FAST", "1").strip() not in ("0", "false", "no")


def _slot_str(slots: dict[str, Any], key: str) -> str:
    v = slots.get(key)
    return str(v).strip() if v is not None else ""


def _includes_any(text: str, terms: tuple[str, ...]) -> bool:
    s = str(text or "")
    return any(t and t in s for t in terms)


def _includes_any_ci(text: str, terms: tuple[str, ...]) -> bool:
    s = str(text or "").lower()
    return any(t and t.lower() in s for t in terms)


def _looks_like_list_intent(action_text: str) -> bool:
    msg = str(action_text or "")
    return any(w in msg for w in ("列出", "查看", "有哪些", "列表", "收件箱", "未读", "list "))


def _looks_like_bulk_delete_meeting_reminders(text: str) -> bool:
    """用户明确「删除/取消全部」会议提醒/日程：走批量工具，禁止单条澄清。"""
    s = str(text or "").strip()
    if not s:
        return False
    delete_like = _includes_any(s, ("删除", "删掉", "取消", "清空", "清除"))
    all_like = _includes_any(s, ("所有", "全部", "通通", "一键"))
    target_like = _includes_any(s, ("会议", "提醒", "日程", "日历"))
    return delete_like and all_like and target_like


def _bulk_delete_plan() -> list[dict[str, Any]]:
    return [{"name": "delete_all_meeting_reminders", "args": {}}]


def suppress_clarify_for_bulk_delete(
    understanding: dict[str, Any] | None,
    user_message: str = "",
) -> dict[str, Any]:
    """
    编排产出闸：批量删除语义已明确时，清空「哪个会议」类错误澄清。
    不对用户原话做意图路由，只校正 understanding 产物。
    """
    und: dict[str, Any] = dict(understanding) if isinstance(understanding, dict) else {}
    msg = str(user_message or "").strip()
    if not _looks_like_bulk_delete_meeting_reminders(msg):
        return und
    und["needs_clarification"] = False
    und["clarification_questions"] = []
    if not str(und.get("intent") or "").strip() or und.get("intent") == "其他":
        und["intent"] = "日程"
    return und


def _extract_quoted(text: str) -> str:
    import re

    for pat in (
        r"[「『\"]([^」』\"]+)[」』\"]",
        r"《([^》]+)》",
        r"『([^』]+)』",
    ):
        m = re.search(pat, text)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return ""


def _looks_like_composite_manager_dump(text: str) -> bool:
    """复合总管问句/整段原话，禁止当会议标题或 description。"""
    s = str(text or "").strip()
    if len(s) < 28:
        return False
    data_marks = ("知识库", "检索", "数据库", "图表", "对比图", "提炼要点", "生成对比")
    meeting_marks = ("会议", "日程", "提醒", "标题为", "周会")
    has_data = any(m in s for m in data_marks)
    has_meeting = any(m in s for m in meeting_marks)
    if has_data and has_meeting:
        return True
    if s.count("，") + s.count(",") >= 2 and len(s) >= 40:
        return True
    return False


def resolve_event_title(action_text: str, slots: dict[str, Any] | None = None) -> str:
    """
    会议标题：槽位 > 「」引号 > 标题为… > 短句 strip。
    禁止把复合总管原话截断当 title。
    """
    slot_title = ""
    if isinstance(slots, dict):
        slot_title = str(slots.get("event_title") or "").strip()
    if slot_title and not _looks_like_composite_manager_dump(slot_title):
        return slot_title[:80]
    action = str(action_text or "").strip()
    quoted = _extract_quoted(action)
    if quoted and not _looks_like_composite_manager_dump(quoted):
        return quoted[:80]
    for marker in ("标题为", "标题：", "标题:", "名为", "叫做"):
        idx = action.find(marker)
        if idx < 0:
            continue
        tail = action[idx + len(marker) :].strip()
        q = _extract_quoted(tail)
        if q and not _looks_like_composite_manager_dump(q):
            return q[:80]
        # 取到下一标点
        buf = []
        for ch in tail:
            if ch in ("，", ",", "。", "；", ";", "\n"):
                break
            buf.append(ch)
        cand = "".join(buf).strip().strip("「」\"'")
        if cand and not _looks_like_composite_manager_dump(cand) and len(cand) <= 40:
            return cand[:80]
    stripped = _strip_action_prefix(action)
    if stripped and not _looks_like_composite_manager_dump(stripped) and len(stripped) <= 40:
        return stripped[:80]
    return ""


def resolve_event_description(
    action_text: str,
    title: str,
    slots: dict[str, Any] | None = None,
) -> str:
    """详细内容：优先 slots.event_description；禁止用 title 顶替；未给则空。"""
    if isinstance(slots, dict):
        slot_desc = str(slots.get("event_description") or "").strip()
        t = str(title or "").strip()
        if slot_desc and (not t or slot_desc != t) and not _looks_like_composite_manager_dump(slot_desc):
            return slot_desc[:2000]
    # 不再把 title / 整段 action 塞进 description（normalize 也会清掉 title==description）
    return ""


def resolve_task_description(
    title: str,
    slots: dict[str, Any] | None = None,
) -> str:
    """待办详细说明：优先 slots.task_description；禁止用 title 顶替。"""
    if isinstance(slots, dict):
        slot_desc = str(slots.get("task_description") or "").strip()
        t = str(title or "").strip()
        if slot_desc and (not t or slot_desc != t):
            return slot_desc[:2000]
    return ""


def build_playground_plan_from_text(action_text: str) -> list[dict[str, Any]] | None:
    """玩法台：热榜 / B 站等确定性快路径，避免 planning LLM 卡住。"""
    if not is_admin_plan_fastpath_enabled():
        return None
    action = str(action_text or "").strip()
    if not action:
        return None
    from app.tools.registry import AVAILABLE_TOOLS

    hot_kw = ("热搜", "热榜", "热点", "摸鱼", "流行", "今日热门", "十大热点")
    quote_kw = ("每日一句", "来一句", "一句话", "语录", "鸡汤", "名言", "今日一句")
    wiki_kw = ("百科", "冷知识", "盲盒", "涨知识", "随机知识", "开盒")
    tech_kw = ("github", "hacker news", "hn", "技术趋势", "开源热门", "技术脉搏", "科技圈", "技术动态")
    bili_kw = ("b站", "bilibili", "哔哩", "B 站", "B站")
    search_kw = ("搜", "找", "推荐", "教程", "视频", "有什么")

    if _includes_any(action, quote_kw):
        if "get_daily_quote" in AVAILABLE_TOOLS:
            theme = "诗词" if "诗" in action else ""
            return [{"name": "get_daily_quote", "args": {"theme": theme}}]

    if _includes_any(action, wiki_kw):
        if "random_wiki_trivia" in AVAILABLE_TOOLS:
            return [{"name": "random_wiki_trivia", "args": {}}]

    if _includes_any_ci(action, tech_kw):
        source = "all"
        if "github" in action.lower():
            source = "github"
        elif "hn" in action.lower() or "hacker" in action.lower():
            source = "hn"
        if "get_tech_pulse" in AVAILABLE_TOOLS:
            return [{"name": "get_tech_pulse", "args": {"source": source, "limit": 8}}]

    if _includes_any(action, hot_kw):
        platform = "all"
        if "微博" in action:
            platform = "weibo"
        elif "知乎" in action:
            platform = "zhihu"
        elif _includes_any(action, bili_kw):
            platform = "bilibili"
        if "get_hot_topics" in AVAILABLE_TOOLS:
            return [{"name": "get_hot_topics", "args": {"platform": platform, "limit": 10}}]

    if _includes_any(action, bili_kw) and _includes_any(action, search_kw):
        query = _extract_quoted(action)
        if not query:
            import re

            m = re.search(r"(?:搜|搜索|找)[^「」]*?[「『\"]?([^」』\"，。！？]+)", action)
            query = (m.group(1).strip() if m else "") or action
            for prefix in ("B站", "B 站", "bilibili", "哔哩哔哩", "搜", "搜索", "找", "推荐"):
                query = query.replace(prefix, "").strip()
        if query and "search_bilibili" in AVAILABLE_TOOLS:
            return [{"name": "search_bilibili", "args": {"query": query[:80], "limit": 5}}]

    if _includes_any(action, ("arxiv", "论文", "预印本")) and _includes_any(action, search_kw):
        query = _extract_quoted(action) or action
        if "search_arxiv" in AVAILABLE_TOOLS:
            return [{"name": "search_arxiv", "args": {"query": query[:120], "max_results": 5}}]

    return None


def _strip_action_prefix(action: str) -> str:
    s = str(action or "").strip()
    for prefix in ("请", "帮我", "根据分析结果", "根据", "基于", "然后", "并"):
        if s.startswith(prefix):
            s = s[len(prefix) :].strip()
    for verb in ("创建", "添加", "安排", "预约", "设置", "建立", "发", "写"):
        idx = s.find(verb)
        if 0 <= idx <= 12:
            s = s[idx + len(verb) :].strip()
            break
    return re.sub(r"^[：:，,。.\s]+", "", s).strip() or str(action or "").strip()


def _has_time_hint(text: str) -> bool:
    s = str(text or "")
    if re.search(r"\d{1,2}[:：]\d{2}", s):
        return True
    return _includes_any(
        s,
        ("点", "时", "分", "明天", "后天", "下周", "今天", "上午", "下午", "晚上", "周一", "周二", "周三", "周四", "周五", "周六", "周日"),
    ) or bool(re.search(r"\d+月\d+日", s))


def is_admin_legacy_infer_enabled() -> bool:
    from .admin_env_modes import resolve_admin_nlu_mode

    return resolve_admin_nlu_mode() == "legacy"


def infer_intent_from_action(action_text: str) -> str:
    if not is_admin_legacy_infer_enabled():
        return "其他"
    action = str(action_text or "").strip()
    if not action:
        return "其他"
    if _includes_any(action, ("路线", "导航", "多久到", "多久", "怎么走", "通勤", "车程", "多远", "出行", "高德", "地铁", "公交", "驾车", "步行", "骑行", "到站")):
        return "混合任务"
    if _includes_any(action, ("附近", "周边", "POI", "地图")):
        return "混合任务"
    if _includes_any(action, ("邮件", "发信", "写邮件", "回信", "收件箱", "未读")):
        return "邮件"
    if _includes_any(action, ("联系人", "通讯录", "add contact", "contact email")):
        return "联系人"
    if _includes_any(action, ("提醒", "闹钟", "叫我", "通知我")):
        return "日程"
    if _includes_any(action, ("待办", "任务", "todo")):
        return "待办"
    if _includes_any(action, ("日程", "会议", "预约", "安排", "日历", "改期", "取消会议")):
        return "日程"
    if _includes_any(action, ("天气", "气温", "下雨", "预报", "穿衣")):
        return "天气"
    if _includes_any(action, ("简报", "日报", "晨报", "今日安排", "周报", "今日概览")):
        return "简报"
    if _includes_any(action, ("会前", "准备会议", "会议材料", "会议纪要", "纪要")):
        return "会前准备"
    if _includes_any(action, ("文件", "文件夹", "目录", "读取文件", "保存文件", "写入文件")):
        return "文件"
    return "其他"


def build_deterministic_plan_from_action_text(
    action_text: str,
    intent_hint: str = "",
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """从 action_text 结构推断 tool_plan（总管/规划 LLM 失败时的兜底）。"""
    if not is_admin_plan_fastpath_enabled():
        return None
    action = str(action_text or "").strip()
    if not action:
        return None

    playground_plan = build_playground_plan_from_text(action)
    if playground_plan:
        return playground_plan

    # 批量删除：不依赖 legacy infer / 槽位，尽早短路
    if _looks_like_bulk_delete_meeting_reminders(action):
        return _bulk_delete_plan()

    if isinstance(understanding, dict) and understanding and not understanding.get("needs_clarification"):
        from_action = build_deterministic_plan_from_understanding(understanding, action)
        if from_action:
            return from_action

    if not is_admin_legacy_infer_enabled():
        return None

    intent = str(intent_hint or "").strip()
    if (not intent or intent == "其他") and is_admin_legacy_infer_enabled():
        intent = infer_intent_from_action(action)
    if not intent or intent == "其他":
        return None

    title = _strip_action_prefix(action)[:120] or action[:120]
    write_like = _includes_any(action, ("创建", "添加", "安排", "预约", "设置", "发", "写", "提醒"))
    list_like = _looks_like_list_intent(action)

    from app.tools.registry import AVAILABLE_TOOLS

    def _ok(name: str, args: dict[str, Any]) -> list[dict[str, Any]] | None:
        if name in AVAILABLE_TOOLS:
            return [{"name": name, "args": args}]
        return None

    if intent == "混合任务":
        if _includes_any(action, ("附近", "周边", "POI")) and "search_nearby_amap" in AVAILABLE_TOOLS:
            return _ok("search_nearby_amap", {"keywords": title or action, "near_address": ""})
        if "get_travel_route" in AVAILABLE_TOOLS:
            return _ok("get_travel_route", {"origin": "", "destination": action, "mode": "compare", "compare_modes": True})

    if intent == "邮件":
        if list_like:
            return _ok("list_emails", {})
        if write_like or _includes_any(action, ("发邮件", "写邮件", "发送")):
            return _ok("send_email", {"to": "", "subject": title[:80], "content": action})
        return _ok("list_emails", {})

    if intent == "联系人":
        if list_like:
            return _ok("list_contacts", {})
        if _includes_any(action, ("查", "找", "搜索", "邮箱")) and not write_like:
            return _ok("search_contact", {"name": title or action})
        # 写操作需理解槽位；无槽时交给 understanding/LLM，此处不瞎造 name/email
        return None

    if intent == "日程" and _includes_any(action, ("提醒", "闹钟", "叫我", "通知我")):
        if _includes_any(action, ("日程", "会议", "预约", "安排", "日历")):
            event_title = resolve_event_title(action) or title
            if _looks_like_composite_manager_dump(event_title):
                event_title = resolve_event_title(action) or "会议"
            args: dict[str, Any] = {
                "title": event_title or "会议",
                "start_time_str": action,
            }
            desc = resolve_event_description(action, event_title or "", understanding.get("slots") if isinstance(understanding, dict) else None)
            if desc:
                args["description"] = desc
            return _ok("add_event", args)
        return _ok("add_reminder", {"content": title or action, "remind_time_str": action})

    if intent == "待办":
        if list_like:
            return _ok("list_tasks", {})
        und_slots = understanding.get("slots") if isinstance(understanding, dict) else None
        task_title = title or action
        task_args: dict[str, Any] = {"title": task_title}
        task_desc = resolve_task_description(task_title, und_slots)
        if task_desc:
            task_args["description"] = task_desc
        if _has_time_hint(action):
            task_args["due_time_str"] = action
            return _ok("add_task_with_due", task_args)
        return _ok("add_task", task_args)

    if intent == "日程":
        if list_like:
            return _ok("list_events", {})
        event_title = resolve_event_title(action) or (title if not _looks_like_composite_manager_dump(title) else "")
        if not event_title:
            event_title = "会议"
        und_slots = understanding.get("slots") if isinstance(understanding, dict) else None
        ev_args: dict[str, Any] = {
            "title": event_title,
            "start_time_str": action,
        }
        ev_desc = resolve_event_description(action, event_title, und_slots)
        if ev_desc:
            ev_args["description"] = ev_desc
        return _ok("add_event", ev_args)

    if intent == "天气":
        return _ok("get_weather", {})

    if intent == "简报":
        name = "weekly_report" if "周报" in action else "daily_briefing"
        return _ok(name, {})

    if intent in ("会前准备", "会议准备"):
        return _ok("prepare_meeting", {"query": action})

    if intent == "文件":
        if _includes_any(action, ("读", "查看", "打开")):
            return _ok("read_file_content", {"path": title})
        return _ok("list_files", {})

    return None


def build_deterministic_plan_from_understanding(
    understanding: dict[str, Any] | None,
    user_message: str = "",
) -> list[dict[str, Any]] | None:
    """
    当理解结果已具备可执行槽位时，直接产出 tools 计划，避免 planning_node 再调一次 LLM。
    """
    if not is_admin_plan_fastpath_enabled():
        return None
    if not isinstance(understanding, dict):
        return None
    if understanding.get("chitchat"):
        return None

    msg = str(user_message or "").strip()
    playground_plan = build_playground_plan_from_text(msg)
    if playground_plan:
        return playground_plan

    # 批量删除：即使槽位 LLM 误澄清，仍可从消息短路出计划
    if _looks_like_bulk_delete_meeting_reminders(msg):
        return _bulk_delete_plan()

    if understanding.get("needs_clarification"):
        return None

    intent = str(understanding.get("intent") or "").strip()
    slots = understanding.get("slots") if isinstance(understanding.get("slots"), dict) else {}

    if intent == "日程":
        list_intent = any(w in msg for w in ("列出", "查看", "有哪些", "列表", "list "))
        if list_intent:
            return [{"name": "list_events", "args": {}}]

        resolved = understanding.get("resolved_time")
        resolved = resolved if isinstance(resolved, dict) else {}
        title = _slot_str(slots, "event_title")
        start_local = str(resolved.get("start_time_local") or "").strip()
        start_expr = _slot_str(slots, "start_time_expression") or str(
            resolved.get("time_expression") or ""
        ).strip()
        if not title or _looks_like_composite_manager_dump(title):
            title = resolve_event_title(msg, slots)
        if not title:
            return None
        if not start_local and not start_expr and _has_time_hint(msg):
            start_expr = msg
        if not start_local and not start_expr:
            return None
        args: dict[str, Any] = {"title": title}
        ev_desc = resolve_event_description(msg, title, slots)
        if ev_desc:
            args["description"] = ev_desc
        if start_local:
            args["start_time_local"] = start_local
            args["start_time_str"] = start_expr or start_local
        else:
            args["start_time_str"] = start_expr
        return [{"name": "add_event", "args": args}]

    if intent == "待办":
        list_intent = any(w in msg for w in ("列出", "查看", "有哪些", "列表", "list "))
        if list_intent:
            return [{"name": "list_tasks", "args": {}}]
        title = _slot_str(slots, "task_title") or (_strip_action_prefix(msg)[:120] if msg else "")
        due_expr = _slot_str(slots, "task_due_time_expression")
        resolved = understanding.get("resolved_time")
        resolved = resolved if isinstance(resolved, dict) else {}
        due_local = str(resolved.get("start_time_local") or "").strip()
        if not title:
            return None
        task_desc = resolve_task_description(title, slots)
        if due_expr or due_local or _has_time_hint(msg):
            args: dict[str, Any] = {"title": title}
            if task_desc:
                args["description"] = task_desc
            if due_local:
                args["due_time_local"] = due_local
                args["due_time_str"] = due_expr or due_local
            else:
                args["due_time_str"] = due_expr or msg
            return [{"name": "add_task_with_due", "args": args}]
        task_args: dict[str, Any] = {"title": title}
        if task_desc:
            task_args["description"] = task_desc
        return [{"name": "add_task", "args": task_args}]

    if intent == "天气":
        city = _slot_str(slots, "city")
        if not city:
            return None
        args: dict[str, Any] = {"city": city}
        day = _slot_str(slots, "day")
        if day:
            args["day"] = day
        return [{"name": "get_weather", "args": args}]

    if intent in ("混合任务", "路线"):
        origin = _slot_str(slots, "route_origin") or _slot_str(slots, "origin")
        dest = _slot_str(slots, "route_destination") or _slot_str(slots, "destination")
        if origin and dest:
            args: dict[str, Any] = {"origin": origin, "destination": dest}
            mode = _slot_str(slots, "travel_mode") or "transit"
            if mode:
                args["mode"] = mode
            return [{"name": "get_travel_route", "args": args}]

    if intent == "邮件":
        list_intent = any(w in msg for w in ("列出", "查看", "有哪些", "列表", "未读", "list "))
        if list_intent:
            return [{"name": "list_emails", "args": {}}]
        to = _slot_str(slots, "email_to_name_or_email")
        subject = _slot_str(slots, "email_subject")
        content = _slot_str(slots, "email_content") or msg
        if not to:
            return None
        if not subject and msg:
            subject = _strip_action_prefix(msg)[:80] or msg[:80]
        if not subject:
            return None
        return [{"name": "send_email", "args": {"to": to, "subject": subject, "content": content or subject}}]

    if intent == "联系人":
        list_intent = any(w in msg for w in ("列出", "查看", "有哪些", "列表", "通讯录", "list "))
        if list_intent and not any(w in msg for w in ("添加", "新建", "存", "导入")):
            return [{"name": "list_contacts", "args": {}}]
        name = _slot_str(slots, "contact_name")
        email = _slot_str(slots, "contact_email")
        if name and email:
            args: dict[str, Any] = {"name": name, "email": email}
            desc = _slot_str(slots, "contact_description")
            if desc:
                args["description"] = desc
            return [{"name": "add_contact", "args": args}]
        if name and any(w in msg for w in ("查", "找", "搜索", "邮箱是")):
            return [{"name": "search_contact", "args": {"name": name}}]
        return None

    return None


_INTENT_ZERO_ARG_TOOLS: dict[str, str] = {
    "天气": "get_weather",
    "简报": "daily_briefing",
    "会前准备": "prepare_meeting",
}

_INTENT_LIST_TOOLS: dict[str, str] = {
    "邮件": "list_emails",
    "文件": "list_files",
    "待办": "list_tasks",
    "日程": "list_events",
    "联系人": "list_contacts",
}


def build_deterministic_plan_from_manager_task(
    client_context: dict[str, Any] | None,
    understanding: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """总管编排：tool_plan / intent_hint / action_text 结构推断，跳过 planning LLM。"""
    if not is_admin_plan_fastpath_enabled():
        return None
    if not isinstance(client_context, dict):
        return None
    task = client_context.get("manager_task")
    if not isinstance(task, dict) or str(task.get("source") or "") != "manager":
        return None
    from app.tools.registry import AVAILABLE_TOOLS

    raw = task.get("tool_plan")
    if isinstance(raw, list) and raw:
        from app.core.admin_manager_plan_llm import sanitize_manager_admin_plan

        action = str(task.get("action_text") or "").strip()
        sanitized = sanitize_manager_admin_plan(
            [
                {
                    "name": str(item.get("name") or "").strip(),
                    "args": item.get("args") if isinstance(item.get("args"), dict) else {},
                }
                for item in raw
                if isinstance(item, dict) and str(item.get("name") or "").strip()
            ],
            action,
        )
        if sanitized:
            return sanitized

    intent = str(task.get("intent_hint") or "").strip()
    if (not intent or intent == "其他") and isinstance(understanding, dict):
        intent = str(understanding.get("intent") or intent or "").strip()
    action = str(task.get("action_text") or "").strip()
    action_plan = build_deterministic_plan_from_action_text(action, intent, understanding)
    if action_plan:
        from app.core.admin_manager_plan_llm import sanitize_manager_admin_plan

        return sanitize_manager_admin_plan(action_plan, action) or action_plan

    if intent in _INTENT_LIST_TOOLS and _looks_like_list_intent(action):
        name = _INTENT_LIST_TOOLS[intent]
        if name in AVAILABLE_TOOLS:
            return [{"name": name, "args": {}}]

    tool = _INTENT_ZERO_ARG_TOOLS.get(intent)
    if tool and tool in AVAILABLE_TOOLS:
        return [{"name": tool, "args": {}}]
    return None
