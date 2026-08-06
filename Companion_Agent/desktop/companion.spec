# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for Companion Agent desktop."""

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
# Bundle catalogs + formal sprites only.
# Sprite whitelist: romance / neutral / _background (decorative).
# Skip workspaces: _staging _quarantine _pools _archive _normalized and stray nested dirs.
_SPRITE_POOLS = frozenset({"romance", "neutral", "_background"})
if DATA.is_dir():
    for child in DATA.iterdir():
        if child.name == "sprites" and child.is_dir():
            for pool in child.iterdir():
                if pool.is_file():
                    datas.append((str(pool), "data/sprites"))
                elif pool.is_dir() and pool.name in _SPRITE_POOLS:
                    datas.append((str(pool), f"data/sprites/{pool.name}"))
        elif child.is_dir():
            datas.append((str(child), f"data/{child.name}"))
        elif child.is_file():
            datas.append((str(child), "data"))
# Keep a copy of .env.example for first-run hint (optional)
env_example = ROOT / ".env.example"
if env_example.is_file():
    datas.append((str(env_example), "."))
# Seed model key into bundle for take-home (user copy still preferred via LOCALAPPDATA)
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
    "yaml",
    "pydantic_settings",
    "app",
    "app.main",
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
    "numpy.tests",
    "cv2",
    "numba",
    "llvmlite",
    "IPython",
    "notebook",
    "jupyter",
    "pytest",
    "sympy",
    "PIL.ImageQt",
    "transformers",
    "accelerate",
    "librosa",
    "huggingface_hub",
    "tokenizers",
    "safetensors",
    "datasets",
    "gradio",
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

# UPX off: on Windows it often corrupts / strips python3xx.dll and extension
# modules, which shows up as instant exe flash-exit (Failed to load Python DLL).
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="CompanionAgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
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
    upx=False,
    upx_exclude=[],
    name="CompanionAgent",
)
