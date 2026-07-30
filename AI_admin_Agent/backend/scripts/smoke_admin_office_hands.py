"""Smoke：workspace files / office docs / attachment helpers（无 IMAP 真连接）。"""
from __future__ import annotations

import sys
import tempfile
from email.message import EmailMessage
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _text(result: dict) -> str:
    return str(result.get("human_message") or result.get("message") or "")


def main() -> None:
    from app.core.config import settings
    from app.tools import files, office_docs
    from app.tools.email_attachments import _iter_attachments
    from app.tools.registry import AVAILABLE_TOOLS, RISKY_TOOLS
    from app.core.admin_write_gate_contract import WRITE_GATE_CONFIRM_TOOLS
    from app.core.admin_manager_plan_llm import MANAGER_ADMIN_TOOLS

    td = tempfile.mkdtemp(prefix="admin_ws_")
    settings.WORKSPACE_DIR = td

    bad = files.read_file_content("../secret.txt")
    assert_true(isinstance(bad, dict) and bad.get("ok") is False, "escape blocked")

    files.create_directory("notes/sub")
    w = files.write_file("notes/sub/a.txt", "hello-world-" + ("x" * 50))
    assert_true(isinstance(w, dict) and w.get("ok"), f"write ok: {w}")
    listed = files.list_files("notes/sub")
    assert_true(isinstance(listed, dict) and listed.get("ok"), "list ok")
    data = listed.get("data") or {}
    assert_true(any(e.get("name") == "a.txt" for e in (data.get("files") or [])), "list has a.txt")

    r = files.read_file_content("notes/sub/a.txt")
    assert_true(isinstance(r, dict) and r.get("ok"), "read ok")
    assert_true("hello-world" in _text(r), "read content")

    assert_true("read_office_document" in AVAILABLE_TOOLS, "office read registered")
    assert_true("write_office_document" in AVAILABLE_TOOLS, "office write registered")
    assert_true("write_office_document" in WRITE_GATE_CONFIRM_TOOLS, "office write gated")
    assert_true("write_office_document" in MANAGER_ADMIN_TOOLS, "office write in manager whitelist")
    assert_true("save_email_attachment" in MANAGER_ADMIN_TOOLS, "attachment save in whitelist")
    assert_true("save_email_attachment" in WRITE_GATE_CONFIRM_TOOLS, "attachment save gated")
    assert_true("save_email_attachment" in RISKY_TOOLS, "attachment save risky")

    ow = office_docs.write_office_document("docs/hello.docx", content="Title line\nSecond para")
    assert_true(isinstance(ow, dict) and ow.get("ok"), f"docx write: {ow}")
    or_ = office_docs.read_office_document("docs/hello.docx")
    assert_true(isinstance(or_, dict) and or_.get("ok"), f"docx read: {or_}")
    assert_true("Title line" in _text(or_), "docx has text")

    ox = office_docs.write_office_document(
        "docs/t.xlsx",
        rows=[["name", "score"], ["Alice", 90], ["Bob", 80]],
    )
    assert_true(isinstance(ox, dict) and ox.get("ok"), f"xlsx write: {ox}")
    oxr = office_docs.read_office_document("docs/t.xlsx")
    assert_true(isinstance(oxr, dict) and oxr.get("ok"), f"xlsx read: {oxr}")
    assert_true("Alice" in _text(oxr), "xlsx has Alice")

    msg = EmailMessage()
    msg["Subject"] = "with att"
    msg.set_content("body")
    msg.add_attachment(
        b"payload-bytes",
        maintype="application",
        subtype="octet-stream",
        filename="note.bin",
    )
    atts = list(_iter_attachments(msg))
    assert_true(len(atts) == 1 and atts[0][1] == "note.bin", "iter attachment")

    target = Path(td) / "mail_attachments" / "1_note.bin"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"payload-bytes")
    assert_true(target.exists(), "attachment path writable")

    print("smoke_admin_office_hands OK")


if __name__ == "__main__":
    main()
