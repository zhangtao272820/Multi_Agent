#!/usr/bin/env python3
"""将收敛 MODE 从 SSOT 同步到各 Agent .env 与 .env.agents-lan。

绑定表 SSOT：Manage-platform_Agent/backend/app/convergence_modes.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PLATFORM_DIR = SCRIPT_DIR.parent
BACKEND_APP = PLATFORM_DIR / "backend" / "app"
sys.path.insert(0, str(BACKEND_APP.parent))

from app.convergence_modes import (  # noqa: E402
    AGENT_MODE_BINDINGS,
    AGENTS_LAN_MODE_KEYS,
    apply_convergence_modes,
    load_convergence_modes,
    ssot_example_path,
    ssot_path,
)
from app.env_file_io import norm_env_val, parse_env_file  # noqa: E402
from app.config import get_settings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="同步收敛 MODE 到各 Agent .env")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--ssot", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--skip-agents-lan", action="store_true")
    parser.add_argument("--agents", default="", help="逗号分隔 Agent 名")
    args = parser.parse_args()

    ssot_file = Path(args.ssot).resolve() if args.ssot else ssot_path()
    if not ssot_file.is_file():
        if ssot_example_path().is_file():
            print(f"[warn] SSOT 不存在：{ssot_file}，使用 example")
            ssot_file = ssot_example_path()
        else:
            print("[error] 找不到 SSOT", file=sys.stderr)
            return 1

    ssot = parse_env_file(ssot_file) if args.ssot else load_convergence_modes()
    if not ssot:
        print("[error] SSOT 为空", file=sys.stderr)
        return 1

    settings = get_settings()
    workspace = Path(args.workspace).resolve() if args.workspace else Path(settings.workspace_root or ".").resolve()

    print("── 收敛 MODE SSOT ──")
    for k in sorted(ssot.keys()):
        print(f"  {k}={ssot[k]}")
    print()

    agent_filter: set[str] | None = None
    if args.agents.strip():
        agent_filter = {a.strip() for a in args.agents.split(",") if a.strip()}

    if args.check:
        drift_count = 0
        for agent_name, spec in sorted(AGENT_MODE_BINDINGS.items()):
            if agent_filter and agent_name not in agent_filter:
                continue
            rel = spec["env_file"]
            path = workspace / rel
            env = parse_env_file(path)
            drift: list[str] = []
            for key in spec["keys"]:
                exp = str(ssot.get(key) or "").strip()
                if not exp:
                    continue
                cur = str(env.get(key) or "").strip()
                if not cur or norm_env_val(cur) != norm_env_val(exp):
                    drift.append(f"{key}: {cur or '(missing)'} → {exp}")
            if drift:
                drift_count += 1
                print(f"[drift] {agent_name} ({rel})")
                for d in drift:
                    print(f"        {d}")
            elif path.is_file():
                print(f"[ok] {agent_name} ({rel})")
            else:
                print(f"[missing] {agent_name} ({rel})")
        print(f"\n检查完成：{drift_count} 个 Agent 存在 MODE 漂移")
        return 1 if drift_count else 0

    if args.dry_run:
        print("模式：dry-run（仅预览，请用控制台或去掉 --dry-run 写入）")
        for agent_name, spec in sorted(AGENT_MODE_BINDINGS.items()):
            if agent_filter and agent_name not in agent_filter:
                continue
            updates = {k: ssot[k] for k in spec["keys"] if k in ssot and str(ssot[k]).strip()}
            print(f"[would-update] {agent_name}: {len(updates)} keys")
        if not args.skip_agents_lan:
            print(f"[would-update] .env.agents-lan: {len(AGENTS_LAN_MODE_KEYS)} candidate keys")
        return 0

    out = apply_convergence_modes(sync_env_files=True)
    print(f"完成：env_synced={out.get('env_synced')} changed={out.get('changed_key_count')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
