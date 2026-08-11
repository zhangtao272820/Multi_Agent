"""Strip remaining live yeyu references from active scripts."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def strip_curate() -> None:
    p = SCRIPTS / "curate_rest_story_beats.py"
    text = p.read_text(encoding="utf-8")
    pat = r"    # ========== T1 yeyu ==========.*?    # ========== T1 taotao =========="
    new, n = re.subn(pat, "    # ========== T1 taotao ==========", text, count=1, flags=re.S)
    p.write_text(new, encoding="utf-8")
    print(f"curate_rest_story_beats: {n}")


def strip_sprite_hooks() -> None:
    p = SCRIPTS / "thicken_stories_sprite_hooks.py"
    text = p.read_text(encoding="utf-8")
    # T1_TWIST block
    pat = r'    "yeyu": \{\n(?:.*?\n)*?    \},\n(?=    "taotao":)'
    new, n1 = re.subn(pat, "", text, count=1)
    # single-line string map entries
    new, n2 = re.subn(r'^[ \t]*"yeyu": "[^"]*",\n', "", new, flags=re.M)
    p.write_text(new, encoding="utf-8")
    print(f"thicken_stories_sprite_hooks: block={n1} lines={n2}")


def main() -> None:
    strip_curate()
    strip_sprite_hooks()
    # verify no yeyu in active (non-archive) scripts except purge/clean helpers
    allow = {"_purge_yeyu.py", "clean_yeyu_sprite_mattes.py", "smoke_linked_lores_gates.py", "_audit_gap.py"}
    leftover = []
    for p in SCRIPTS.rglob("*.py"):
        if "_archive" in p.parts:
            continue
        if p.name in allow:
            continue
        t = p.read_text(encoding="utf-8", errors="ignore")
        if "yeyu" in t or "云夜羽" in t:
            leftover.append(str(p.relative_to(ROOT)))
    print("leftover active:", leftover or "none")


if __name__ == "__main__":
    main()
