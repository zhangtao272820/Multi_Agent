"""Admin 场景 Playbook：口语 paraphrase → 场景 id，供意图 RAG 预召回（非 regex 硬匹配）。"""
from __future__ import annotations

from typing import TypedDict


class AdminScenarioPlaybookEntry(TypedDict):
    id: str
    paraphrases: list[str]
    intent_hint: str
    tool_hint: str


ADMIN_SCENARIO_PLAYBOOK: list[AdminScenarioPlaybookEntry] = [
    {
        "id": "daily_briefing",
        "paraphrases": [
            "给我今天的简报",
            "今日简报",
            "早报",
            "今天有什么安排",
            "今天安排",
            "今日待办概览",
            "morning brief",
        ],
        "intent_hint": "简报",
        "tool_hint": "daily_briefing",
    },
    {
        "id": "email_triage",
        "paraphrases": [
            "未读邮件有什么急件",
            "邮件分拣",
            "处理收件箱",
            "哪些邮件要回",
            "未读邮件摘要",
            "急件邮件",
        ],
        "intent_hint": "邮件",
        "tool_hint": "triage_emails",
    },
    {
        "id": "meeting_prep",
        "paraphrases": [
            "明天开会帮我准备",
            "会前准备",
            "会议材料准备",
            "开会准备一下",
            "meeting prep",
        ],
        "intent_hint": "会前准备",
        "tool_hint": "prepare_meeting",
    },
    {
        "id": "ask_database",
        "paraphrases": [
            "查一下本周期业务汇总",
            "问数",
            "查统计",
            "多少条记录",
            "SQL 查库",
            "数据库报表",
            "查一下库存或销量汇总",
        ],
        "intent_hint": "问数",
        "tool_hint": "ask_database",
    },
    {
        "id": "weekly_report",
        "paraphrases": ["写周报", "本周工作总结", "weekly report", "生成本周周报"],
        "intent_hint": "其他",
        "tool_hint": "weekly_report",
    },
    {
        "id": "meeting_minutes",
        "paraphrases": [
            "请从会议纪要里提取待办",
            "会议纪要",
            "提取行动项",
            "meeting minutes",
            "从纪要里找待办",
        ],
        "intent_hint": "混合任务",
        "tool_hint": "extract_meeting_actions",
    },
    {
        "id": "lobster_automation",
        "paraphrases": [
            "在OA网页提交请假",
            "浏览器填表",
            "登录系统操作",
            "lobster 自动化",
            "网页表单提交",
        ],
        "intent_hint": "混合任务",
        "tool_hint": "lobster_browser_task",
    },
    {
        "id": "travel_route",
        "paraphrases": [
            "从公司到机场多久",
            "怎么去",
            "路线多久",
            "通勤时间",
            "坐地铁多久到",
            "驾车从A到B",
        ],
        "intent_hint": "其他",
        "tool_hint": "get_travel_route",
    },
    {
        "id": "amap_poi",
        "paraphrases": [
            "[地标]附近[POI类型]",
            "附近餐厅",
            "周边有什么超市",
            "找附近停车场",
            "哪里有药店",
            "search nearby coffee",
        ],
        "intent_hint": "其他",
        "tool_hint": "search_nearby_amap",
    },
    {
        "id": "amap_geocode",
        "paraphrases": [
            "查一下这个地址在哪",
            "地址解析",
            "定位到坐标",
            "补全地址",
            "geocode address",
        ],
        "intent_hint": "其他",
        "tool_hint": "resolve_address_amap",
    },
    {
        "id": "feishu_calendar",
        "paraphrases": ["同步飞书日历", "feishu calendar sync", "导入飞书日程"],
        "intent_hint": "日程",
        "tool_hint": "sync_feishu_calendar",
    },
    {
        "id": "calendar_multi",
        "paraphrases": ["同步所有日历", "多日历同步", "sync all calendars"],
        "intent_hint": "日程",
        "tool_hint": "sync_all_calendars",
    },
    {
        "id": "feishu_notify",
        "paraphrases": ["飞书发一下通知", "发飞书消息", "feishu notify message"],
        "intent_hint": "混合任务",
        "tool_hint": "send_feishu_message",
    },
    {
        "id": "add_contact",
        "paraphrases": [
            "添加联系人",
            "通讯录加一下",
            "把邮箱存成联系人",
            "新建联系人张三",
            "存一下这个邮箱到通讯录",
            "add contact with email",
        ],
        "intent_hint": "联系人",
        "tool_hint": "add_contact",
    },
    {
        "id": "minutes_to_tasks",
        "paraphrases": ["把待办加进任务列表", "批量添加待办", "纪要待办写入任务"],
        "intent_hint": "待办",
        "tool_hint": "add_tasks_from_minutes",
    },
    {
        "id": "reminder_notify",
        "paraphrases": ["发短信提醒我", "SMS 提醒", "手机短信通知"],
        "intent_hint": "待办",
        "tool_hint": "",
    },
    {
        "id": "integrations_status",
        "paraphrases": ["集成还要配什么", "哪些集成待配置", "integrations status"],
        "intent_hint": "其他",
        "tool_hint": "show_integrations_status",
    },
]
