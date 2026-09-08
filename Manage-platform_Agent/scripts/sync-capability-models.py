#!/usr/bin/env python3
"""将能力层模型从 SSOT 文件同步到各 Agent 的 .env（不修改 API Key）。

用法：
  python sync-capability-models.py                    # 读取 ../.env.capability-models
  python sync-capability-models.py --dry-run          # 仅预览变更
  python sync-capability-models.py --set route=qwen-flash-xxx  # 临时覆盖某层后同步
  python sync-capability-models.py --check            # 检查漂移，不写文件
  python sync-capability-models.py --agents DB_Agent,RAG_Agent    # 只同步指定 Agent

SSOT 文件：Manage-platform_Agent/.env.capability-models（从 .env.capability-models.example 复制）
映射定义：Manage-platform_Agent/backend/app/capability_models.py
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
PLATFORM_DIR = SCRIPT_DIR.parent
REPO_ROOT = PLATFORM_DIR.parent
BACKEND_APP = PLATFORM_DIR / "backend" / "app"
CAPABILITY_PY = BACKEND_APP / "capability_models.py"
REGISTRY_PY = BACKEND_APP / "agent_env_registry.py"

SSOT_FILE = PLATFORM_DIR / ".env.capability-models"
SSOT_EXAMPLE = PLATFORM_DIR / ".env.capability-models.example"
AGENTS_LAN_ENV = PLATFORM_DIR / ".env.agents-lan"

# sync-capability-models 会把下列键写入 .env.agents-lan（供 clawhive_backend 等平台服务 env_file 加载）
# Docker compose 不在 services.environment 覆盖模型名；各 Agent 模型见各 Agent/.env
AGENTS_LAN_DOCKER_MODEL_KEYS: dict[str, str] = {
    "MANAGER_MODEL_ROUTE": "reason",
    "MANAGER_MODEL_ROUTE_MAX": "reason_max",
    "MANAGER_MODEL_PLAN": "route",
    "MANAGER_MODEL_SYNTH": "reason",
    "MANAGER_MODEL_CRITIC": "route",
    "MANAGER_MODEL_LOW_COST": "route",
    "QWEN_MODEL": "reason",
    "QWEN_PLANNER_MODEL": "route",
    "QWEN_EXECUTOR_MODEL": "reason",
}


def _extract_const(py_path: Path, name: str) -> Any:
    tree = ast.parse(py_path.read_text(encoding="utf-8"))
    for node in tree.body:
        value_node = None
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            value_node = node.value
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            value_node = node.value
            targets = [node.target]
        if value_node is None:
            continue
        for target in targets:
            if isinstance(target, ast.Name) and target.id == name:
                return eval(compile(ast.Expression(value_node), str(py_path), "eval"), {"__builtins__": {}})
    raise KeyError(f"{name} not found in {py_path}")


def _load_platform_bindings() -> tuple[dict[str, str], dict[str, dict[str, str]], dict[str, dict[str, Any]], dict[str, str]]:
    defaults = _extract_const(CAPABILITY_PY, "DEFAULT_CAPABILITY_MODELS")
    env_bindings = _extract_const(CAPABILITY_PY, "AGENT_CAPABILITY_ENV_BINDINGS")
    env_specs = _extract_const(REGISTRY_PY, "AGENT_ENV_SPECS")
    layers = _extract_const(CAPABILITY_PY, "CAPABILITY_LAYERS")
    cap_env_to_id = {str(layer["env"]): str(layer["id"]) for layer in layers}
    return defaults, env_bindings, env_specs, cap_env_to_id


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key:
            out[key] = val
    return out


def _load_ssot_models(
    ssot_path: Path,
    defaults: dict[str, str],
    cap_env_to_id: dict[str, str],
    cli_sets: dict[str, str],
) -> dict[str, str]:
    models = dict(defaults)
    env = _parse_env_file(ssot_path)

    for cap_env, cap_id in cap_env_to_id.items():
        val = str(env.get(cap_env) or "").strip()
        if val:
            models[cap_id] = val

    for cap_id, val in cli_sets.items():
        key = str(cap_id or "").strip()
        v = str(val or "").strip()
        if key in models and v:
            models[key] = v

    return models


def _resolve_env_models(agent_name: str, models: dict[str, str], bindings: dict[str, dict[str, str]]) -> dict[str, str]:
    agent_bindings = bindings.get(agent_name) or {}
    out: dict[str, str] = {}
    for env_key, cap_id in agent_bindings.items():
        val = str(models.get(cap_id) or "").strip()
        if val:
            out[env_key] = val
    return out


def _write_env_keys(
    path: Path,
    updates: dict[str, str],
    *,
    agent_name: str,
    dry_run: bool,
) -> dict[str, Any]:
    pending = dict(updates)
    lines: list[str] = []
    changed: dict[str, tuple[str, str]] = {}

    if path.is_file():
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                lines.append(raw)
                continue
            key_part = stripped.split("=", 1)[0].strip()
            key = key_part.lstrip("export ").strip()
            if key in pending:
                old_val = stripped.split("=", 1)[1].strip().strip('"').strip("'")
                new_val = pending.pop(key)
                if old_val != new_val:
                    changed[key] = (old_val, new_val)
                lines.append(f"{key}={new_val}")
            else:
                lines.append(raw)
    else:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines.append(f"# synced capability models — {agent_name} ({ts})")

    for key, val in pending.items():
        changed[key] = ("", val)
        lines.append(f"{key}={val}")

    if not dry_run and (changed or not path.is_file()):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {"changed": changed, "created": not path.is_file()}


def _sync_agents_lan_cap(
    models: dict[str, str],
    layers: list[dict[str, str]],
    *,
    dry_run: bool,
) -> dict[str, Any]:
    if not AGENTS_LAN_ENV.is_file():
        return {"skipped": True, "reason": "file missing"}

    cap_updates = {str(layer["env"]): str(models.get(str(layer["id"])) or "") for layer in layers}
    cap_updates = {k: v for k, v in cap_updates.items() if v}
    docker_updates = {
        env_key: str(models.get(cap_id) or "")
        for env_key, cap_id in AGENTS_LAN_DOCKER_MODEL_KEYS.items()
        if str(models.get(cap_id) or "").strip()
    }
    updates = {**cap_updates, **docker_updates}
    # 思考开关 SSOT 在 CAP_ENABLE_THINKING；须写入 agents-lan，避免仅靠 convergence 覆盖
    if SSOT_FILE.is_file():
        updates.update(_load_ssot_global_env(SSOT_FILE))
    result = _write_env_keys(AGENTS_LAN_ENV, updates, agent_name="agents-lan", dry_run=dry_run)
    return {"skipped": False, **result}


def _normalize_thinking_token(raw: str) -> str:
    v = str(raw or "").strip().lower()
    if v in ("0", "false", "off", "no", "disabled"):
        return "off"
    if v in ("1", "true", "on", "yes", "enabled"):
        return "on"
    return v or "off"


def _load_ssot_global_env(ssot_path: Path) -> dict[str, str]:
    raw = _parse_env_file(ssot_path)
    enable = _normalize_thinking_token(str(raw.get("CAP_ENABLE_THINKING") or "off"))
    return {"QWEN_ENABLE_THINKING": enable}


def _norm(v: str) -> str:
    return re.sub(r"\s+", "", str(v or "").strip().lower())


def _check_drift(
    agent_name: str,
    models: dict[str, str],
    bindings: dict[str, dict[str, str]],
    env_specs: dict[str, dict[str, Any]],
    workspace: Path,
) -> dict[str, Any]:
    spec = env_specs.get(agent_name)
    if not spec:
        return {"agent_name": agent_name, "status": "unregistered"}
    rel = str(spec.get("env_file") or "")
    path = workspace / Path(rel)
    env = _parse_env_file(path)
    expected = _resolve_env_models(agent_name, models, bindings)
    drift: list[dict[str, str]] = []
    for key, exp_val in expected.items():
        cur = str(env.get(key) or "").strip()
        if cur and _norm(cur) != _norm(exp_val):
            drift.append({"key": key, "current": cur, "expected": exp_val})
        elif not cur:
            drift.append({"key": key, "current": "(missing)", "expected": exp_val})
    return {
        "agent_name": agent_name,
        "env_file": rel,
        "exists": path.is_file(),
        "status": "drift" if drift else ("ok" if path.is_file() else "missing"),
        "drift": drift,
    }


def _parse_set_args(items: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"无效 --set 参数（需 layer=model）：{item}")
        layer, _, model = item.partition("=")
        layer = layer.strip()
        model = model.strip()
        if not layer or not model:
            raise ValueError(f"无效 --set 参数：{item}")
        out[layer] = model
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="同步能力层模型到各 Agent .env")
    parser.add_argument("--workspace", default=str(REPO_ROOT), help="仓库根目录（默认自动检测）")
    parser.add_argument("--ssot", default=str(SSOT_FILE), help="能力层 SSOT 文件路径")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不写文件")
    parser.add_argument("--check", action="store_true", help="检查漂移，不写文件")
    parser.add_argument("--set", action="append", default=[], metavar="LAYER=MODEL", help="覆盖能力层，如 route=qwen-flash-xxx")
    parser.add_argument("--agents", default="", help="逗号分隔的 Agent 名，默认全部")
    parser.add_argument("--write-ssot", action="store_true", help="将 --set 覆盖写回 SSOT 文件")
    parser.add_argument("--skip-agents-lan", action="store_true", help="不同步 .env.agents-lan")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    ssot_path = Path(args.ssot).resolve()
    if not ssot_path.is_file():
        if SSOT_EXAMPLE.is_file():
            print(f"[warn] SSOT 不存在：{ssot_path}")
            print(f"       使用示例文件：{SSOT_EXAMPLE}")
            ssot_path = SSOT_EXAMPLE
        else:
            print(f"[error] 找不到 SSOT：{ssot_path}", file=sys.stderr)
            return 1

    try:
        cli_sets = _parse_set_args(args.set)
    except ValueError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    defaults, env_bindings, env_specs, cap_env_to_id = _load_platform_bindings()
    layers = _extract_const(CAPABILITY_PY, "CAPABILITY_LAYERS")
    models = _load_ssot_models(ssot_path, defaults, cap_env_to_id, cli_sets)

    if args.write_ssot and cli_sets:
        target = Path(args.ssot).resolve()
        if not target.is_file() and SSOT_EXAMPLE.is_file():
            target.write_text(SSOT_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
        env_map = _parse_env_file(target)
        for cap_id, val in cli_sets.items():
            for cap_env, lid in cap_env_to_id.items():
                if lid == cap_id:
                    env_map[cap_env] = val
        lines = target.read_text(encoding="utf-8").splitlines() if target.is_file() else []
        pending = {k: v for k, v in env_map.items() if k.startswith("CAP_")}
        out_lines: list[str] = []
        seen: set[str] = set()
        for raw in lines:
            stripped = raw.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                if key in pending:
                    out_lines.append(f"{key}={pending[key]}")
                    seen.add(key)
                    continue
            out_lines.append(raw)
        for k, v in pending.items():
            if k not in seen:
                out_lines.append(f"{k}={v}")
        if not args.dry_run and not args.check:
            target.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
            print(f"[ssot] 已更新 {target}")

    agent_filter: set[str] | None = None
    if args.agents.strip():
        agent_filter = {a.strip() for a in args.agents.split(",") if a.strip()}

    print("── 能力层模型 ──")
    for layer in layers:
        lid = str(layer["id"])
        print(f"  {layer.get('label', lid):20} ({lid:12}) → {models.get(lid, '')}")
    print()

    if args.check:
        drift_count = 0
        for agent_name in sorted(env_bindings.keys()):
            if agent_filter and agent_name not in agent_filter:
                continue
            row = _check_drift(agent_name, models, env_bindings, env_specs, workspace)
            status = row["status"]
            rel = row.get("env_file", "")
            if status == "drift":
                drift_count += 1
                print(f"[drift] {agent_name} ({rel})")
                for d in row["drift"]:
                    print(f"        {d['key']}: {d['current']} → {d['expected']}")
            elif status == "missing":
                print(f"[missing] {agent_name} ({rel}) 文件不存在")
            elif status == "ok":
                print(f"[ok] {agent_name} ({rel})")
            else:
                print(f"[skip] {agent_name}: 未注册")
        print(f"\n检查完成：{drift_count} 个 Agent 存在漂移")
        return 1 if drift_count else 0

    mode = "dry-run" if args.dry_run else "sync"
    print(f"模式：{mode}  |  workspace：{workspace}\n")

    total_changed = 0
    for agent_name in sorted(env_bindings.keys()):
        if agent_filter and agent_name not in agent_filter:
            continue
        spec = env_specs.get(agent_name)
        if not spec:
            print(f"[skip] {agent_name}: 无 env 路径注册")
            continue
        rel = str(spec.get("env_file") or "")
        path = workspace / Path(rel)
        resolved = _resolve_env_models(agent_name, models, env_bindings)
        resolved = {**resolved, **_load_ssot_global_env(ssot_path)}
        if not resolved:
            print(f"[skip] {agent_name}: 无能力层绑定")
            continue

        result = _write_env_keys(path, resolved, agent_name=agent_name, dry_run=args.dry_run)
        changed = result["changed"]
        if not changed and path.is_file():
            print(f"[ok] {agent_name} ({rel}) — 已是最新")
            continue
        if result["created"]:
            print(f"[new] {agent_name} ({rel})")
        else:
            print(f"[update] {agent_name} ({rel})")
        for key, (old, new) in sorted(changed.items()):
            if old:
                print(f"         {key}: {old} → {new}")
            else:
                print(f"         {key}: (新增) {new}")
        total_changed += len(changed)

    if not args.skip_agents_lan:
        lan_result = _sync_agents_lan_cap(models, layers, dry_run=args.dry_run)
        if lan_result.get("skipped"):
            print(f"\n[skip] .env.agents-lan — {lan_result.get('reason')}")
        else:
            changed = lan_result.get("changed") or {}
            if changed:
                print(f"\n[update] .env.agents-lan")
                for key, (old, new) in sorted(changed.items()):
                    if old:
                        print(f"         {key}: {old} → {new}")
                    else:
                        print(f"         {key}: (新增) {new}")
                total_changed += len(changed)
            else:
                print(f"\n[ok] .env.agents-lan — 已是最新")

    not_in_bindings = []
    for child in sorted(workspace.iterdir()):
        if not child.is_dir() or not child.name.endswith("_Agent"):
            continue
        if child.name not in env_bindings and child.name != "Manage-platform_Agent":
            env_file = child / ".env"
            if env_file.is_file():
                not_in_bindings.append(child.name)

    if not_in_bindings:
        print(f"\n[info] 以下 Agent 有 .env 但未纳入能力层映射（需手动维护）：")
        for name in not_in_bindings:
            print(f"       - {name}")

    print(f"\n完成：{total_changed} 处模型键{'将被' if args.dry_run else '已'}更新")
    if args.dry_run:
        print("（dry-run 未写文件，去掉 --dry-run 执行同步）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
