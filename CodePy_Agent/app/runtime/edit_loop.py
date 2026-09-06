"""Lean inspect/edit tool loop."""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.config import get_settings
from app.llm.dashscope import chat_messages
from app.protocol.agent_result import build_code_edit_agent_result, build_code_fail_agent_result
from app.protocol.incoming import ManagerCodeTask, parse_manager_task, resolve_task_kind, write_apply_allowed
from app.runtime.playbook import edit_system_prompt
from app.tools.fs_sandbox import SandboxError, list_dir, read_file, search_in_files
from app.tools.search_replace import apply_search_replace, preview_search_replace
from app.tools.shell_sandbox import run_terminal
from app.pending_patch import merge_pending_patch, save_pending_patch

SendFn = Callable[[dict[str, Any]], Awaitable[None] | None]

_READ_TOOLS = [
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
            "name": "run_terminal",
            "description": "在沙箱内执行白名单命令（pytest/npm/ls/git status|diff 等）",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string", "description": "相对工程根的工作目录"},
                },
                "required": ["command"],
            },
        },
    },
]

_WRITE_TOOL = {
    "type": "function",
    "function": {
        "name": "propose_patch",
        "description": "提交 SEARCH/REPLACE 补丁预览（首行路径 + SEARCH/REPLACE 块）；默认不写盘，进入 pending 待确认",
        "parameters": {
            "type": "object",
            "properties": {
                "patch": {"type": "string"},
                "apply": {"type": "boolean", "description": "true 时尝试写盘（需 WRITE_TOOL_ENABLED + write_allowed + confirm）"},
            },
            "required": ["patch"],
        },
    },
}


def tools_for_task_kind(task_kind: str) -> list[dict[str, Any]]:
    """S2.C2：按 task_kind 子集暴露工具；inspect 只读，edit/script 才挂 propose_patch。"""
    kind = str(task_kind or "auto").strip().lower()
    if kind in ("inspect", "compute"):
        return list(_READ_TOOLS)
    if kind in ("edit", "script"):
        return [*_READ_TOOLS, _WRITE_TOOL]
    # auto：允许预览补丁，写盘仍受 write_apply_allowed 约束
    return [*_READ_TOOLS, _WRITE_TOOL]


# 兼容旧引用
TOOLS = tools_for_task_kind("edit")


async def _emit(send: SendFn | None, event: dict[str, Any]) -> None:
    if not send:
        return
    r = send(event)
    if hasattr(r, "__await__"):
        await r  # type: ignore[misc]


def _tool_result(
    name: str,
    args: dict[str, Any],
    *,
    root: str | None,
    task_kind: str,
    manager: ManagerCodeTask,
    batch_pending_id: str | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    allowed = list(manager.allowed_paths or []) or None
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
        if name == "run_terminal":
            return run_terminal(
                str(args.get("command") or ""),
                cwd=str(args.get("cwd") or "") or None,
                root_override=root,
                profile=str(args.get("profile") or "") or None,
            )
        if name == "propose_patch":
            if task_kind in ("inspect", "compute"):
                return {"ok": False, "error": "propose_patch not available for inspect/compute"}
            patch = str(args.get("patch") or "")
            apply = bool(args.get("apply")) and write_apply_allowed(manager, task_kind=task_kind)
            if apply and settings.write_tool_enabled:
                return apply_search_replace(
                    patch,
                    root_override=root,
                    require_write_enabled=True,
                    allowed_paths=allowed,
                )
            preview = preview_search_replace(patch, root_override=root, allowed_paths=allowed)
            if preview.get("ok"):
                files = preview.get("files") or preview.get("files_touched") or []
                pid = ""
                if batch_pending_id:
                    merged = merge_pending_patch(
                        batch_pending_id,
                        patch=patch,
                        files=[str(x) for x in files],
                        unified_diff=str(preview.get("unified_diff") or ""),
                        preview=preview,
                    )
                    if merged:
                        pid = str(merged.get("id") or batch_pending_id)
                        preview = {
                            **preview,
                            "files": merged.get("files") or files,
                            "unified_diff": merged.get("unified_diff") or preview.get("unified_diff"),
                            "batch_count": merged.get("batch_count"),
                        }
                if not pid:
                    pid = save_pending_patch(
                        {
                            "kind": "edit",
                            "patch": patch,
                            "patches": [patch],
                            "root": root or "",
                            "files": files,
                            "unified_diff": preview.get("unified_diff") or "",
                            "preview": preview,
                            "allowed_paths": list(manager.allowed_paths or []),
                            "verify_after_apply": bool(manager.verify_after_apply),
                            "verify_command": str(manager.verify_command or ""),
                            "batch_count": 1,
                        }
                    )
                preview = {
                    **preview,
                    "pending_patch_id": pid,
                    "needs_human_confirm": True,
                    "applied": False,
                }
            return preview
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
    tools = tools_for_task_kind(task_kind)

    await _emit(
        send,
        {
            "type": "meta",
            "payload": {
                "task_kind": task_kind,
                "tools": [t["function"]["name"] for t in tools],
            },
        },
    )

    if not settings.openai_api_key:
        ms = int((time.time() - started) * 1000)
        err = "Missing OPENAI_API_KEY"
        await _emit(send, {"type": "error", "payload": err})
        await _emit(send, {"type": "done"})
        return {
            "ok": False,
            "answer": err,
            "ms": ms,
            "meta": {"task_kind": task_kind, "tools": [t["function"]["name"] for t in tools]},
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
    pending_patch_id = ""
    tool_calls_n = 0
    final_text = ""
    terminal_runs: list[dict[str, Any]] = []

    for _round in range(settings.edit_max_rounds):
        msg = await chat_messages(messages=messages, tools=tools, max_tokens=settings.llm_json_max_tokens)
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
            if name == "propose_patch" and auto_apply and write_apply_allowed(manager, task_kind=task_kind):
                args = {**args, "apply": True}
            result = _tool_result(
                name,
                args if isinstance(args, dict) else {},
                root=root_override,
                task_kind=task_kind,
                manager=manager,
                batch_pending_id=pending_patch_id or None,
            )
            if name == "run_terminal":
                terminal_runs.append(
                    {
                        "command": str((args if isinstance(args, dict) else {}).get("command") or ""),
                        "exit_code": result.get("exit_code"),
                        "ok": result.get("ok"),
                    }
                )
            if name == "propose_patch" and result.get("ok"):
                files = [str(x) for x in (result.get("files") or result.get("files_touched") or [])]
                files_touched.extend(files)
                if result.get("unified_diff"):
                    unified_diff = str(result["unified_diff"])
                if result.get("pending_patch_id"):
                    pending_patch_id = str(result["pending_patch_id"])
                await _emit(
                    send,
                    {
                        "type": "agent_edit_preview",
                        "files": files,
                        "unified_diff": unified_diff[:12000],
                        "diff_stat": f"{len(files)} file(s)",
                        "pending_patch_id": pending_patch_id,
                        "needs_human_confirm": bool(result.get("needs_human_confirm")),
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
        "edit_preview": {
            "files": list(dict.fromkeys(files_touched)),
            "unified_diff": unified_diff[:8000] if unified_diff else None,
            "diff_stat": f"{len(list(dict.fromkeys(files_touched)))} file(s)" if files_touched else None,
        },
        "pending_patch_id": pending_patch_id or None,
        "needs_human_confirm": bool(pending_patch_id),
        "terminal_runs": terminal_runs[-8:],
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
    if isinstance(agent_result.get("structured"), dict):
        if pending_patch_id:
            agent_result["structured"]["pending_patch_id"] = pending_patch_id
            agent_result["structured"]["needs_human_confirm"] = True
            agent_result["structured"]["pending_actions"] = [
                {"id": pending_patch_id, "tool": "apply_patch", "title": "确认写盘"}
            ]
    return {
        "ok": bool(final_text.strip()) or bool(files_touched),
        "answer": final_text,
        "ms": ms,
        "meta": meta,
        "agentResult": agent_result,
        "trace_id": trace_id,
    }
