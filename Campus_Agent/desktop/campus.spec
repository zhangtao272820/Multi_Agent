# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for Campus Agent desktop."""

from pathlib import Path

block_cipher = None
ROOT = Path(SPECPATH).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND_DIST = ROOT / "frontend" / "dist"
DATA = ROOT / "data"
DESKTOP = ROOT / "desktop"

datas = []
if FRONTEND_DIST.is_dir():
    datas.append((str(FRONTEND_DIST), "frontend/dist"))
if DATA.is_dir():
    # Skip raw cutout backups & scratch — keep package lean for playtest
    _SKIP_DATA_DIRS = {"sprites_raw", "_scratch", "_work"}
    for child in DATA.iterdir():
        if child.name.startswith("_"):
            continue
        if child.name in _SKIP_DATA_DIRS:
            continue
        if child.name == "campus_save.db":
            continue
        if child.is_dir():
            datas.append((str(child), f"data/{child.name}"))
        elif child.is_file():
            datas.append((str(child), "data"))
env_example = ROOT / ".env.example"
if env_example.is_file():
    datas.append((str(env_example), "."))
env_file = ROOT / ".env"
if env_file.is_file():
    datas.append((str(env_file), "."))

hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "multipart",
    "webview",
    "app",
    "app.main",
    "app.campus_engine",
    "app.npc_social",
    "app.npc_minds",
    "app.relationship",
    "app.endings",
    "app.llm_chat",
    "api",
    "paths",
]

excludes = [
    "torch",
    "torchvision",
    "torchaudio",
    "tensorflow",
    "keras",
    "sklearn",
    "scikit-learn",
    "matplotlib",
    "scipy",
    "pandas",
    "cv2",
    "numba",
    "llvmlite",
    "IPython",
    "notebook",
    "jupyter",
    "pytest",
    "sympy",
    "transformers",
]

a = Analysis(
    [str(DESKTOP / "launcher.py")],
    pathex=[str(BACKEND), str(DESKTOP), str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CampusAgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="CampusAgent",
)
