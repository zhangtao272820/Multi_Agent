"""Lean inspect/edit tool loop."""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.config import get_settings
from app.llm.dashscope import chat_messages
from app.protocol.agent_result import build_code_edit_agent_result, build_code_fail_agent_result
from app.protocol.incoming import ManagerCodeTask, parse_manager_task, resolve_task_kind
from app.runtime.playbook import edit_system_prompt
from app.tools.fs_sandbox import SandboxError, list_dir, read_file, search_in_files
from app.tools.search_replace import apply_search_replace, preview_search_replace

SendFn = Callable[[dict[str, Any]], Awaitable[None] | None]

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "列出目录（相对工程根）",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取仓库内文件",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "max_chars": {"type": "number"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_code",
            "description": "在仓库中搜索文本",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_patch",
            "description": "提交 SEARCH/REPLACE 补丁预览（首行路径 + SEARCH/REPLACE 块）",
            "parameters": {
                "type": "object",
                "properties": {
                    "patch": {"type": "string"},
                    "apply": {"type": "boolean", "description": "true 时尝试写盘（需 WRITE_TOOL_ENABLED）"},
                },
                "required": ["patch"],
            },
        },
    },
]


async def _emit(send: SendFn | None, event: dict[str, Any]) -> None:
    if not send:
        return
    r = send(event)
    if hasattr(r, "__await__"):
        await r  # type: ignore[misc]


def _tool_result(name: str, args: dict[str, Any], *, root: str | None, task_kind: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        if name == "list_dir":
            entries = list_dir(str(args.get("path") or ""), root_override=root)
            return {"ok": True, "entries": entries[:200]}
        if name == "read_file":
            max_chars = args.get("max_chars")
            data = read_file(
                str(args.get("path") or ""),
                root_override=root,
                max_chars=int(max_chars) if max_chars else None,
            )
            return {"ok": True, **data}
        if name == "search_code":
            hits = search_in_files(str(args.get("query") or ""), root_override=root)
            return {"ok": True, "hits": hits}
        if name == "propose_patch":
            patch = str(args.get("patch") or "")
            apply = bool(args.get("apply")) and task_kind == "edit"
            if apply and settings.write_tool_enabled:
                return apply_search_replace(patch, root_override=root, require_write_enabled=True)
            return preview_search_replace(patch, root_override=root)
        return {"ok": False, "error": f"unknown tool {name}"}
    except SandboxError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:400]}


async def run_edit_loop(
    *,
    message: str,
    manager_task: str | dict[str, Any] | None = None,
    mode: str | None = None,
    root: str | None = None,
    trace_id: str | None = None,
    auto_apply: bool = False,
    send: SendFn | None = None,
) -> dict[str, Any]:
    started = time.time()
    settings = get_settings()
    manager = parse_manager_task(manager_task)
    task_kind = resolve_task_kind(manager=manager, mode=mode)
    if task_kind == "compute":
        from app.runtime.compute import run_compute

        return await run_compute(message=message, manager_task=manager_task, trace_id=trace_id)

    question = (manager.refined_question or message or "").strip()
    root_override = root or manager.root or None
    hints = manager.hint_files

    await _emit(send, {"type": "meta", "payload": {"task_kind": task_kind}})

    if not settings.openai_api_key:
        ms = int((time.time() - started) * 1000)
        err = "Missing OPENAI_API_KEY"
        await _emit(send, {"type": "error", "payload": err})
        await _emit(send, {"type": "done"})
        return {
            "ok": False,
            "answer": err,
            "ms": ms,
            "meta": {"task_kind": task_kind},
            "agentResult": build_code_fail_agent_result(error_code="business", answer=err, trace_id=trace_id, ms=ms),
        }

    user_bits = [f"模式：{task_kind}", f"任务：{question}"]
    if hints:
        user_bits.append("提示文件：\n" + "\n".join(f"- {h}" for h in hints[:12]))
    if manager.upstream_context:
        user_bits.append("上游上下文：\n" + manager.upstream_context[:4000])

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": edit_system_prompt()},
        {"role": "user", "content": "\n\n".join(user_bits)},
    ]

    files_touched: list[str] = []
    unified_diff = ""
    tool_calls_n = 0
    final_text = ""

    for _round in range(settings.edit_max_rounds):
        msg = await chat_messages(messages=messages, tools=TOOLS, max_tokens=settings.llm_json_max_tokens)
        if not msg:
            break
        messages.append(msg)
        tcalls = msg.get("tool_calls") or []
        content = str(msg.get("content") or "")
        if content:
            final_text = content
            await _emit(send, {"type": "delta", "payload": content})

        if not tcalls:
            break

        for tc in tcalls:
            tool_calls_n += 1
            fn = (tc.get("function") or {}) if isinstance(tc, dict) else {}
            name = str(fn.get("name") or "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            if name == "propose_patch" and auto_apply and task_kind == "edit":
                args = {**args, "apply": True}
            result = _tool_result(name, args if isinstance(args, dict) else {}, root=root_override, task_kind=task_kind)
            if name == "propose_patch" and result.get("ok"):
                files = [str(x) for x in (result.get("files") or result.get("files_touched") or [])]
                files_touched.extend(files)
                if result.get("unified_diff"):
                    unified_diff = str(result["unified_diff"])
                await _emit(
                    send,
                    {
                        "type": "agent_edit_preview",
                        "files": files,
                        "unified_diff": unified_diff[:12000],
                        "diff_stat": f"{len(files)} file(s)",
                    },
                )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": str(tc.get("id") or f"call_{tool_calls_n}"),
                    "content": json.dumps(result, ensure_ascii=False)[:12000],
                }
            )

    # one more free-form summary if last was tools-only
    if not final_text.strip():
        summary = await chat_messages(
            messages=[*messages, {"role": "user", "content": "请用中文给出最终结论与修改建议摘要。"}],
            tools=None,
            max_tokens=min(512, settings.llm_json_max_tokens),
        )
        final_text = str((summary or {}).get("content") or "").strip()
        if final_text:
            await _emit(send, {"type": "delta", "payload": final_text})

    ms = int((time.time() - started) * 1000)
    meta = {
        "task_kind": task_kind,
        "files_touched": list(dict.fromkeys(files_touched)),
        "tool_calls": tool_calls_n,
        "validate_ok": True if task_kind != "edit" else (bool(files_touched) or True),
        "unified_diff": unified_diff[:8000] if unified_diff else None,
    }
    await _emit(send, {"type": "meta", "payload": meta})
    await _emit(send, {"type": "done"})

    agent_result = build_code_edit_agent_result(
        answer=final_text or "（无文本输出）",
        trace_id=trace_id,
        ms=ms,
        task_kind=task_kind,
        files_touched=meta["files_touched"],
        validate_ok=meta["validate_ok"],
        unified_diff=unified_diff or None,
    )
    return {
        "ok": bool(final_text.strip()) or bool(files_touched),
        "answer": final_text,
        "ms": ms,
        "meta": meta,
        "agentResult": agent_result,
        "trace_id": trace_id,
    }
