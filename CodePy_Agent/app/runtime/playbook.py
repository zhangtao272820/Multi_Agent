"""Load playbook sections from skills/*/skill.md."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "skills"

COMPUTE_SYSTEM_FALLBACK = """你是总管协作链路上的计算与整理助手。
只基于用户给出的上下文进行推理、计算、汇总与结构化整理。
不要调用工具，不要臆测上下文中未出现的数据。
输出合法 JSON（含 answer、facts、可选 data）。"""

COMPUTE_USER_TAIL_FALLBACK = (
    "请基于以上上下文做计算/整理/推导。输出 JSON，facts 覆盖上下文中全部可核对数字字段。"
)

EDIT_SYSTEM_FALLBACK = """你是轻量代码助手。可用工具：list_dir、read_file、search_code、propose_patch。
inspect 只读；edit 用 propose_patch 提交 SEARCH/REPLACE。回答简洁，中文为主。"""


@lru_cache(maxsize=32)
def _load_skill(name: str) -> str:
    path = SKILLS / name / "skill.md"
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def resolve_section(skill: str, section: str, fallback: str) -> str:
    body = _load_skill(skill)
    if not body:
        return fallback
    # ## Section ... until next ##
    pat = re.compile(rf"^##\s*{re.escape(section)}\s*$([\s\S]*?)(?=^##\s|\Z)", re.M)
    m = pat.search(body)
    if not m:
        return fallback
    text = (m.group(1) or "").strip()
    return text or fallback


def compute_system_prompt(*, must_outputs: list[str] | None = None) -> str:
    base = resolve_section("compute_assistant", "System", COMPUTE_SYSTEM_FALLBACK)
    if must_outputs:
        base += f"\n输出格式偏好：{'、'.join(must_outputs)}"
    return base


def compute_user_tail() -> str:
    return resolve_section("compute_assistant", "UserTail", COMPUTE_USER_TAIL_FALLBACK)


def edit_system_prompt() -> str:
    return resolve_section("code_edit_loop", "System", EDIT_SYSTEM_FALLBACK)
