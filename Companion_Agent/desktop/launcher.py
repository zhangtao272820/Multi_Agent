"""Windows desktop launcher: uvicorn + pywebview."""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path


def _prepare_env() -> tuple[int, Path]:
    desktop_dir = Path(__file__).resolve().parent
    project = desktop_dir.parent
    if not getattr(sys, "frozen", False):
        os.environ.setdefault("COMPANION_PROJECT_ROOT", str(project))
    os.environ["COMPANION_DESKTOP"] = "1"

    backend = project / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    if str(desktop_dir) not in sys.path:
        sys.path.insert(0, str(desktop_dir))
    if getattr(sys, "frozen", False):
        meipass = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        os.environ.setdefault("COMPANION_PROJECT_ROOT", str(meipass))
        for p in (meipass, meipass / "backend", Path(sys.executable).resolve().parent):
            if p.is_dir() and str(p) not in sys.path:
                sys.path.insert(0, str(p))

    try:
        from paths import ensure_user_env, frontend_dist
    except ImportError:
        # frozen: paths may live next to launcher in meipass
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from paths import ensure_user_env, frontend_dist

    env_file = ensure_user_env()
    if env_file and env_file.is_file():
        os.environ.setdefault("COMPANION_ENV_FILE", str(env_file))

    port = int(os.environ.get("COMPANION_PORT", "0") or "0")
    if port <= 0:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = int(s.getsockname()[1])
    os.environ["COMPANION_PORT"] = str(port)
    return port, frontend_dist()


def _run_server(port: int) -> None:
    import uvicorn

    # Import after env / path prep so config sees COMPANION_* 
    from app.main import app  # noqa: WPS433

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


def _wait_ready(port: int, timeout: float = 25.0) -> dict | None:
    import json
    import urllib.request

    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    raw = resp.read().decode("utf-8", errors="replace")
                    try:
                        return json.loads(raw)
                    except json.JSONDecodeError:
                        return {"ok": True}
        except Exception:
            time.sleep(0.2)
    return None


def main() -> int:
    try:
        return _main_inner()
    except Exception as exc:
        # Keep console visible on frozen builds so flash-exit still leaves a clue.
        print(f"[Companion] fatal: {exc}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        if getattr(sys, "frozen", False):
            try:
                input("按回车键退出…")
            except EOFError:
                time.sleep(8)
        return 1


def _main_inner() -> int:
    port, dist = _prepare_env()
    if not dist.is_dir():
        print(f"[Companion] frontend dist missing: {dist}", file=sys.stderr)
        print("Run: cd frontend && npm run build", file=sys.stderr)

    thread = threading.Thread(target=_run_server, args=(port,), daemon=True)
    thread.start()
    health = _wait_ready(port)
    if not health:
        print(f"[Companion] server failed to start on port {port}", file=sys.stderr)
        if getattr(sys, "frozen", False):
            try:
                input("按回车键退出…")
            except EOFError:
                time.sleep(8)
        return 1

    if health.get("has_key"):
        print("[Companion] 模型密钥已加载，可以对话。")
    else:
        local = os.environ.get("LOCALAPPDATA") or ""
        hint = (
            f"{local}\\CompanionAgent\\.env"
            if local
            else "%LOCALAPPDATA%\\CompanionAgent\\.env"
        )
        print(
            f"[Companion] 未检测到 DASHSCOPE_API_KEY。\n"
            f"  请编辑：{hint}\n"
            f"  填入 DASHSCOPE_API_KEY=你的密钥 后重启。无密钥仍可逛 Hub/地点。",
            file=sys.stderr,
        )

    import webview

    from api import DesktopApi

    url = f"http://127.0.0.1:{port}/"
    # 默认窗口化；COMPANION_FULLSCREEN=1 可强制全屏启动
    force_fs = os.environ.get("COMPANION_FULLSCREEN", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    api = DesktopApi()
    window = webview.create_window(
        "邂逅的少女",
        url,
        width=1280,
        height=720,
        min_size=(1024, 640),
        background_color="#0a0e14",
        fullscreen=force_fs,
        maximized=False,
        js_api=api,
    )
    api.bind(window)
    webview.start(debug=bool(os.environ.get("COMPANION_WEBVIEW_DEBUG")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
