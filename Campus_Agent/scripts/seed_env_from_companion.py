"""Seed Campus_Agent/.env and %LOCALAPPDATA%/CampusAgent/.env from Companion (no stdout of secrets)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / "Companion_Agent" / ".env"
DST = ROOT / ".env"


def main() -> int:
    text = SRC.read_text(encoding="utf-8") if SRC.is_file() else ""
    key = ""
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k in {"DASHSCOPE_API_KEY", "CAMPUS_API_KEY", "OPENAI_API_KEY"} and v:
            key = v
            break
    lines = [
        "# Seeded from Companion_Agent for local play",
        f"DASHSCOPE_API_KEY={key}",
        "CAMPUS_LLM_MODEL=qwen-flash-character",
        "CAMPUS_AUX_LLM_MODEL=qwen-plus",
        "",
    ]
    DST.write_text("\n".join(lines), encoding="utf-8")
    local = Path(os.environ.get("LOCALAPPDATA") or "") / "CampusAgent"
    local.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DST, local / ".env")
    print(f"seeded_ok={bool(key)} dst={DST.is_file()} local={(local / '.env').is_file()}")
    return 0 if key else 1


if __name__ == "__main__":
    raise SystemExit(main())
