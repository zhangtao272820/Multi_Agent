from __future__ import annotations

import os
import time
from pathlib import Path

from app.core.config import settings
from app.core.tenant_scope import user_workspace_dir
from app.tools.common import _tool_err, _tool_ok

# 文本读上限（字符）；超出附加截断标记
READ_CHAR_LIMIT = 32_000


def _workspace_root() -> Path:
    root = Path(user_workspace_dir(settings.WORKSPACE_DIR)).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve_workspace_path(rel_path: str, *, allow_missing: bool = True) -> Path | None:
    """相对 WORKSPACE_DIR 解析路径；禁止 .. 逃逸。返回绝对 Path，非法则 None。"""
    raw = str(rel_path or "").strip().replace("\\", "/")
    if not raw or raw in (".", "/"):
        return _workspace_root()
    # 去掉前导斜杠，按相对路径处理
    raw = raw.lstrip("/")
    parts = [p for p in raw.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        return None
    root = _workspace_root()
    candidate = (root.joinpath(*parts) if parts else root).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if not allow_missing and not candidate.exists():
        return None
    return candidate


def _rel_display(path: Path) -> str:
    root = _workspace_root()
    try:
        return path.relative_to(root).as_posix() or "."
    except ValueError:
        return path.name


def list_files(directory: str = "") -> str:
    """列出工作区（或子目录）下的文件，返回结构化条目。"""
    target = _resolve_workspace_path(directory or "")
    if target is None:
        return _tool_err("非法目录路径（禁止跳出工作区）。", code="path_escape")
    if not target.exists():
        return _tool_err(
            f"目录不存在: {_rel_display(target)}",
            data={"directory": _rel_display(target)},
            code="dir_not_found",
        )
    if not target.is_dir():
        return _tool_err(
            f"不是目录: {_rel_display(target)}",
            data={"path": _rel_display(target)},
            code="not_a_directory",
        )
    try:
        entries: list[dict] = []
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            try:
                st = child.stat()
                entries.append(
                    {
                        "name": child.name,
                        "path": _rel_display(child),
                        "is_dir": child.is_dir(),
                        "size": int(st.st_size) if child.is_file() else 0,
                        "mtime": int(st.st_mtime),
                        "mtime_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
                    }
                )
            except OSError:
                continue
        if not entries:
            return _tool_ok(
                f"目录 {_rel_display(target)} 为空。",
                data={
                    "workspace_dir": str(_workspace_root()),
                    "directory": _rel_display(target),
                    "files": [],
                    "count": 0,
                },
                code="empty",
            )
        shown = entries[:50]
        lines = [
            f"{'DIR' if e['is_dir'] else 'FILE':4} {e['size']:>10}  {e['mtime_iso']}  {e['path']}"
            for e in shown
        ]
        more = f"\n…共 {len(entries)} 项，仅展示前 {len(shown)} 项" if len(entries) > len(shown) else ""
        return _tool_ok(
            f"工作区目录 {_rel_display(target)}:\n" + "\n".join(lines) + more,
            data={
                "workspace_dir": str(_workspace_root()),
                "directory": _rel_display(target),
                "files": shown,
                "count": len(entries),
            },
        )
    except Exception as e:
        return _tool_err(
            f"无法读取工作区目录: {e}",
            data={"workspace_dir": str(_workspace_root()), "directory": _rel_display(target)},
            code="list_files_failed",
        )


def read_file_content(file_path: str, max_chars: int = READ_CHAR_LIMIT) -> str:
    """读取工作区内文本文件；支持相对子路径，超限截断并标注。"""
    safe_path = _resolve_workspace_path(file_path, allow_missing=False)
    if safe_path is None:
        return _tool_err("非法或缺失文件路径（禁止跳出工作区）。", code="path_escape")
    if not safe_path.is_file():
        return _tool_err(
            f"不是文件: {_rel_display(safe_path)}",
            data={"file_path": _rel_display(safe_path)},
            code="not_a_file",
        )
    limit = max(1000, min(int(max_chars or READ_CHAR_LIMIT), 200_000))
    try:
        text = safe_path.read_text(encoding="utf-8", errors="replace")
        truncated = len(text) > limit
        body = text[:limit]
        if truncated:
            body += f"\n\n…[已截断，共 {len(text)} 字符，本次返回前 {limit} 字符]"
        return _tool_ok(
            body,
            data={
                "file_path": _rel_display(safe_path),
                "char_count": len(text),
                "returned_chars": len(body) if not truncated else limit,
                "truncated": truncated,
            },
        )
    except Exception as e:
        return _tool_err(
            f"读取文件 {_rel_display(safe_path)} 失败: {e}",
            data={"file_path": _rel_display(safe_path)},
            code="read_failed",
        )


def write_file(file_path: str, content: str) -> str:
    """写入工作区文本文件；可自动创建中间子目录。"""
    safe_path = _resolve_workspace_path(file_path, allow_missing=True)
    if safe_path is None or safe_path == _workspace_root():
        return _tool_err("非法文件路径（禁止跳出工作区或写根目录本身）。", code="path_escape")
    try:
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        data = content if content is not None else ""
        safe_path.write_text(data, encoding="utf-8")
        return _tool_ok(
            f"已成功将内容写入工作区文件: {_rel_display(safe_path)}",
            data={
                "file_path": _rel_display(safe_path),
                "safe_path": str(safe_path),
                "content_length": len(data),
            },
        )
    except Exception as e:
        return _tool_err(
            f"写入文件失败: {e}",
            data={"file_path": str(file_path or "")},
            code="write_failed",
        )


def move_file(src_path: str, dst_path: str) -> str:
    """仅在工作区内移动/重命名文件。"""
    safe_src = _resolve_workspace_path(src_path, allow_missing=False)
    safe_dst = _resolve_workspace_path(dst_path, allow_missing=True)
    if safe_src is None or safe_dst is None:
        return _tool_err("非法路径（禁止跳出工作区）。", code="path_escape")
    if not safe_src.exists():
        return _tool_err(
            f"源文件不存在: {_rel_display(safe_src)}",
            data={"src_file": _rel_display(safe_src)},
            code="src_not_found",
        )
    try:
        safe_dst.parent.mkdir(parents=True, exist_ok=True)
        import shutil

        shutil.move(str(safe_src), str(safe_dst))
        return _tool_ok(
            f"已将 {_rel_display(safe_src)} 移动到 {_rel_display(safe_dst)}",
            data={
                "src_file": _rel_display(safe_src),
                "dst_file": _rel_display(safe_dst),
                "safe_src_path": str(safe_src),
                "safe_dst_path": str(safe_dst),
            },
        )
    except Exception as e:
        return _tool_err(
            f"移动文件失败: {e}",
            data={"src_file": str(src_path or ""), "dst_file": str(dst_path or "")},
            code="move_failed",
        )


def create_directory(dirname: str = "", directory: str = "", dir_path: str = "") -> str:
    """在工作区内创建文件夹（支持相对子路径）。"""
    name = str(dirname or directory or dir_path or "").strip()
    if not name:
        return _tool_err("目录名不能为空。", code="empty_dirname")
    safe_path = _resolve_workspace_path(name, allow_missing=True)
    if safe_path is None or safe_path == _workspace_root():
        return _tool_err("非法目录路径。", code="path_escape")
    try:
        safe_path.mkdir(parents=True, exist_ok=True)
        return _tool_ok(
            f"已在工作区创建目录: {_rel_display(safe_path)}",
            data={"directory": _rel_display(safe_path), "safe_path": str(safe_path)},
        )
    except Exception as e:
        return _tool_err(
            f"创建目录失败: {e}",
            data={"directory": name},
            code="mkdir_failed",
        )
